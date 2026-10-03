// SPDX-License-Identifier: GPL-3.0-or-later
// The Claude attention bar: a slim strip under the collapsed pill while a
// Claude session waits for the user (docs/features/claude-attention.md §7).
//
//   bar     St.BoxLayout (the Ctrl+Alt+Tab group's root)
//    ├ main  St.Button: [Spark] "Claude needs your permission" place  +2
//    └ close St.Button ×
//
// It only shows what it is given (Island._syncAttention); a click asks
// the service to go there, × to drop it. Nothing runs per frame: the fade
// is one ease().

import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {gettext as _, ngettext} from 'resource:///org/gnome/shell/extensions/extension.js';

import {placeText} from '../features/claude/attention.js';
import {sparkIcon} from '../features/claude/icon.js';

const FADE_MS = 150;

function kindText(kind) {
    switch (kind) {
    case 'permission':
        return _('Claude needs your permission');
    case 'input':
        return _('Claude needs your input');
    case 'error':
        return _('Claude stopped with an error');
    case 'waiting':
        return _('Claude is waiting for your input');
    case 'finished':
        return _('Claude finished');
    default:
        return _('Claude needs your attention');
    }
}

export class AttentionBar {
    /**
     * @param {object} params
     * @param {Function} params.onActivate (id) a click on the bar
     * @param {Function} params.onDismiss (id) ×, Delete or BackSpace
     * @param {Function} params.animationTime () → the island's animation ms
     */
    constructor({onActivate, onDismiss, animationTime}) {
        this._onActivate = onActivate;
        this._onDismiss = onDismiss;
        this._animationTime = animationTime;
        this._id = null;

        this.actor = new St.BoxLayout({
            style_class: 'froonty-attention',
            x_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });

        this._main = new St.Button({
            style_class: 'froonty-attention-main',
            can_focus: true,
            track_hover: true,
            x_expand: true,
            accessible_role: Atk.Role.NOTIFICATION,
        });
        const row = new St.BoxLayout({style_class: 'froonty-attention-row'});
        this._main.set_child(row);
        row.add_child(new St.Icon({
            style_class: 'froonty-attention-icon',
            gicon: sparkIcon(),
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this._text = this._label(row, 'froonty-attention-text');
        // Fixed, short strings: never cut. The place gives way first.
        this._text.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._place = this._label(row, 'froonty-attention-place');
        this._place.x_expand = true;
        this._more = this._label(row, 'froonty-attention-more');
        this.actor.add_child(this._main);

        this._close = new St.Button({
            style_class: 'froonty-attention-close',
            can_focus: true,
            track_hover: true,
            accessible_name: _('Dismiss'),
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({icon_name: 'window-close-symbolic'}),
        });
        this.actor.add_child(this._close);

        this._main.connect('clicked', () => this._id && this._onActivate(this._id));
        this._close.connect('clicked', () => this._id && this._onDismiss(this._id));
        // Key events reach reactive actors only, so the buttons take them.
        for (const button of [this._main, this._close])
            button.connect('key-press-event', (_actor, event) => this._onKey(event));

        // Listed by Ctrl+Alt+Tab only while mapped, i.e. while it shows.
        Main.ctrlAltTabManager.addGroup(this.actor, _('Claude needs you'), 'dialog-information-symbolic');
    }

    destroy() {
        Main.ctrlAltTabManager.removeGroup(this.actor);
        this.actor.destroy();
        this.actor = null;
    }

    /** The id of the entry shown, or null. */
    get shownId() {
        return this.actor?.visible ? this._id : null;
    }

    /**
     * @param {object} entry the first AttentionService entry
     * @param {number} more how many others wait
     */
    show(entry, more) {
        this._id = entry.id;
        const text = kindText(entry.kind);
        const place = placeText(entry);
        this._text.text = text;
        this._place.text = place;
        this._place.visible = place !== '';
        this._more.text = more > 0 ? `+${more}` : '';
        this._more.visible = more > 0;
        this._main.accessible_name = [text, place,
            more > 0 ? ngettext('%d more', '%d more', more).format(more) : '']
            .filter(Boolean).join(', ');

        if (this.actor.visible && !this.actor.get_transition('opacity'))
            return;
        this.actor.remove_all_transitions();
        if (!this.actor.visible)
            this.actor.opacity = 0;
        this.actor.show();
        this.actor.ease({
            opacity: 255,
            duration: Math.min(FADE_MS, this._animationTime()),
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    hide({animate = false} = {}) {
        if (!this.actor.visible)
            return;
        // Never leave the keyboard focus on a hidden actor.
        this._leaveFocus(global.get_current_time());
        this.actor.remove_all_transitions();
        if (!animate) {
            this.actor.hide();
            return;
        }
        this.actor.ease({
            opacity: 0,
            duration: Math.min(FADE_MS, this._animationTime()),
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => this.actor?.hide(),
        });
    }

    _label(box, styleClass) {
        const label = new St.Label({style_class: styleClass, y_align: Clutter.ActorAlign.CENTER});
        label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        label.clutter_text.line_wrap = false;
        box.add_child(label);
        return label;
    }

    // Back to the windows, as Escape on GNOME's top bar does; with no
    // window to focus, the bar lets go of the keyboard focus anyway.
    _leaveFocus(time) {
        if (!this._hasFocus())
            return;
        global.display.focus_default_window(time);
        if (this._hasFocus())
            global.stage.set_key_focus(null);
    }

    _hasFocus() {
        const focus = global.stage.key_focus;
        return focus !== null && this.actor.contains(focus);
    }

    _onKey(event) {
        switch (event.get_key_symbol()) {
        case Clutter.KEY_Escape:
            this._leaveFocus(event.get_time());
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Delete:
        case Clutter.KEY_KP_Delete:
        case Clutter.KEY_BackSpace:
            if (this._id)
                this._onDismiss(this._id);
            return Clutter.EVENT_STOP;
        default:
            return Clutter.EVENT_PROPAGATE;
        }
    }
}
