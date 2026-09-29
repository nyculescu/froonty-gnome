// SPDX-License-Identifier: GPL-3.0-or-later
// Opens the collapsed island after the pointer has rested on it for
// `hover-open-delay` ms (0: off). One one-shot timer, only while the pointer
// is on the collapsed pill; leaving it, opening or destroy() cancels it.

import GLib from 'gi://GLib';

const DELAY_KEY = 'hover-open-delay';

export class HoverOpen {
    /**
     * @param {St.Widget} pill tracks hover
     * @param {Gio.Settings} settings
     * @param {object} island
     * @param {Function} island.isExpanded
     * @param {Function} island.expand
     */
    constructor(pill, settings, {isExpanded, expand}) {
        this._pill = pill;
        this._settings = settings;
        this._isExpanded = isExpanded;
        this._expand = expand;
        this._timeoutId = 0;

        this._hoverId = pill.connect('notify::hover', () => this._sync());
    }

    destroy() {
        this.cancel();
        this._pill.disconnect(this._hoverId);
    }

    /** Called when the island opens by other means (click, keyboard). */
    cancel() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
    }

    _sync() {
        const delay = this._settings.get_int(DELAY_KEY);
        if (!this._pill.hover || this._isExpanded() || delay === 0) {
            this.cancel();
            return;
        }
        if (this._timeoutId)
            return;

        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._timeoutId = 0;
            if (this._pill.hover && !this._isExpanded())
                this._expand();
            return GLib.SOURCE_REMOVE;
        });
    }
}
