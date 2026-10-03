// SPDX-License-Identifier: GPL-3.0-or-later
// Shared setup for the Break tab's tests: GNOME's real BreakManager on a
// fake timeline (gnomeBreakManager.js), Froonty's real schema and GNOME's
// settings on in-memory backends, and a BreakService wired to all of it.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import {BreakEngine} from '../../froonty@catalin/shell/breakEngine.js';
import {GnomeBreakSettings} from '../../froonty@catalin/features/break/gnomeSettings.js';
import {BreakService} from '../../froonty@catalin/features/break/service.js';
import {BreakStore} from '../../froonty@catalin/features/break/store.js';
import {loadGnomeBreakManager, makeWorld} from './gnomeBreakManager.js';

const EXTENSION_DIR = GLib.build_filenamev([
    GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]), '..', '..', 'froonty@catalin']);

export const isMemory = settings =>
    GObject.type_name(settings.backend.constructor.$gtype) === 'GMemorySettingsBackend';

/** Froonty's real schema on an in-memory backend: nothing touches dconf. */
export function froontySettings() {
    const source = Gio.SettingsSchemaSource.new_from_directory(
        GLib.build_filenamev([EXTENSION_DIR, 'schemas']), null, false);
    const settings = new Gio.Settings({
        settings_schema: source.lookup('org.gnome.shell.extensions.froonty', false),
        backend: Gio.memory_settings_backend_new(),
    });
    if (!isMemory(settings))
        throw new Error('test settings must be in memory');
    return settings;
}

export const froontySchemaSource = () => Gio.SettingsSchemaSource.new_from_directory(
    GLib.build_filenamev([EXTENSION_DIR, 'schemas']), null, false);

export function tempFolder() {
    return Gio.File.new_for_path(GLib.build_filenamev(
        [GLib.dir_make_tmp('froonty-break-XXXXXX'), 'break']));
}

let gnomeModule = null;

/** GNOME's breakManager.js module (loaded once). */
export async function gnome() {
    gnomeModule ??= await loadGnomeBreakManager();
    return gnomeModule;
}

const SECONDS_KEYS = {interval: 'interval-seconds', duration: 'duration-seconds', delay: 'delay-seconds'};

/** Sets a GNOME break type's settings ({interval, duration, delay, fade, …}). */
export function configure(world, type, options) {
    const s = world.gnomeSettings(`org.gnome.desktop.break-reminders.${type}`);
    for (const [key, value] of Object.entries(options)) {
        if (SECONDS_KEYS[key])
            s.set_uint(SECONDS_KEYS[key], value);
        else
            s.set_boolean({fade: 'fade-screen', lock: 'lock-screen', countdown: 'countdown'}[key] ?? key, value);
    }
}

export function select(world, types) {
    world.gnomeSettings('org.gnome.desktop.break-reminders').set_strv('selected-breaks', types);
}

/**
 * A world with GNOME's engine and a started BreakService.
 *
 * @param {object} [options]
 * @param {object} [options.eyesight] GNOME settings for eye breaks
 * @param {?object} [options.movement]
 * @param {string[]} [options.selected]
 * @param {object} [options.froonty] Froonty keys to set first
 * @param {Function} [options.wrap] (manager) → what the engine sees
 */
export async function setup({
    eyesight = {interval: 60, duration: 20, delay: 30},
    movement = null,
    selected = ['eyesight'],
    froonty = {},
    wrap = m => m,
    world = makeWorld(),
    store = new BreakStore(tempFolder()),
    settings = froontySettings(),
    pid = 4242,
    wallClock = null,
} = {}) {
    const {module} = await gnome();
    configure(world, 'eyesight', eyesight);
    if (movement)
        configure(world, 'movement', movement);
    const manager = world.manager ?? new module.BreakManager(world.clock, world.idle, world.settingsFactory);
    world.manager = manager;
    select(world, selected);
    for (const [key, value] of Object.entries(froonty)) {
        if (typeof value === 'boolean')
            settings.set_boolean(key, value);
        else if (typeof value === 'number')
            settings.set_int(key, value);
        else
            settings.set_string(key, value);
    }
    const service = makeService({world, manager: wrap(manager), settings, store, pid, wallClock});
    await service.start();
    return {world, manager, service, settings, store, module};
}

export function makeService({world, manager, settings, store, pid = 4242, wallClock = null}) {
    return new BreakService(settings, {
        engine: new BreakEngine(manager),
        gnome: onChanged => {
            const g = new GnomeBreakSettings({backend: world.backend, onChanged});
            for (const s of [g.breaks, g.wellbeing, g.limits, g.typeSettings('eyesight')]) {
                if (s && !isMemory(s))
                    throw new Error('GNOME test settings must be in memory');
            }
            return g;
        },
        idle: {
            addIdle: (ms, callback) => world.idle.add_idle_watch_full(ms, () => callback(), 1),
            addActive: callback => world.idle.add_user_active_watch(() => callback()),
            remove: id => world.idle.remove_watch(id),
            idleTime: () => world.idle.get_idletime(),
        },
        wallClock,
        timer: world.timer,
        now: world.now,
        mono: world.mono,
        store,
        pid,
    });
}
