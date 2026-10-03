// SPDX-License-Identifier: GPL-3.0-or-later
// Test helper: GNOME's real BreakManager (misc/breakManager.js), loaded from
// the installed GNOME Shell, on a fake timeline. Nothing from GNOME is
// committed: the class is extracted from the Shell's library at run time.
//
// GNOME's constructor takes (clock, idleMonitor, settingsFactory) for its
// own unit tests; makeWorld() supplies all three, plus Froonty's timer and
// GNOME's settings on an in-memory backend (asserted), on one timeline:
//
//   world.input()      a key press: idle periods end, active watches fire
//   world.advance(s)   time passes; timers and idle watches fire in order

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

/** GNOME's BreakManager module ({BreakManager, BreakState, MIN_BREAK_LENGTH_SECONDS, …}). */
export async function loadGnomeBreakManager() {
    const dir = GLib.Dir.open('/usr/lib/gnome-shell', 0);
    let name;
    let lib = null;
    while ((name = dir.read_name()) !== null) {
        if (/^libshell-\d+\.so$/.test(name))
            lib = `/usr/lib/gnome-shell/${name}`;
    }
    dir.close();
    if (!lib)
        throw new Error('GNOME Shell\'s library (/usr/lib/gnome-shell/libshell-*.so) not found');
    if (!GLib.file_test('/usr/bin/gresource', GLib.FileTest.IS_EXECUTABLE))
        throw new Error('/usr/bin/gresource not found');
    const [ok, out, err, status] = GLib.spawn_sync(null,
        ['/usr/bin/gresource', 'extract', lib, '/org/gnome/shell/misc/breakManager.js'],
        null, GLib.SpawnFlags.DEFAULT, null);
    if (!ok || status !== 0)
        throw new Error(`gresource failed: ${new TextDecoder().decode(err)}`);
    const source = new TextDecoder().decode(out);
    return {module: await importManager(source), source};
}

async function importManager(source) {
    const end = source.search(/\/\*\*\n \* Glue class|export const BreakDispatcher/);
    if (end < 0)
        throw new Error('breakManager.js: BreakDispatcher not found');
    const dropped = /^import .* from '(gi:\/\/(Clutter|Cogl|Meta|Shell|St)|gettext|\.\.\/ui\/.*|\.\/systemActions\.js)';$/;
    const kept = source.slice(0, end).split('\n').filter(line => !dropped.test(line)).join('\n');
    const text = `const Meta = {IdleMonitorWatchFlags: {NONE: 0, UNINHIBITABLE: 1, START_NOW: 2}};\n${kept}`;
    const path = GLib.build_filenamev([GLib.get_tmp_dir(), `gnome-breakManager-${GLib.get_monotonic_time()}.js`]);
    GLib.file_set_contents(path, text);
    try {
        return await import(`file://${path}`);
    } finally {
        GLib.unlink(path);
    }
}

export const flush = () => {
    while (GLib.MainContext.default().iteration(false))
        ;
};

/**
 * One fake timeline for GNOME's clock and idle monitor and Froonty's timer.
 *
 * @param {object} [options]
 * @param {number} [options.start] wall-clock ms at the start
 */
export function makeWorld({start = Date.UTC(2026, 9, 1, 7, 0, 0)} = {}) {
    let now = start;
    let mono = 1e9;
    let nextId = 1;
    const timers = new Map(); // id → {at, callback}
    const watches = new Map(); // id → {ms, callback, fired, base} | {active, callback}
    let lastInput = now;

    const addTimer = (seconds, callback) => {
        const id = nextId++;
        timers.set(id, {at: now + seconds * 1000, callback});
        return id;
    };

    const idle = {
        add_idle_watch_full(ms, callback, flags = 0) {
            const id = nextId++;
            // START_NOW: counted from now, not from the last input.
            watches.set(id, {ms, callback, fired: false, base: flags & 2 ? now : null});
            return id;
        },
        add_user_active_watch(callback) {
            const id = nextId++;
            watches.set(id, {active: true, callback});
            return id;
        },
        remove_watch(id) {
            watches.delete(id);
        },
        get_idletime() {
            return now - lastInput;
        },
    };

    const world = {
        /** Mutter's active watches fire in this order (or reversed). */
        reverseActiveOrder: false,
        backend: Gio.memory_settings_backend_new(),
        now: () => now,
        mono: () => mono,
        clock: {
            sourceRemove: id => timers.delete(id),
            getRealTimeSecs: () => now / 1000,
            timeoutAddSeconds: (_priority, seconds, callback) => addTimer(seconds, callback),
        },
        timer: {
            add: addTimer,
            remove: id => timers.delete(id),
        },
        idle,
        settingsFactory: null,
        get timerCount() {
            return timers.size;
        },
        get watchCount() {
            return watches.size;
        },

        /** User input now. */
        input() {
            lastInput = now;
            for (const w of watches.values()) {
                if (!w.active) {
                    w.fired = false;
                    w.base = null;
                }
            }
            const active = [...watches.entries()].filter(([, w]) => w.active);
            if (world.reverseActiveOrder)
                active.reverse();
            for (const [id, w] of active) {
                if (watches.has(id))
                    w.callback(idle, id);
            }
            flush();
        },

        /** Lets `seconds` pass, firing timers and idle watches on time. */
        advance(seconds) {
            const end = now + seconds * 1000;
            for (;;) {
                let next = null;
                for (const [id, t] of timers) {
                    if (t.at <= end && (!next || t.at < next.at))
                        next = {at: t.at, run: () => {
                            timers.delete(id);
                            const again = t.callback();
                            // GLib.SOURCE_CONTINUE: GNOME's timers return SOURCE_REMOVE.
                            if (again === true)
                                timers.set(id, {at: now + 1000, callback: t.callback});
                        }};
                }
                for (const [id, w] of watches) {
                    if (w.active || w.fired)
                        continue;
                    const at = Math.max(lastInput, w.base ?? lastInput) + w.ms;
                    if (at <= end && (!next || at < next.at)) {
                        next = {at, run: () => {
                            w.fired = true;
                            w.callback(idle, id);
                        }};
                    }
                }
                if (!next)
                    break;
                mono += (Math.max(now, next.at) - now) * 1000;
                now = Math.max(now, next.at);
                next.run();
                flush();
            }
            mono += (end - now) * 1000;
            now = end;
            flush();
        },

        /** A suspend: wall-clock time passes, monotonic time (and every timer) does not. */
        suspend(seconds) {
            now += seconds * 1000;
            for (const t of timers.values())
                t.at += seconds * 1000;
            lastInput += seconds * 1000;
        },

        /** Seconds since the world started. */
        elapsed: () => (now - start) / 1000,

        /** Active (input every second) for `seconds`. */
        work(seconds) {
            for (let i = 0; i < seconds; i++) {
                world.input();
                world.advance(1);
            }
        },

        /** GNOME's settings, on this world's memory backend. */
        gnomeSettings(id, path = null) {
            const settings = new Gio.Settings(path
                ? {schema_id: id, path, backend: world.backend}
                : {schema_id: id, backend: world.backend});
            if (GObject.type_name(settings.backend.constructor.$gtype) !== 'GMemorySettingsBackend')
                throw new Error('test settings must be in memory');
            return settings;
        },
    };
    world.settingsFactory = {
        new: id => world.gnomeSettings(id),
        newWithPath: (id, path) => world.gnomeSettings(id, path),
    };
    return world;
}
