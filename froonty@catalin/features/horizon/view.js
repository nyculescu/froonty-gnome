// SPDX-License-Identifier: GPL-3.0-or-later
// The Horizon card: a compact list of the latest briefing's items, in the
// Widgets tab and on the desktop.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {linesLabel} from '../../ui/linesLabel.js';

// Lines of each briefing's text under its headline.
const SUMMARY_LINES = 3;

export class HorizonView {
    /**
     * @param {object} _ctx
     * @param {HorizonService} service
     * @param {object} [options]
     * @param {boolean} [options.scroll] false when the parent scrolls it
     *   (the tab); the desktop card keeps a scroll of its own
     * @param {boolean} [options.refresh] false on the desktop card
     *   (owner's choice: Refresh is in the tab)
     */
    constructor(_ctx, service, {scroll = true, refresh = true} = {}) {
        this._service = service;
        // Whether a headline opens its page (setActions).
        this._actions = true;
        // A refresh started before this view (by the panic button, say).
        this._refreshing = service.refreshing ?? false;
        this._error = '';
        this.actor = new St.BoxLayout({
            style_class: 'froonty-widgets',
            vertical: true,
            x_expand: true,
            y_expand: scroll,
        });

        const header = new St.BoxLayout({
            style_class: 'froonty-widgets-header',
            x_expand: true,
        });
        this._status = new St.Label({
            style_class: 'froonty-widgets-status',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        header.add_child(this._status);
        this._refreshButton = null;
        if (refresh) {
            this._refreshButton = new St.Button({
                style_class: 'froonty-widget-refresh',
                label: _('Refresh'),
                can_focus: true,
                track_hover: true,
            });
            this._refreshButton.connect('clicked', () => {
                this._error = '';
                this._service.triggerRefresh();
                this._syncStatus();
            });
            header.add_child(this._refreshButton);
        }
        this.actor.add_child(header);

        this._list = new St.BoxLayout({
            style_class: 'froonty-widgets-list',
            vertical: true,
            x_expand: true,
        });
        if (scroll) {
            this._scroll = new St.ScrollView({
                hscrollbar_policy: St.PolicyType.NEVER,
                overlay_scrollbars: true,
                x_expand: true,
                y_expand: true,
            });
            this._scroll.add_child(this._list);
            this.actor.add_child(this._scroll);
        } else {
            this.actor.add_child(this._list);
        }

        this._itemsChangedId = this._service.connect('items-changed', () => this._sync());
        this._refreshStateId = this._service.connect('refresh-state', (_service, refreshing) => {
            this._refreshing = refreshing;
            this._syncStatus();
        });
        this._refreshErrorId = this._service.connect('refresh-error', (_service, message) => {
            this._error = message;
            this._syncStatus();
        });
        this._sync();
    }

    /**
     * Whether a click on a headline opens it. Off, the headlines take no
     * pointer: the card still scrolls (the wheel reaches its scroll view).
     */
    setActions(on) {
        this._actions = on;
        for (const row of this._list.get_children()) {
            row.reactive = on;
            row.can_focus = on;
        }
    }

    destroy() {
        for (const id of [this._itemsChangedId, this._refreshStateId, this._refreshErrorId]) {
            if (id)
                this._service.disconnect(id);
        }
        this.actor.destroy();
    }

    _sync() {
        const items = this._service.items || [];
        this._list.destroy_all_children();

        this._syncStatus();
        for (const item of items.slice(0, 6)) {
            const row = new St.Button({
                style_class: 'froonty-widget-item',
                can_focus: this._actions,
                track_hover: true,
                reactive: this._actions,
            });
            const stack = new St.BoxLayout({
                vertical: true,
                x_expand: true,
                style_class: 'froonty-widget-item-inner',
            });

            const title = new St.Label({
                style_class: 'froonty-widget-item-title',
                text: item.title || _('Untitled item'),
                x_align: Clutter.ActorAlign.START,
                y_align: Clutter.ActorAlign.CENTER,
            });
            // Whole: an ellipsizing label's minimum is one line, and a
            // scroll view's content gets its minimum.
            title.clutter_text.set({line_wrap: true, ellipsize: Pango.EllipsizeMode.NONE});
            stack.add_child(title);

            if (item.summary) {
                const {box} = linesLabel({
                    style_class: 'froonty-widget-item-summary',
                    text: item.summary,
                }, SUMMARY_LINES);
                stack.add_child(box);
            }

            row.set_child(stack);
            row.connect('clicked', () => {
                if (!item.url)
                    return;
                Gio.AppInfo.launch_default_for_uri(item.url, global.create_app_launch_context(0, -1));
            });
            this._list.add_child(row);
        }
    }

    _syncStatus() {
        const items = this._service.items || [];
        if (this._refreshButton) {
            this._refreshButton.reactive = !this._refreshing;
            this._refreshButton.label = this._refreshing ? _('Refreshing…') : _('Refresh');
        }
        if (this._error)
            this._status.text = this._error;
        else if (this._refreshing)
            this._status.text = _('Refreshing Horizon…');
        else if (items.length)
            this._status.text = _('Latest Horizon briefings');
        else if (this._refreshButton)
            this._status.text = _('No Horizon news yet. Select Refresh to fetch a briefing.');
        else
            this._status.text = _('No Horizon news yet. Refresh it in the Widgets tab or with its panic button.');
    }
}
