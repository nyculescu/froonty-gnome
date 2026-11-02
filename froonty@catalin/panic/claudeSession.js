// SPDX-License-Identifier: GPL-3.0-or-later
// Panic button "Claude session usage": the session's or, as chosen in
// Settings → Claude, the week's usage (0-100, no "%") in Claude's orange,
// after the Spark. Not an action: a click opens the Claude tab. Its name
// (the tooltip) spells the number out.
//
// Same data and rules as the Claude tab (features/claude/service.js): read
// each time the island opens, followed while it stays open, nothing while
// it is collapsed. "?" when it is not known: offline, no reading, or a
// window that renewed since the reading.

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {sparkIcon} from '../features/claude/icon.js';
import {ClaudeService} from '../features/claude/service.js';
import {WEEKLY} from '../features/claude/usage.js';
import {valueButton} from './valueButton.js';

const USAGE_WINDOW_KEY = 'claude-panic-usage-window';

export class ClaudeSessionButton {
    /**
     * @param {string} title
     * @param {object} actions
     * @param {Function} actions.selectTab
     * @param {Gio.Settings} actions.settings to share the tab's refresher
     *   and read the usage window shown
     */
    constructor(title, {selectTab, settings}) {
        this._title = title;
        this._settings = settings;

        const {actor, icon, number} = valueButton(title, 'froonty-claude-session', 'froonty-claude-session-number');
        icon.gicon = sparkIcon();
        this.actor = actor;
        this._number = number;
        this.actor.connect('clicked', () => selectTab('claude'));

        this._service = new ClaudeService({settings});
        this._service.start();
        this._serviceId = this._service.connect('changed', () => this._sync());
        this._settingsId = settings.connect(`changed::${USAGE_WINDOW_KEY}`, () => this._sync());
        this._sync();
    }

    destroy() {
        this._service.disconnect(this._serviceId);
        this._settings.disconnect(this._settingsId);
        this._service.stop();
        this.actor.destroy();
    }

    setActive(active) {
        this._service.setActive(active);
    }

    _sync() {
        const {usage, online} = this._service;
        const kind = this._settings.get_string(USAGE_WINDOW_KEY);
        const weekly = kind === WEEKLY;
        const session = usage?.windows.find(w => w.kind === kind);
        const title = weekly ? _('Claude weekly usage') : this._title;
        // After a renewal, what was used since is not known.
        const known = online && session &&
            (session.resetsAt === null || session.resetsAt > Date.now());
        if (known) {
            const percent = Math.min(100, Math.round(session.percent));
            this._number.text = `${percent}`;
            this.actor.accessible_name = _('%s: %d%%').format(title, percent);
        } else {
            this._number.text = '?';
            this.actor.accessible_name = online
                ? _('%s: unknown').format(title)
                : _('%s: unknown (no internet connection)').format(title);
        }
    }
}
