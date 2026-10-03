// SPDX-License-Identifier: GPL-3.0-or-later
// GNOME's own break-reminder settings, shared with Settings → Wellbeing
// (docs/features/break.md), plus the two GNOME settings the Break tab only
// reads or restores: the Wellbeing panel's notification switch and the
// daily screen-time limit. Gio only (no St), so the settings window and
// the unit tests load it too.
//
// Every schema is looked up first: making a Gio.Settings for a schema that
// is not installed aborts the process.

import Gio from 'gi://Gio';

export const BREAK_SCHEMA = 'org.gnome.desktop.break-reminders';
export const BREAK_TYPES = ['eyesight', 'movement'];
export const SELECTED = 'selected-breaks';
// The Wellbeing panel's notifications (GNOME's break and screen-time
// notifications come from it).
export const WELLBEING_SCHEMA = 'org.gnome.desktop.notifications.application';
export const WELLBEING_PATH = '/org/gnome/desktop/notifications/application/gnome-wellbeing-panel/';
export const LIMITS_SCHEMA = 'org.gnome.desktop.screen-time-limits';
export const DAILY_LIMIT = 'daily-limit-enabled';

const TYPE_KEYS = {
    interval: 'interval-seconds',
    duration: 'duration-seconds',
    delay: 'delay-seconds',
    fade: 'fade-screen',
    lock: 'lock-screen',
    sound: 'play-sound',
    countdown: 'countdown',
};

export class GnomeBreakSettings {
    /**
     * @param {object} [options]
     * @param {Gio.SettingsSchemaSource} [options.source]
     * @param {?Gio.SettingsBackend} [options.backend] tests pass a memory one
     * @param {Function} [options.onChanged] called after any of them changes
     */
    constructor({source = Gio.SettingsSchemaSource.get_default(), backend = null,
        onChanged = null} = {}) {
        this._source = source;
        this._backend = backend;
        this._handlers = [];
        this.breaks = this._make(BREAK_SCHEMA, null, SELECTED);
        const types = this.breaks
            ? BREAK_TYPES.map(t => [t, this._make(`${BREAK_SCHEMA}.${t}`, null, 'interval-seconds')])
            : [];
        this._types = new Map(types.filter(([, s]) => s));
        this.wellbeing = this._make(WELLBEING_SCHEMA, WELLBEING_PATH, 'enable');
        this.limits = this._make(LIMITS_SCHEMA, null, DAILY_LIMIT);

        if (onChanged) {
            // Connected, then read: GSettings only reports changes to keys
            // read while a handler is connected.
            for (const settings of this._all())
                this._handlers.push([settings, settings.connect('changed', (_s, key) => onChanged(key))]);
            this.selected();
            this.wellbeingEnabled();
            this.dailyLimit();
            for (const t of this._types.keys())
                this.type(t);
        }
    }

    destroy() {
        for (const [settings, id] of this._handlers)
            settings.disconnect(id);
        this._handlers = [];
    }

    /** Whether GNOME's break reminders exist here (GNOME 48 or later). */
    get available() {
        return Boolean(this.breaks) && this._types.size === BREAK_TYPES.length;
    }

    /** GNOME's per-type Gio.Settings, or null. */
    typeSettings(type) {
        return this._types.get(type) ?? null;
    }

    selected() {
        return this.breaks?.get_strv(SELECTED) ?? [];
    }

    selectedWritable() {
        return this.breaks?.is_writable(SELECTED) ?? false;
    }

    /** Turns `type` on or off in GNOME's selected-breaks (a user's click). */
    setSelected(type, on) {
        if (!this.selectedWritable())
            return;
        const now = this.selected();
        const next = on
            ? BREAK_TYPES.filter(t => t === type || now.includes(t))
            : now.filter(t => t !== type);
        if (next.join() !== now.join())
            this.breaks.set_strv(SELECTED, next);
    }

    /** Turns on both of GNOME's break types (the tab's offer). */
    selectAll() {
        if (this.selectedWritable())
            this.breaks.set_strv(SELECTED, [...BREAK_TYPES]);
    }

    /** A type's settings, in seconds and booleans. */
    type(t) {
        const s = this._types.get(t);
        if (!s)
            return null;
        return {
            interval: s.get_uint(TYPE_KEYS.interval),
            duration: s.get_uint(TYPE_KEYS.duration),
            delay: s.get_uint(TYPE_KEYS.delay),
            fade: s.get_boolean(TYPE_KEYS.fade),
            lock: s.get_boolean(TYPE_KEYS.lock),
            sound: s.get_boolean(TYPE_KEYS.sound),
            countdown: s.get_boolean(TYPE_KEYS.countdown),
        };
    }

    wellbeingEnabled() {
        return this.wellbeing?.get_boolean('enable') ?? true;
    }

    dailyLimit() {
        return this.limits?.get_boolean(DAILY_LIMIT) ?? false;
    }

    *_all() {
        yield* [this.breaks, ...this._types.values(), this.wellbeing, this.limits].filter(Boolean);
    }

    _make(id, path, key) {
        const schema = this._source?.lookup(id, true) ?? null;
        if (!schema?.has_key(key))
            return null;
        const props = {settings_schema: schema};
        if (path)
            props.path = path;
        if (this._backend)
            props.backend = this._backend;
        return new Gio.Settings(props);
    }
}

/**
 * Who reminds of breaks, as Settings and the tab show it.
 *
 * @param {object} saved Froonty's break-gnome-saved record (parsed)
 * @param {GnomeBreakSettings} gnome
 * @returns {{state: 'froonty'|'gnome'|'unavailable', dailyLimitHidden: boolean}}
 */
export function takeoverStatus(saved, gnome) {
    const w = gnome.wellbeing;
    if (!w || !w.is_writable('enable'))
        return {state: 'unavailable', dailyLimitHidden: false};
    const applied = Boolean(saved?.['wellbeing/enable']) && !w.get_boolean('enable');
    return {state: applied ? 'froonty' : 'gnome', dailyLimitHidden: applied && gnome.dailyLimit()};
}

/** Froonty's saved record of what it changed in GNOME (break-gnome-saved). */
export function parseSaved(text) {
    try {
        const data = JSON.parse(text || '{}');
        return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    } catch (e) {
        return {};
    }
}
