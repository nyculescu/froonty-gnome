// SPDX-License-Identifier: GPL-3.0-or-later
// The clipboard switcher's pop-up (docs/features/clipboard.md, "Switcher"):
// one history entry at a time, by the text cursor, driven like Alt+Tab
// (ui/switcherPopup.js, GNOME Shell 50.1). It holds a modal grab from the
// first press of the shortcut until the shortcut's modifier is released
// (choose), Escape (cancel), a click on it (choose) or outside it (cancel).
// While it holds the grab, GNOME's keybindings are off, so each press of
// the shortcut's key reaches it: older; with Shift, newer.
//
// Shown only after POPUP_DELAY_MS, as Alt+Tab: a quick press and release
// inserts the newest entry without a flash. An empty history shows its note
// at once, and it goes on release.
//
// done(entry) is called once: the chosen entry, or null.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {gettext as _, ngettext} from 'resource:///org/gnome/shell/extensions/extension.js';

import {excerpt, uriName} from './entries.js';
import {popupPlacement, stepIndex} from './switching.js';

// As Alt+Tab's (POPUP_DELAY_TIMEOUT, POPUP_FADE_OUT_TIME).
const POPUP_DELAY_MS = 150;
const FADE_OUT_MS = 100;
const TEXT_LINES = 5;
const TEXT_WIDTH = 46;
const FILE_NAMES = 4;
const THUMBNAIL_HEIGHT = 120;
// The pop-up's width in logical pixels (CSS .froonty-clipboard-switcher).
const WIDTH = 360;
// A hidden password's preview, as in the tab: the same dots whatever its length.
const HIDDEN = '••••••••';

// The highest bit of a binding's mask: the modifier whose release ends it
// (as Alt+Tab's primaryModifier()).
function primaryModifier(mask) {
    let primary = 0;
    for (let bit = 1; bit > 0 && bit <= mask; bit <<= 1) {
        if (mask & bit)
            primary = bit;
    }
    return primary;
}

function kindIcon(entry) {
    if (entry.kind === 'password')
        return 'dialog-password-symbolic';
    if (entry.kind === 'image')
        return 'image-x-generic-symbolic';
    if (entry.kind === 'files')
        return entry.operation === 'cut' ? 'edit-cut-symbolic' : 'folder-symbolic';
    return 'text-x-generic-symbolic';
}

function kindLabel(entry) {
    if (entry.kind === 'password')
        return _('Password, hidden');
    if (entry.kind === 'image')
        return `${_('Image')} · ${GLib.format_size(entry.size ?? 0)}`;
    if (entry.kind === 'files') {
        const count = entry.uris.length;
        return (entry.operation === 'cut'
            ? ngettext('Cut %d item', 'Cut %d items', count)
            : ngettext('Copied %d item', 'Copied %d items', count)).format(count);
    }
    return ngettext('%d character', '%d characters', entry.text.length).format(entry.text.length);
}

export class SwitcherPopup {
    /**
     * @param {object} options
     * @param {object[]} options.entries newest first (the recorder's `shown`)
     * @param {Function} options.imageFile entry → Gio.File of its picture
     * @param {number} options.action the shortcut's keybinding action
     * @param {{rect: object, centre: boolean}} options.anchor where it goes, in stage pixels
     * @param {Function} options.done entry or null, called once
     */
    constructor({entries, imageFile, action, anchor, done}) {
        this._entries = entries;
        this._imageFile = imageFile;
        this._action = action;
        this._anchor = anchor;
        this._done = done;
        this._index = 0;
        this._grab = null;
        this._mask = 0;
        this._delayId = 0;
        this._finished = false;
        this._gone = false;

        // Full-stage and reactive while it holds the grab, so a click
        // outside the card is seen (and cancels).
        this.actor = new St.Widget({reactive: true, opacity: 0});
        this.actor.add_constraint(new Clutter.BindConstraint({
            source: global.stage,
            coordinate: Clutter.BindCoordinate.ALL,
        }));
        this._card = new St.BoxLayout({
            style_class: 'froonty-clipboard-switcher',
            orientation: Clutter.Orientation.VERTICAL,
            reactive: true,
        });
        this.actor.add_child(this._card);
        this.actor.connect('destroy', () => {
            this._gone = true;
        });

        this.actor.connect('key-press-event', (_actor, event) => this._onKeyPress(event));
        this.actor.connect('key-release-event', () => this._onKeyRelease());
        this.actor.connect('button-press-event', (_actor, event) => {
            if (!this._card.contains(global.stage.get_event_actor(event)))
                this._finish(false);
            return Clutter.EVENT_STOP;
        });
        this._card.connect('button-release-event', () => {
            this._finish(true);
            return Clutter.EVENT_STOP;
        });
        this.actor.connect('scroll-event', (_actor, event) => {
            const direction = event.get_scroll_direction();
            if (direction === Clutter.ScrollDirection.UP || direction === Clutter.ScrollDirection.DOWN)
                this._step(direction === Clutter.ScrollDirection.UP);
            return Clutter.EVENT_STOP;
        });
        Main.layoutManager.connectObject('system-modal-opened', () => this._finish(false), this);
        Main.uiGroup.add_child(this.actor);
    }

    /** Whether it is done (and maybe still fading out). */
    get finished() {
        return this._finished;
    }

    /** The entry shown now, or null (empty history). */
    get current() {
        return this._entries[this._index] ?? null;
    }

    /** "2 / 14" while shown. */
    get position() {
        return this._entries.length ? `${this._index + 1} / ${this._entries.length}` : '';
    }

    /**
     * Takes the grab. `mask` is the binding's modifiers: their release
     * chooses.
     */
    open(mask) {
        this._grab = Main.pushModal(this.actor);
        this._mask = primaryModifier(mask);
        this._render();

        // The modifier may have been released before the grab was taken
        // (Alt+Tab's "race" comment): then it is a quick press and release.
        if (this._mask && !(global.get_pointer()[2] & this._mask)) {
            this._finish(true);
            return;
        }
        if (this._entries.length === 0)
            this._showNow();
        else
            this._delayId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POPUP_DELAY_MS, () => {
                this._delayId = 0;
                this._showNow();
                return GLib.SOURCE_REMOVE;
            });
    }

    /** Gone at once, without calling done (the extension is disabled). */
    destroy() {
        this._finished = true;
        this._clear();
        if (!this._gone)
            this.actor.destroy();
    }

    _showNow() {
        if (this._delayId)
            GLib.source_remove(this._delayId);
        this._delayId = 0;
        this.actor.opacity = 255;
    }

    _onKeyPress(event) {
        const keysym = event.get_key_symbol();
        const state = event.get_state();
        const code = event.get_key_code();
        const action = global.display.get_keybinding_action(code, state);
        if (action === this._action) {
            this._step(false);
        } else if ((state & Clutter.ModifierType.SHIFT_MASK) &&
            global.display.get_keybinding_action(code, state & ~Clutter.ModifierType.SHIFT_MASK) === this._action) {
            this._step(true);
        } else if (keysym === Clutter.KEY_Escape) {
            this._finish(false);
        } else if ([Clutter.KEY_Return, Clutter.KEY_KP_Enter, Clutter.KEY_ISO_Enter, Clutter.KEY_space]
            .includes(keysym)) {
            this._finish(true);
        } else if (keysym === Clutter.KEY_Down || keysym === Clutter.KEY_Right) {
            this._step(false);
        } else if (keysym === Clutter.KEY_Up || keysym === Clutter.KEY_Left) {
            this._step(true);
        }
        return Clutter.EVENT_STOP;
    }

    _onKeyRelease() {
        if (this._mask && !(global.get_pointer()[2] & this._mask))
            this._finish(true);
        return Clutter.EVENT_STOP;
    }

    // Older, or (`backward`) newer; a step shows the pop-up at once.
    _step(backward) {
        if (this._finished)
            return;
        if (this._entries.length) {
            this._index = stepIndex(this._index, this._entries.length, backward);
            this._render();
        }
        this._showNow();
    }

    _finish(choose) {
        if (this._finished)
            return;
        this._finished = true;
        const entry = choose ? this.current : null;
        this._clear();
        if (this.actor.opacity > 0) {
            this.actor.reactive = false;
            this.actor.ease({
                opacity: 0,
                duration: FADE_OUT_MS,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onStopped: () => {
                    if (!this._gone)
                        this.actor.destroy();
                },
            });
        } else {
            this.actor.destroy();
        }
        this._done(entry);
    }

    // The grab, the delay and the signal go; the actor stays for its fade.
    _clear() {
        if (this._delayId)
            GLib.source_remove(this._delayId);
        this._delayId = 0;
        Main.layoutManager.disconnectObject(this);
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
    }

    _render() {
        this._card.destroy_all_children();
        const entry = this.current;
        if (!entry) {
            this._card.add_child(new St.Label({
                style_class: 'froonty-clipboard-switcher-empty',
                text: _('Clipboard is empty'),
            }));
        } else {
            const header = new St.BoxLayout({style_class: 'froonty-clipboard-switcher-header'});
            header.add_child(new St.Icon({
                style_class: 'froonty-clipboard-switcher-kind',
                icon_name: kindIcon(entry),
            }));
            header.add_child(new St.Label({
                style_class: 'froonty-clipboard-switcher-meta',
                text: kindLabel(entry),
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            }));
            header.add_child(new St.Label({
                style_class: 'froonty-clipboard-switcher-position',
                text: this.position,
                y_align: Clutter.ActorAlign.CENTER,
            }));
            this._card.add_child(header);
            this._card.add_child(this._preview(entry));
            this._card.add_child(new St.Label({
                style_class: 'froonty-clipboard-switcher-hint',
                text: _('Again: older · with Shift: newer · release to insert · Esc: cancel'),
            }));
        }
        this._place();
    }

    _preview(entry) {
        if (entry.kind === 'image') {
            const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
            const picture = St.TextureCache.get_default().load_file_async(
                this._imageFile(entry), -1, THUMBNAIL_HEIGHT, scale, 1);
            picture.set({
                x_align: Clutter.ActorAlign.START,
                content_gravity: Clutter.ContentGravity.RESIZE_ASPECT,
            });
            return new St.Bin({
                style_class: 'froonty-clipboard-switcher-thumbnail',
                x_align: Clutter.ActorAlign.START,
                child: picture,
            });
        }
        let text;
        if (entry.kind === 'password') {
            text = HIDDEN;
        } else if (entry.kind === 'files') {
            const names = entry.uris.slice(0, FILE_NAMES).map(uriName);
            const more = entry.uris.length - names.length;
            text = more > 0 ? [...names, _('and %d more').format(more)].join('\n') : names.join('\n');
        } else {
            text = excerpt(entry.text, TEXT_LINES, TEXT_WIDTH);
        }
        return new St.Label({
            style_class: entry.kind === 'password'
                ? 'froonty-clipboard-switcher-preview froonty-clipboard-hidden'
                : 'froonty-clipboard-switcher-preview',
            text,
        });
    }

    // Below the text cursor, or above it without room below; on screen.
    _place() {
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const width = WIDTH * scale;
        const [, height] = this._card.get_preferred_height(width);
        const {rect, centre} = this._anchor;
        const monitor = monitorAt(rect);
        const {x, y} = popupPlacement(rect, {width, height}, monitor,
            {gap: 6 * scale, margin: 8 * scale, centre});
        this._card.set_position(x, y);
    }
}

function monitorAt(rect) {
    const x = rect.x + rect.width / 2;
    const y = rect.y + rect.height / 2;
    return Main.layoutManager.monitors.find(m =>
        x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height) ??
        Main.layoutManager.primaryMonitor;
}
