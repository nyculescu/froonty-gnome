// SPDX-License-Identifier: GPL-3.0-or-later
// GNOME's own Super+V, for the clipboard switcher (docs/features/clipboard.md,
// "Super+V and GNOME's notification list"). The only place that reads or
// writes it.
//
//   org.gnome.shell.keybindings toggle-message-tray
//     GNOME's default ['<Super>v', '<Super>m']: opens the calendar and
//     notification list (ui/windowManager.js, 50.1). The Shell rebinds it
//     as soon as the key changes.
//
// While the switcher is on, GNOME's key must not hold the switcher's
// shortcut (two bindings on one key: only one would work) and keeps
// Super+M. The user's value is remembered in clipboard-switcher-tray-backup
// and changed once, when the switcher turns on; it comes back when the user
// turns the switcher or the Clipboard tab off. disable() and enable() (each
// screen lock) never touch it. The decisions are switching.js's.
//
// Gio.Settings only; nothing at module load, no signal connected.

import Gio from 'gi://Gio';

import {formatTrayRecord, parseTrayRecord, trayOffPlan, trayOnPlan, trayShortcutPlan} from './switching.js';

const GNOME_SCHEMA = 'org.gnome.shell.keybindings';
const GNOME_KEY = 'toggle-message-tray';
export const BACKUP_KEY = 'clipboard-switcher-tray-backup';
export const SHORTCUT_KEY = 'clipboard-switcher-shortcut';

/** GNOME's keybinding settings, or null when this GNOME has no such key. */
function gnomeKeybindings() {
    const schema = Gio.SettingsSchemaSource.get_default()?.lookup(GNOME_SCHEMA, true);
    return schema?.has_key(GNOME_KEY) ? new Gio.Settings({settings_schema: schema}) : null;
}

export class MessageTrayKey {
    /**
     * @param {Gio.Settings} settings Froonty's
     * @param {?Gio.Settings} [gnome] GNOME's keybindings (the tests pass a fake)
     */
    constructor(settings, gnome = gnomeKeybindings()) {
        this._settings = settings;
        this._gnome = gnome;
    }

    /** Whether Froonty changed GNOME's key and has not given it back yet. */
    get changed() {
        return this._record() !== null;
    }

    /** The switcher is on (it may have been on already: then nothing changes). */
    turnOn() {
        if (!this._gnome)
            return;
        this._apply(trayOnPlan(this._record(), this._state(), this._shortcuts()));
    }

    /** The switcher's shortcut changed while it is on. */
    followShortcut() {
        if (!this._gnome)
            return;
        this._apply(trayShortcutPlan(this._record(), this._state(), this._shortcuts()));
    }

    /** The user turned the switcher (or the tab) off: their value comes back. */
    turnOff() {
        const record = this._record();
        if (!record)
            return;
        if (this._gnome) {
            const plan = trayOffPlan(record, this._state());
            if (plan.action === 'reset')
                this._gnome.reset(GNOME_KEY);
            else if (plan.action === 'set')
                this._gnome.set_strv(GNOME_KEY, plan.value);
        }
        this._settings.set_string(BACKUP_KEY, '');
    }

    _apply({write, record}) {
        if (write)
            this._gnome.set_strv(GNOME_KEY, write);
        const text = formatTrayRecord(record);
        if (text !== this._settings.get_string(BACKUP_KEY))
            this._settings.set_string(BACKUP_KEY, text);
    }

    _record() {
        return parseTrayRecord(this._settings.get_string(BACKUP_KEY));
    }

    _shortcuts() {
        return this._settings.get_strv(SHORTCUT_KEY);
    }

    _state() {
        return {
            value: this._gnome.get_strv(GNOME_KEY),
            isDefault: this._gnome.get_user_value(GNOME_KEY) === null,
            defaultValue: this._gnome.get_default_value(GNOME_KEY).deepUnpack(),
        };
    }
}
