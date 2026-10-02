// SPDX-License-Identifier: GPL-3.0-or-later
// Clipboard tab (docs/features/clipboard.md): the history, newest first.
// Each entry is a small row (a few lines of text, a thumbnail, or the
// files' names) with a wider preview while hovered; a click puts it back
// on the clipboard, ready to be pasted. Rows are rebuilt only while the
// tab is on screen.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {gettext as _, ngettext} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Tooltip} from '../../core/tooltip.js';
import {excerpt, uriName, uriPath} from './entries.js';

// Small preview in the row; the wider one in the hover bubble.
const ROW_LINES = 3;
const ROW_WIDTH = 60;
const BUBBLE_LINES = 12;
const BUBBLE_WIDTH = 80;
const BUBBLE_FILES = 10;
// Thumbnails are this tall, in proportion, and at most as wide as the CSS allows.
const THUMBNAIL_HEIGHT = 56;

// A hidden password's preview: the same dots whatever its length.
const HIDDEN = '••••••••';

function kindIcon(entry) {
    if (entry.kind === 'password')
        return 'dialog-password-symbolic';
    if (entry.kind === 'image')
        return 'image-x-generic-symbolic';
    if (entry.kind === 'files')
        return entry.operation === 'cut' ? 'edit-cut-symbolic' : 'folder-symbolic';
    return 'text-x-generic-symbolic';
}

function filesHeading(entry) {
    const count = entry.uris.length;
    return (entry.operation === 'cut'
        ? ngettext('Cut %d item', 'Cut %d items', count)
        : ngettext('Copied %d item', 'Copied %d items', count)).format(count);
}

function filesPreview(entry, max) {
    const names = entry.uris.slice(0, max).map(uriName);
    const more = entry.uris.length - names.length;
    return more > 0 ? [...names, _('and %d more').format(more)].join('\n') : names.join('\n');
}

export class ClipboardView {
    constructor(ctx, recorder) {
        this._recorder = recorder;
        this._clock = ctx.clock;
        this._active = false;
        this._dirty = true;

        // Content, plus an overlay layer (fixed positions, click-through)
        // for the hover bubble.
        this.actor = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });
        const content = new St.BoxLayout({
            style_class: 'froonty-clipboard',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
        });

        const header = new St.BoxLayout({style_class: 'froonty-clipboard-header'});
        this._status = new St.Label({
            style_class: 'froonty-clipboard-status',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        header.add_child(this._status);
        this._clearButton = new St.Button({
            style_class: 'froonty-icon-button',
            accessible_name: _('Clear clipboard history'),
            can_focus: true,
            track_hover: true,
            child: new St.Icon({icon_name: 'edit-clear-all-symbolic'}),
        });
        this._clearButton.connect('clicked', () => this._recorder.clear());
        header.add_child(this._clearButton);
        content.add_child(header);

        this._empty = new St.Label({
            style_class: 'froonty-clipboard-empty',
            text: _('Nothing copied yet. Text, images and files you copy or cut show up here; click one to copy it again.'),
            x_expand: true,
        });
        this._empty.clutter_text.line_wrap = true;
        content.add_child(this._empty);

        this._list = new St.BoxLayout({
            style_class: 'froonty-clipboard-list',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._scroll = new St.ScrollView({
            style_class: 'froonty-clipboard-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true,
        });
        this._scroll.add_child(this._list);
        content.add_child(this._scroll);
        this.actor.add_child(content);

        this._tooltip = new Tooltip();
        const overlay = new St.Widget({x_expand: true, y_expand: true});
        overlay.add_child(this._tooltip.actor);
        this.actor.add_child(overlay);

        this._recorderId = this._recorder.connect('changed', () => this._onChanged());
        this._sync();
    }

    destroy() {
        this._recorder.disconnect(this._recorderId);
        this.actor.destroy();
    }

    setActive(active) {
        this._active = active;
        if (!active)
            this._tooltip.hide();
        else if (this._dirty)
            this._sync();
    }

    _onChanged() {
        this._dirty = true;
        if (this._active)
            this._sync();
    }

    _sync() {
        this._dirty = false;
        this._tooltip.hide();
        const {shown: entries, loaded, currentId, lastSkip} = this._recorder;

        if (!loaded)
            this._status.text = _('Reading the history…');
        else if (!currentId && ['secret', 'ignored-app', 'looks'].includes(lastSkip))
            this._status.text = _('The last copy was a password: not kept');
        else
            this._status.text = entries.length ? _('Click an entry to copy it again') : '';
        this._clearButton.visible = entries.length > 0;
        this._empty.visible = loaded && entries.length === 0;
        this._scroll.visible = entries.length > 0;

        this._list.destroy_all_children();
        for (const entry of entries)
            this._list.add_child(this._row(entry, entry.id === currentId));
    }

    _row(entry, current) {
        const row = new St.BoxLayout({
            style_class: current ? 'froonty-clipboard-row froonty-clipboard-row-current'
                : 'froonty-clipboard-row',
        });

        const body = new St.BoxLayout({
            style_class: 'froonty-clipboard-body',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        body.add_child(this._preview(entry));
        body.add_child(new St.Label({
            style_class: 'froonty-clipboard-meta',
            text: this._meta(entry, current),
        }));

        // St.Button centres its child; the entry fills the row instead.
        const inner = new St.BoxLayout({
            style_class: 'froonty-clipboard-entry-content',
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
        });
        inner.add_child(new St.Icon({
            style_class: 'froonty-clipboard-kind',
            icon_name: kindIcon(entry),
            y_align: Clutter.ActorAlign.START,
        }));
        inner.add_child(body);

        const button = new St.Button({
            style_class: 'froonty-clipboard-entry',
            x_align: Clutter.ActorAlign.FILL,
            accessible_name: entry.kind === 'password' ? _('Copy the hidden password again')
                : _('Copy again: %s').format(this._summary(entry)),
            can_focus: true,
            track_hover: true,
            x_expand: true,
            child: inner,
        });
        button.connect('clicked', () => this._recorder.copy(entry.id));
        this._tooltip.attach(button, () => this._bubble(entry), 'below');
        row.add_child(button);

        const remove = new St.Button({
            style_class: 'froonty-icon-button froonty-clipboard-remove',
            accessible_name: _('Remove from history'),
            can_focus: true,
            track_hover: true,
            y_align: Clutter.ActorAlign.START,
            child: new St.Icon({icon_name: 'user-trash-symbolic'}),
        });
        remove.connect('clicked', () => this._recorder.remove(entry.id));
        row.add_child(remove);
        return row;
    }

    _preview(entry) {
        if (entry.kind === 'image') {
            // GNOME's texture cache loads it in the background, scaled to
            // fit and kept in proportion, as the Shell's own thumbnails.
            const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
            const picture = St.TextureCache.get_default().load_file_async(
                this._recorder.imageFile(entry), -1, THUMBNAIL_HEIGHT, scale, 1);
            picture.set({
                x_align: Clutter.ActorAlign.START,
                content_gravity: Clutter.ContentGravity.RESIZE_ASPECT,
            });
            // A very wide picture (a screenshot strip) stays inside the row.
            const box = new St.Bin({
                style_class: 'froonty-clipboard-thumbnail',
                x_align: Clutter.ActorAlign.START,
                child: picture,
            });
            return box;
        }
        if (entry.kind === 'password')
            return new St.Label({style_class: 'froonty-clipboard-preview froonty-clipboard-hidden', text: HIDDEN});
        const text = entry.kind === 'files'
            ? `${filesHeading(entry)}\n${filesPreview(entry, ROW_LINES - 1)}`
            : excerpt(entry.text, ROW_LINES, ROW_WIDTH);
        return new St.Label({style_class: 'froonty-clipboard-preview', text});
    }

    _meta(entry, current = false) {
        if (entry.kind === 'password') {
            const until = this._clock.formatTime(entry.expiresAt);
            return current ? _('On the clipboard · hidden until %s').format(until)
                : _('Password, hidden until %s').format(until);
        }
        if (current)
            return _('On the clipboard, ready to paste');
        const today = GLib.DateTime.new_now_local().format('%F');
        const day = GLib.DateTime.new_from_unix_local(Math.floor(entry.time / 1000)).format('%F');
        const time = this._clock.formatTime(entry.time, {weekday: day !== today});
        if (entry.kind === 'image')
            return `${time} · ${GLib.format_size(entry.size ?? 0)}`;
        if (entry.kind === 'text')
            return `${time} · ${_('%d characters').format(entry.text.length)}`;
        return time;
    }

    _summary(entry) {
        if (entry.kind === 'password')
            return _('password');
        if (entry.kind === 'image')
            return _('image');
        if (entry.kind === 'files')
            return filesHeading(entry);
        return excerpt(entry.text, 1, 40);
    }

    // The wider preview: more of the text, or every file's full path. Never
    // a password.
    _bubble(entry) {
        if (entry.kind === 'password') {
            return _('A password, never saved. It disappears at %s, when the clipboard is cleared or something else is copied, whichever comes first.')
                .format(this._clock.formatTime(entry.expiresAt));
        }
        if (entry.kind === 'image')
            return `${_('Image')} · ${entry.mime} · ${GLib.format_size(entry.size ?? 0)}`;
        if (entry.kind === 'files') {
            const paths = entry.uris.slice(0, BUBBLE_FILES).map(uriPath);
            const more = entry.uris.length - paths.length;
            return [filesHeading(entry), ...paths,
                ...more > 0 ? [_('and %d more').format(more)] : []].join('\n');
        }
        return excerpt(entry.text, BUBBLE_LINES, BUBBLE_WIDTH);
    }
}
