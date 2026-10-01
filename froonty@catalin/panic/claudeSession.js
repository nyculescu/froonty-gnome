// SPDX-License-Identifier: GPL-3.0-or-later
// Panic button "Claude session usage": the session's usage (0-100, no "%")
// in Claude's orange, as large as the button allows, over a faint grey
// Spark (user request: the number first, the Spark barely visible). Not an
// action: a click opens the Claude tab. Its name (the tooltip) spells the
// number out.
//
// Same data and rules as the Claude tab (features/claude/service.js): read
// each time the island opens, followed while it stays open, nothing while
// it is collapsed. "?" when it is not known: offline, no reading, or a
// session that renewed since the reading.

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {sparkIcon} from '../features/claude/icon.js';
import {ClaudeService} from '../features/claude/service.js';
import {SESSION} from '../features/claude/usage.js';

export class ClaudeSessionButton {
    /**
     * @param {string} title
     * @param {object} actions
     * @param {Function} actions.selectTab
     * @param {Gio.Settings} [actions.settings] to share the tab's refresher
     */
    constructor(title, {selectTab, settings = null}) {
        this._title = title;

        this._number = new St.Label({
            style_class: 'froonty-claude-session-number',
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        // Fills the whole button (its padding is 0), so the number can use
        // all of it; the Spark behind is only a faint watermark.
        const stack = new St.Widget({
            style_class: 'froonty-claude-session-stack',
            layout_manager: new Clutter.BinLayout(),
        });
        stack.add_child(new St.Icon({
            style_class: 'froonty-claude-session-icon',
            gicon: sparkIcon(),
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        stack.add_child(this._number);

        this.actor = new St.Button({
            style_class: 'froonty-icon-button froonty-panic-button froonty-claude-session',
            accessible_name: title,
            can_focus: true,
            track_hover: true,
            child: stack,
        });
        this.actor.connect('clicked', () => selectTab('claude'));

        this._service = new ClaudeService({settings});
        this._service.start();
        this._serviceId = this._service.connect('changed', () => this._sync());
        this._sync();
    }

    destroy() {
        this._service.disconnect(this._serviceId);
        this._service.stop();
        this.actor.destroy();
    }

    setActive(active) {
        this._service.setActive(active);
    }

    _sync() {
        const {usage, online} = this._service;
        const session = usage?.windows.find(w => w.kind === SESSION);
        // After a renewal, what was used since is not known.
        const known = online && session &&
            (session.resetsAt === null || session.resetsAt > Date.now());
        if (known) {
            const percent = Math.min(100, Math.round(session.percent));
            this._number.text = `${percent}`;
            this.actor.accessible_name = _('%s: %d%%').format(this._title, percent);
        } else {
            this._number.text = '?';
            this.actor.accessible_name = online
                ? _('%s: unknown').format(this._title)
                : _('%s: unknown (no internet connection)').format(this._title);
        }
    }
}
