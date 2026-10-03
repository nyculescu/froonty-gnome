// SPDX-License-Identifier: GPL-3.0-or-later
// The Break tab's two small files (docs/features/break.md), so what it
// counts survives screen locks (which disable extensions) and reboots:
//
//   ~/.local/share/froonty/break/      mode 0700
//   ├── state.json                     mode 0600: the day so far, posture, …
//   └── history.json                   mode 0600: one record per past day
//
// Only when the user was at the computer or away, and daily totals: no
// keys, no input counts, no app names. Gio async only; no St.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {deleteQuietly, makePrivateDirectory, readText, writePrivate} from '../../core/privateFile.js';

export const FORMAT = 1;
const STATE = 'state.json';
const HISTORY = 'history.json';

/** The default folder: $XDG_DATA_HOME/froonty/break. */
export function defaultFolder() {
    return Gio.File.new_for_path(GLib.build_filenamev(
        [GLib.get_user_data_dir(), 'froonty', 'break']));
}

// One queue for every store (a screen unlock makes a new one while the old
// one's last write may still run), so a load never overtakes a write.
let queue = Promise.resolve();

function enqueue(task) {
    const run = queue.then(task);
    queue = run.catch(() => {});
    return run;
}

async function readJson(file) {
    const text = await readText(file);
    if (text === null)
        return null;
    try {
        const data = JSON.parse(text);
        return data?.format === FORMAT ? data : null;
    } catch (e) {
        return null;
    }
}

export class BreakStore {
    /** @param {Gio.File} folder */
    constructor(folder = defaultFolder()) {
        this.folder = folder;
    }

    get stateFile() {
        return this.folder.get_child(STATE);
    }

    get historyFile() {
        return this.folder.get_child(HISTORY);
    }

    /** The saved state (without `format`), or null: none, unreadable or unknown. */
    loadState() {
        return enqueue(async () => {
            const data = await readJson(this.stateFile);
            if (!data)
                return null;
            const {format: _format, ...state} = data;
            return state;
        });
    }

    /** Past days, newest first; [] when there are none or they are unreadable. */
    loadHistory() {
        return enqueue(async () => {
            const data = await readJson(this.historyFile);
            return Array.isArray(data?.days) ? data.days.filter(validDay) : [];
        });
    }

    saveState(state) {
        const text = JSON.stringify({format: FORMAT, ...state});
        return enqueue(() => this._write(this.stateFile, text));
    }

    saveHistory(days) {
        const text = JSON.stringify({format: FORMAT, days});
        return enqueue(() => this._write(this.historyFile, text));
    }

    forgetHistory() {
        return enqueue(() => deleteQuietly(this.historyFile));
    }

    /** Resolves once every write queued so far has finished. */
    flush() {
        return enqueue(() => {});
    }

    async _write(file, text) {
        await makePrivateDirectory(this.folder);
        await writePrivate(file, new TextEncoder().encode(text));
    }
}

function validDay(day) {
    return typeof day?.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day.day) &&
        Number.isFinite(day.activeSeconds);
}
