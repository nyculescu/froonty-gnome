// SPDX-License-Identifier: GPL-3.0-or-later
// Panic button "Block camera": GNOME's camera switch model
// (panic/cameraAccess.js) and its catalog entry.
//
// Never the real user's settings: every write goes through a Gio.Settings
// on its own memory backend (asserted below), or through a fake.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import {test, eq, ok, done} from './test.js';
import * as Catalog from '../../froonty@catalin/panic/catalog.js';
import {
    CameraAccess, DISABLE_CAMERA, PRIVACY_SCHEMA, privacySettings,
} from '../../froonty@catalin/panic/cameraAccess.js';

const schema = () => Gio.SettingsSchemaSource.get_default().lookup(PRIVACY_SCHEMA, true);

/** GNOME's privacy settings on a private, in-memory backend. */
function isolatedPrivacy(backend = Gio.memory_settings_backend_new()) {
    const settings = new Gio.Settings({settings_schema: schema(), backend});
    eq(GObject.type_name(settings.backend.constructor.$gtype), 'GMemorySettingsBackend',
        'test settings must be in memory');
    return settings;
}

const flush = () => {
    while (GLib.MainContext.default().iteration(false))
        ;
};

// A switch an administrator has locked (a dconf lock): readable, not writable.
function lockedFake(value) {
    const handlers = new Map();
    let nextId = 1;
    return {
        writes: 0,
        writable: false,
        get_boolean: () => value,
        set_boolean() {
            this.writes++;
        },
        is_writable() {
            return this.writable;
        },
        connect(signal, callback) {
            handlers.set(nextId, {signal, callback});
            return nextId++;
        },
        disconnect: id => handlers.delete(id),
        emit: signal => [...handlers.values()]
            .filter(h => h.signal === signal).forEach(h => h.callback()),
        handlerCount: () => handlers.size,
    };
}

test('the catalog offers "Block camera for apps that ask GNOME"', () => {
    const entry = Catalog.byId('block-camera');
    ok(entry, 'entry exists');
    eq(entry.icon, 'camera-disabled-symbolic');
    eq(entry.title(s => s), 'Block camera for apps that ask GNOME');
    eq(Catalog.sanitize(['block-camera', 'mute-sound']), ['block-camera', 'mute-sound']);
});

test('its Settings description says what it does not block', () => {
    const text = Catalog.byId('block-camera').description(s => s);
    ok(text.includes('Camera Access'), text);
    ok(text.includes('are not blocked'), text);
    ok(text.includes('already in use stays on'), text);
    // Translatable through the caller's gettext, like the title.
    ok(Catalog.byId('block-camera').description(s => `[${s}]`).startsWith('['));
});

test('GNOME 50 has the switch (org.gnome.desktop.privacy disable-camera)', () => {
    ok(schema()?.has_key(DISABLE_CAMERA), 'installed schema lacks disable-camera');
    // Read-only: only the schema of the default backend's object is looked at.
    eq(privacySettings()?.settings_schema.get_id(), PRIVACY_SCHEMA);
});

test('privacySettings is null when the schema or the key is missing', () => {
    eq(privacySettings({lookup: () => null}), null);
    eq(privacySettings({lookup: () => ({has_key: () => false})}), null);
    eq(privacySettings(null), null);
});

test('reads the switch: allowed by default, usable', () => {
    const access = new CameraAccess(() => {}, isolatedPrivacy());
    eq(access.blocked, false);
    eq(access.usable, true);
    access.destroy();
});

test('toggle turns camera access off, then on again', () => {
    const backend = Gio.memory_settings_backend_new();
    const elsewhere = isolatedPrivacy(backend);
    let calls = 0;
    const access = new CameraAccess(() => calls++, isolatedPrivacy(backend));
    access.toggle();
    flush();
    eq([access.blocked, elsewhere.get_boolean(DISABLE_CAMERA)], [true, true]);
    ok(calls >= 1, 'onChanged after toggle');
    access.toggle();
    flush();
    eq([access.blocked, elsewhere.get_boolean(DISABLE_CAMERA)], [false, false]);
    access.destroy();
});

test('follows a change made elsewhere (e.g. GNOME Settings)', () => {
    const backend = Gio.memory_settings_backend_new();
    const elsewhere = isolatedPrivacy(backend);
    let calls = 0;
    const access = new CameraAccess(() => calls++, isolatedPrivacy(backend));
    eq(access.blocked, false); // read once, as the button does
    elsewhere.set_boolean(DISABLE_CAMERA, true);
    flush();
    eq([calls, access.blocked], [1, true]);
    elsewhere.set_boolean(DISABLE_CAMERA, false);
    flush();
    eq([calls, access.blocked], [2, false]);
    access.destroy();
});

test('destroy disconnects: later changes are not reported', () => {
    const backend = Gio.memory_settings_backend_new();
    const elsewhere = isolatedPrivacy(backend);
    const own = isolatedPrivacy(backend);
    let calls = 0;
    const handlers = () => ['changed', 'writable-changed'].map(signalId => {
        const n = GObject.signal_handlers_block_matched(own, {signalId});
        GObject.signal_handlers_unblock_matched(own, {signalId});
        return n;
    });
    const access = new CameraAccess(() => calls++, own);
    eq(handlers(), [1, 1], 'the probe sees the handlers');
    eq(access.blocked, false);
    access.destroy();
    elsewhere.set_boolean(DISABLE_CAMERA, true);
    flush();
    eq(calls, 0);
    eq(handlers(), [0, 0]);
    eq([access.blocked, access.usable], [false, false]);
});

test('a locked switch makes the button unusable, and toggle writes nothing', () => {
    const fake = lockedFake(true);
    let calls = 0;
    const access = new CameraAccess(() => calls++, fake);
    eq([access.usable, access.blocked], [false, true]);
    access.toggle();
    eq(fake.writes, 0);
    // The administrator unlocks it: the button hears of it.
    fake.writable = true;
    fake.emit(`writable-changed::${DISABLE_CAMERA}`);
    eq([calls, access.usable], [1, true]);
    access.destroy();
    eq(fake.handlerCount(), 0);
});

test('without the switch: unusable, never blocked, toggle and destroy are safe', () => {
    const access = new CameraAccess(() => {}, null);
    eq([access.usable, access.blocked], [false, false]);
    access.toggle();
    access.destroy();
});

await done();
