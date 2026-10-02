// SPDX-License-Identifier: GPL-3.0-or-later
// GNOME's own camera switch, "Camera Access" in Settings → Privacy &
// Security → Cameras: org.gnome.desktop.privacy disable-camera. Shell-free
// (Gio only), so it is unit-tested; panic/camera.js is its button.
//
// What the switch does, verified on Ubuntu 26.04 / GNOME 50
// (docs/features/panic-buttons.md §4.1): xdg-desktop-portal-gnome mirrors
// it into the portal's Lockdown backend, and the camera portal then refuses
// AccessCamera and OpenPipeWireRemote. Nothing else reads it: apps that
// open /dev/video* themselves are not blocked (GNOME Settings says so on
// that page), and a camera already in use is not taken back.

import Gio from 'gi://Gio';

export const PRIVACY_SCHEMA = 'org.gnome.desktop.privacy';
export const DISABLE_CAMERA = 'disable-camera';

/**
 * GNOME's privacy settings, or null when the installed schemas lack the
 * key (creating Gio.Settings for a missing schema would abort the Shell).
 *
 * @param {Gio.SettingsSchemaSource} [source]
 * @returns {?Gio.Settings}
 */
export function privacySettings(source = Gio.SettingsSchemaSource.get_default()) {
    const schema = source?.lookup(PRIVACY_SCHEMA, true) ?? null;
    return schema?.has_key(DISABLE_CAMERA) ? new Gio.Settings({settings_schema: schema}) : null;
}

export class CameraAccess {
    /**
     * Follows the switch, whoever turns it (GNOME Settings, gsettings,
     * this button), and whether it can be turned at all.
     *
     * @param {Function} onChanged called after either changes
     * @param {?Gio.Settings} [settings] GNOME's privacy settings; tests
     *   pass one on an isolated backend
     */
    constructor(onChanged, settings = privacySettings()) {
        this._settings = settings;
        // Connected before the first read: GSettings only reports changes
        // to a key that was read while a handler was connected.
        this._handlerIds = settings ? [
            settings.connect(`changed::${DISABLE_CAMERA}`, () => onChanged()),
            settings.connect(`writable-changed::${DISABLE_CAMERA}`, () => onChanged()),
        ] : [];
    }

    destroy() {
        for (const id of this._handlerIds)
            this._settings.disconnect(id);
        this._handlerIds = [];
        this._settings = null;
    }

    /** Whether the switch exists and is not locked by an administrator. */
    get usable() {
        return this._settings?.is_writable(DISABLE_CAMERA) ?? false;
    }

    /** Whether camera access is off (the panic action is on). */
    get blocked() {
        return this._settings?.get_boolean(DISABLE_CAMERA) ?? false;
    }

    toggle() {
        if (this.usable)
            this._settings.set_boolean(DISABLE_CAMERA, !this.blocked);
    }
}
