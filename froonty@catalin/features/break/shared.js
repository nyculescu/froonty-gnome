// SPDX-License-Identifier: GPL-3.0-or-later
// One BreakService per Shell (docs/features/break.md). The extension holds
// it while the Break tab is enabled, so tracking runs with the tab never
// opened or the island hidden; the tab, the pill's cue and the sit/stand
// panic button hold it too while they exist. Its GNOME parts are made here:
//
// - GNOME's break engine, Main.breakManager (shell/breakManager.js);
// - Mutter's core idle monitor, with GNOME's own rule: one 10 s
//   uninhibitable idle watch and, while idle, a one-shot active watch.
//   GNOME's engine never says when an idle period starts (in its "IDLE
//   while working" state going idle changes nothing), so Froonty keeps a
//   watch pair of its own (DESIGN.md §2.1);
// - the top bar's WallClock (shell/dateMenu.js), for suspends without a lock;
// - one GLib one-shot timer at a time (service.js says when).

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import {gettext as _, ngettext} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Emitter} from '../../core/emitter.js';
import {breakManager} from '../../shell/breakManager.js';
import {BreakEngine} from '../../shell/breakEngine.js';
import {topBarWallClock} from '../../shell/dateMenu.js';
import {GnomeBreakSettings} from './gnomeSettings.js';
import {BreakService} from './service.js';
import {BreakStore} from './store.js';
import {cueIcon} from './icons.js';
import {words} from './words.js';

function coreIdle() {
    const monitor = global.backend.get_core_idle_monitor();
    return {
        addIdle: (ms, callback) => monitor.add_idle_watch_full(ms, () => callback(),
            Meta.IdleMonitorWatchFlags.UNINHIBITABLE),
        addActive: callback => monitor.add_user_active_watch(() => callback()),
        remove: id => monitor.remove_watch(id),
        idleTime: () => monitor.get_idletime(),
    };
}

const glibTimer = {
    add: (seconds, callback) => GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
        callback();
        return GLib.SOURCE_REMOVE;
    }),
    remove: id => GLib.source_remove(id),
};

/**
 * The pill's cue: emits 'changed' with the service; current(nowMs) is the
 * cue to show, or null (nothing to remind, cue off, or not loaded yet).
 */
class PillCue extends Emitter {
    constructor(service, settings) {
        super();
        this._service = service;
        this._settings = settings;
        this._id = service.connect('changed', () => this.emit('changed'));
    }

    destroy() {
        this._service.disconnect(this._id);
    }

    current(nowMs = Date.now()) {
        const m = this._service.model(nowMs);
        if (!m.cue)
            return null;
        const w = words({_, ngettext});
        const mode = this._settings.get_string('break-pill-cue');
        const {text, accessibleText} = w.cue(m.cue, mode);
        return {
            rank: m.cue.rank,
            level: m.cue.kind === 'posture' ? 'posture' : m.cue.level,
            gicon: cueIcon(m.cue),
            styleClass: m.cue.kind === 'posture'
                ? 'froonty-pill-cue-posture' : `froonty-pill-cue-level-${m.cue.level}`,
            text,
            accessibleText,
            tab: 'break',
        };
    }
}

let shared = null;
let cue = null;
let users = 0;

/**
 * @param {Gio.Settings} settings Froonty's
 * @returns {{service: BreakService, cue: PillCue}}
 */
export function acquireBreakService(settings) {
    if (!shared) {
        shared = new BreakService(settings, {
            engine: new BreakEngine(breakManager()),
            gnome: onChanged => new GnomeBreakSettings({onChanged}),
            idle: coreIdle(),
            wallClock: topBarWallClock(),
            timer: glibTimer,
            now: () => Date.now(),
            mono: () => GLib.get_monotonic_time(),
            store: new BreakStore(),
            pid: new Gio.Credentials().get_unix_pid(),
        });
        cue = new PillCue(shared, settings);
        shared.start().catch(e => console.warn(`Froonty: break service: ${e.message}`));
    }
    users++;
    return {service: shared, cue};
}

export function releaseBreakService() {
    if (--users > 0)
        return;
    cue?.destroy();
    cue = null;
    shared?.stop();
    shared = null;
    users = 0;
}
