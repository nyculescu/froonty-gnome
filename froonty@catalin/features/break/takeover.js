// SPDX-License-Identifier: GPL-3.0-or-later
// "Remind me in the island instead of GNOME's notifications"
// (docs/features/break.md). GNOME's break engine keeps timing; while the
// island shows the reminders, GNOME's own notifications for them are off:
//
//   the Wellbeing panel's notifications       enable    → false
//   (org.gnome.desktop.notifications.application, gnome-wellbeing-panel)
//   each break type's "Break in N s" overlay  countdown → false (only if on)
//
// The Wellbeing switch is the one clean switch: it hides every break
// notification (no banner, no list entry, no unread dot) and leaves the
// engine alone. GNOME's daily screen-time limit alerts use it too, and
// GNOME Settings has no switch to turn it back on, so Froonty restores
// exactly what it changed, recorded in break-gnome-saved, whenever the
// reminders, the Break tab, the island or Froonty is turned off (but not
// under the lock screen; see extension.js). Gio only; no St.

import GLib from 'gi://GLib';

import {Emitter} from '../../core/emitter.js';
import {GnomeBreakSettings, parseSaved, takeoverStatus} from './gnomeSettings.js';

export const SAVED_KEY = 'break-gnome-saved';
const TRIGGERS = ['break-enabled', 'break-pill-reminders', 'break-pill-cue'];

// What Froonty changes, by record id.
const KEYS = [
    {id: 'wellbeing/enable', settings: g => g.wellbeing, key: 'enable'},
    {id: 'eyesight/countdown', settings: g => g.typeSettings('eyesight'), key: 'countdown'},
    {id: 'movement/countdown', settings: g => g.typeSettings('movement'), key: 'countdown'},
];
const TARGET = false;

/**
 * Whether Froonty should be the one reminding: only on the user's choice
 * (break-enabled is off by default), only while the island is there to
 * show it, and only while GNOME's breaks are on.
 */
export function desired({enabled, pillReminders, cue, pillShown, selected}) {
    return enabled && pillReminders && cue !== 'off' && pillShown && selected.length > 0;
}

/** Emits 'changed' after applying or restoring. */
export class NotificationTakeover extends Emitter {
    /**
     * @param {Gio.Settings} settings Froonty's
     * @param {GnomeBreakSettings} [gnome] tests pass one on a memory backend
     */
    constructor(settings, gnome = null) {
        super();
        this._settings = settings;
        this._pillShown = false;
        this._gnome = gnome ?? new GnomeBreakSettings();
        this._ownsGnome = !gnome;
        // Not a trigger: the Wellbeing switch itself. Should something else
        // turn it, Froonty leaves it until the next trigger: no fight.
        this._gnomeId = this._gnome.breaks?.connect('changed::selected-breaks',
            () => this._reconcile()) ?? 0;
        this._gnome.selected();
        this._settingsIds = TRIGGERS.map(key =>
            settings.connect(`changed::${key}`, () => this._reconcile()));
    }

    /** @param {object} state  pillShown: whether the island exists */
    sync({pillShown}) {
        this._pillShown = pillShown;
        this._reconcile();
    }

    /**
     * @param {object} options
     * @param {boolean} options.restore false under the lock screen: GNOME's
     *   break notifications would show there and flicker on every unlock
     */
    destroy({restore}) {
        for (const id of this._settingsIds)
            this._settings.disconnect(id);
        this._settingsIds = [];
        if (this._gnomeId)
            this._gnome.breaks.disconnect(this._gnomeId);
        this._gnomeId = 0;
        if (restore)
            this._restore();
        if (this._ownsGnome)
            this._gnome.destroy();
        this._gnome = null;
    }

    get status() {
        return takeoverStatus(this._saved(), this._gnome);
    }

    get desired() {
        const s = this._settings;
        return desired({
            enabled: s.get_boolean('break-enabled'),
            pillReminders: s.get_boolean('break-pill-reminders'),
            cue: s.get_string('break-pill-cue'),
            pillShown: this._pillShown,
            selected: this._gnome.selected(),
        });
    }

    _reconcile() {
        if (!this._gnome)
            return;
        if (this.desired)
            this._apply();
        else
            this._restore();
    }

    _saved() {
        return parseSaved(this._settings.get_string(SAVED_KEY));
    }

    _writeSaved(record) {
        const text = Object.keys(record).length ? JSON.stringify(record) : '';
        if (this._settings.get_string(SAVED_KEY) !== text)
            this._settings.set_string(SAVED_KEY, text);
    }

    _apply() {
        const record = this._saved();
        const target = GLib.Variant.new_boolean(TARGET).print(true);
        const writes = [];
        for (const {id, settings, key} of KEYS) {
            const s = settings(this._gnome);
            // Locked by an administrator, or not there: left alone
            // (status: unavailable for the Wellbeing switch).
            if (!s || !s.is_writable(key))
                continue;
            const current = s.get_boolean(key);
            if (current === TARGET && !record[id])
                continue;
            if (!record[id])
                record[id] = {user: s.get_user_value(key)?.print(true) ?? null, set: target};
            if (current !== TARGET)
                writes.push([s, key]);
        }
        // The record first: whatever happens next, a restore can undo it.
        this._writeSaved(record);
        for (const [s, key] of writes)
            s.set_boolean(key, TARGET);
        if (writes.length)
            this.emit('changed');
    }

    _restore() {
        const record = this._saved();
        if (!Object.keys(record).length)
            return;
        for (const {id, settings, key} of KEYS) {
            const saved = record[id];
            if (!saved)
                continue;
            const s = settings(this._gnome);
            // Changed by the user since: theirs now, left alone.
            if (s?.is_writable(key) && s.get_value(key).print(true) === saved.set) {
                if (saved.user === null)
                    s.reset(key);
                else
                    s.set_value(key, savedBoolean(saved.user) ?? s.get_default_value(key));
            }
            delete record[id];
        }
        this._writeSaved(record);
        this.emit('changed');
    }
}

// A recorded boolean ("true"/"false"); null for anything else, so a
// damaged record restores GNOME's default instead of throwing.
function savedBoolean(text) {
    try {
        return GLib.Variant.parse(new GLib.VariantType('b'), text, null, null);
    } catch {
        return null;
    }
}
