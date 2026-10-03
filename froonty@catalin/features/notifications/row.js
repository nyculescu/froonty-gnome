// SPDX-License-Identifier: GPL-3.0-or-later
// One row of the Notifications tab (docs/features/notifications.md):
//
//   ┌ main (a button) ─────────────────────────────┐ [×]
//   │ [app] App name · 10 minutes ago            • │
//   │ [icon] Title (one line)                      │
//   │        Body, wrapped, at most three lines…   │
//   └──────────────────────────────────────────────┘
//   [ Action 1 ] [ Action 2 ] [ Action 3 ]   (only when it has actions)
//
// No button sits inside another. A row shows a plain description
// (NotificationStore.describe) and never reads GNOME's notification
// itself; `key` only identifies it to the view. Its parts are found by
// name, so it keeps no references of its own to release.

import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {bubbleText} from './text.js';

/** The body shows at most this many lines (GNOME's list shows one, or six expanded). */
export const BODY_LINES = 3;

/**
 * Caps its child's height at `lines` lines, as GNOME's LabelExpanderLayout
 * does when expanded: the wrapped height, but at most `lines` times the
 * height of one line. The child fills the whole box (left-aligned, and as
 * tall as the cap), so a label given less than it needs ellipsizes its
 * last line. It fills it without x/y_expand, which would spread up to the
 * row and stretch it.
 */
export const LineCapLayout = GObject.registerClass(
class LineCapLayout extends Clutter.BinLayout {
    _init(lines) {
        super._init();
        this._lines = lines;
    }

    vfunc_get_preferred_height(container, forWidth) {
        const child = container.get_first_child();
        if (!child)
            return [0, 0];
        const [, oneLine] = child.get_preferred_height(-1);
        const [, wrapped] = child.get_preferred_height(forWidth);
        const height = Math.min(wrapped, oneLine * this._lines);
        return [height, height];
    }

    vfunc_allocate(container, box) {
        container.get_first_child()?.allocate(box);
    }
});

const sameIcon = (a, b) => a === b || (!!a && !!b && a.equal(b));

export const NotificationRow = GObject.registerClass(
class NotificationRow extends St.BoxLayout {
    /**
     * @param {object} key the notification, as the view's service lists it
     * @param {object} actions activate(row), action(row, index), dismiss(row)
     * @param {object} format plainText(text, useMarkup), timeAgo(datetime),
     *   when(datetime) (the hover bubble's time)
     * @param {Tooltip} tooltip the view's hover bubble
     */
    _init(key, actions, format, tooltip) {
        super._init({
            style_class: 'froonty-notifications-row',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this.key = key;
        this._actions = actions;
        this._format = format;
        this._desc = null;

        const top = new St.BoxLayout({x_expand: true});
        this.add_child(top);

        const meta = new St.BoxLayout({style_class: 'froonty-notifications-meta', x_expand: true});
        meta.add_child(new St.Icon({
            name: 'app-icon',
            style_class: 'froonty-notifications-app-icon',
            fallback_icon_name: 'application-x-executable-symbolic',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        meta.add_child(new St.Label({
            name: 'app',
            style_class: 'froonty-notifications-app',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        meta.add_child(new St.Label({
            name: 'age',
            style_class: 'froonty-notifications-age',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        meta.add_child(new St.Widget({
            name: 'new',
            style_class: 'froonty-unread-dot',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        }));

        const title = new St.Label({name: 'title', style_class: 'froonty-notifications-title'});
        title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        const body = new St.Label({name: 'body', style_class: 'froonty-notifications-body'});
        body.clutter_text.set({
            line_wrap: true,
            line_wrap_mode: Pango.WrapMode.WORD_CHAR,
            ellipsize: Pango.EllipsizeMode.END,
        });
        const bodyBin = new St.Widget({
            name: 'body-bin',
            x_expand: true,
            layout_manager: new LineCapLayout(BODY_LINES),
        });
        bodyBin.add_child(body);
        const text = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        text.add_child(title);
        text.add_child(bodyBin);

        const mainRow = new St.BoxLayout({style_class: 'froonty-notifications-main', x_expand: true});
        mainRow.add_child(new St.Icon({
            name: 'icon',
            style_class: 'froonty-notifications-icon',
            y_align: Clutter.ActorAlign.START,
            visible: false,
        }));
        mainRow.add_child(text);

        const content = new St.BoxLayout({
            style_class: 'froonty-notifications-content',
            orientation: Clutter.Orientation.VERTICAL,
            // St.Button centres its child; the content fills the row instead.
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
        });
        content.add_child(meta);
        content.add_child(mainRow);

        const main = new St.Button({
            name: 'main',
            style_class: 'froonty-notifications-entry',
            accessible_role: Atk.Role.NOTIFICATION,
            can_focus: true,
            track_hover: true,
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            child: content,
        });
        main.connect('clicked', () => this._actions.activate(this));
        // As in GNOME's list: Delete, KP_Delete or BackSpace dismiss it.
        // Only a press, not the keyboard's repeats while the key is held:
        // the focus moves to the next row at once, and each repeat would
        // dismiss one more.
        main.connect('key-press-event', (_actor, event) => {
            const key = event.get_key_symbol();
            if (key === Clutter.KEY_Delete || key === Clutter.KEY_KP_Delete ||
                key === Clutter.KEY_BackSpace) {
                if (!(event.get_flags() & Clutter.EventFlags.FLAG_REPEATED))
                    this._actions.dismiss(this);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        tooltip.attach(main, () => this._bubble(), 'below');
        top.add_child(main);

        const dismiss = new St.Button({
            name: 'dismiss',
            style_class: 'froonty-icon-button froonty-notifications-dismiss',
            accessible_name: _('Dismiss'),
            can_focus: true,
            track_hover: true,
            y_align: Clutter.ActorAlign.START,
            child: new St.Icon({icon_name: 'window-close-symbolic'}),
        });
        dismiss.connect('clicked', () => this._actions.dismiss(this));
        top.add_child(dismiss);

        this.add_child(new St.BoxLayout({
            name: 'actions',
            style_class: 'froonty-notifications-actions',
            x_expand: true,
            visible: false,
        }));
    }

    _part(name) {
        const find = actor => {
            for (const child of actor.get_children()) {
                if (child.name === name)
                    return child;
                const found = find(child);
                if (found)
                    return found;
            }
            return null;
        };
        return find(this);
    }

    /** The description shown (NotificationStore.describe), or null. */
    get description() {
        return this._desc;
    }

    /**
     * Shows `desc`, setting only what changed.
     *
     * @param {?object} desc NotificationStore.describe(); null keeps the row as it is
     */
    update(desc) {
        if (!desc)
            return;
        const old = this._desc ?? {};
        this._desc = desc;
        const {plainText} = this._format;

        if (desc.appName !== old.appName)
            this._part('app').text = desc.appName ?? _('Unknown app');
        if (!sameIcon(desc.appIcon, old.appIcon))
            this._part('app-icon').gicon = desc.appIcon;
        if (desc.title !== old.title)
            this._part('title').text = plainText(desc.title, false);
        if (desc.body !== old.body || desc.useMarkup !== old.useMarkup) {
            const body = plainText(desc.body, desc.useMarkup);
            this._part('body').text = body;
            this._part('body-bin').visible = body !== '';
        }
        if (!sameIcon(desc.icon, old.icon)) {
            const icon = this._part('icon');
            icon.gicon = desc.icon;
            icon.visible = desc.icon !== null;
        }
        if (desc.unseen !== old.unseen)
            this._part('new').visible = desc.unseen;
        if (desc.urgent)
            this.add_style_class_name('froonty-notifications-row-urgent');
        else
            this.remove_style_class_name('froonty-notifications-row-urgent');
        if (desc.time !== old.time)
            this.refreshAge();
        if (JSON.stringify(desc.actions) !== JSON.stringify(old.actions))
            this._showActions(desc.actions);

        const main = this._part('main');
        main.accessible_name = _('%s: %s').format(
            desc.appName ?? _('Unknown app'), plainText(desc.title, false));
    }

    /** "10 minutes ago", in GNOME's words; set only when it changed. */
    refreshAge() {
        const time = this._desc?.time ?? null;
        const ago = time ? this._format.timeAgo(time) : '';
        const text = ago ? `· ${ago}` : '';
        const age = this._part('age');
        if (age.text !== text)
            age.text = text;
    }

    focusMain() {
        this._part('main').grab_key_focus();
    }

    // At most three buttons (GNOME's MAX_NOTIFICATION_BUTTONS), the
    // store's first three; long labels ellipsize.
    _showActions(labels) {
        const box = this._part('actions');
        box.destroy_all_children();
        labels.forEach((label, index) => {
            const button = new St.Button({
                style_class: 'froonty-notifications-action',
                label,
                accessible_name: label,
                can_focus: true,
                track_hover: true,
                x_expand: true,
            });
            button.connect('clicked', () => this._actions.action(this, index));
            box.add_child(button);
        });
        box.visible = labels.length > 0;
    }

    // App and full time, the title, and the body (cut at 600 characters).
    _bubble() {
        const desc = this._desc;
        if (!desc)
            return null;
        const {plainText, when} = this._format;
        const app = desc.appName ?? _('Unknown app');
        return bubbleText({
            heading: desc.time ? `${app} · ${when(desc.time)}` : app,
            title: plainText(desc.title, false),
            body: plainText(desc.body, desc.useMarkup),
        });
    }
});
