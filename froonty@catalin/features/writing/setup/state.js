// SPDX-License-Identifier: GPL-3.0-or-later
// What Froonty's Writing set-up did, so Remove undoes exactly that
// (docs/features/writing.md §5.1):
//
//   ~/.local/share/froonty/writing/setup.json    0600, written before each step
//
//   {"version": 1,
//    "ollama": {"installedByFroonty": true, "prefix": "…/froonty/writing/ollama",
//               "unit": "froonty-ollama.service", "release": "v0.35.1",
//               "asset": "ollama-linux-amd64.tar.zst", "sha256": "<64 hex>",
//               "step": "downloading|verifying|extracting|unit|starting|done",
//               "models": [{"name": "llama3.2:3b", "digest": "<64 hex>",
//                           "pulledAt": "<ISO>", "step": "pulling|done"}]}}
//
// A damaged or unexpected file reads as "nothing recorded": it never
// leads to a deletion. No St or Gtk.

import {ensurePrivateDir, readText, writeAtomic} from './fs.js';

export const STATE_VERSION = 1;
export const INSTALL_STEPS = ['downloading', 'verifying', 'extracting', 'unit', 'starting', 'done'];
export const MODEL_STEPS = ['pulling', 'done'];
export const MODEL_NAME = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9._-]+)?(:[A-Za-z0-9._-]+)?$/;
const DIGEST = /^(sha256:)?[0-9a-f]{64}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export function emptyState() {
    return {version: STATE_VERSION, ollama: null};
}

export function isModelName(name) {
    return typeof name === 'string' && name.length <= 200 && MODEL_NAME.test(name);
}

function validModel(model) {
    if (!model || !isModelName(model.name) || !MODEL_STEPS.includes(model.step))
        return null;
    if (model.digest !== undefined && model.digest !== null && !DIGEST.test(model.digest))
        return null;
    return {
        name: model.name,
        digest: model.digest ?? null,
        pulledAt: typeof model.pulledAt === 'string' ? model.pulledAt : null,
        step: model.step,
    };
}

/**
 * The state as read, checked field by field against Froonty's own paths;
 * anything unexpected gives emptyState().
 *
 * @param {*} data parsed JSON
 * @param {object} paths paths.js defaultPaths() (or a test's)
 */
export function validateState(data, paths) {
    if (!data || data.version !== STATE_VERSION)
        return emptyState();
    const ollama = data.ollama;
    if (ollama === null || ollama === undefined)
        return emptyState();
    if (typeof ollama !== 'object' || !Array.isArray(ollama.models))
        return emptyState();
    const models = ollama.models.map(validModel);
    if (models.some(m => m === null))
        return emptyState();
    const installed = ollama.installedByFroonty === true;
    if (installed) {
        if (ollama.prefix !== paths.ollamaPrefix || ollama.unit !== paths.unitName ||
            !INSTALL_STEPS.includes(ollama.step) ||
            (ollama.sha256 !== null && ollama.sha256 !== undefined && !SHA256.test(ollama.sha256)))
            return emptyState();
    } else if (ollama.installedByFroonty !== false) {
        return emptyState();
    }
    return {
        version: STATE_VERSION,
        ollama: {
            installedByFroonty: installed,
            prefix: installed ? ollama.prefix : null,
            unit: installed ? ollama.unit : null,
            release: installed && typeof ollama.release === 'string' ? ollama.release : null,
            asset: installed && typeof ollama.asset === 'string' ? ollama.asset : null,
            sha256: installed ? ollama.sha256 ?? null : null,
            step: installed ? ollama.step : 'done',
            models,
        },
    };
}

/** The recorded state; emptyState() when missing or damaged. */
export async function readState(paths) {
    const text = await readText(paths.stateFile);
    if (text === null)
        return emptyState();
    try {
        return validateState(JSON.parse(text), paths);
    } catch (e) {
        return emptyState();
    }
}

/** Replaces the state file (0600 in a 0700 folder). */
export async function writeState(paths, state) {
    await ensurePrivateDir(paths.dataDir);
    await writeAtomic(paths.stateFile, `${JSON.stringify(state, null, 1)}\n`, 0o600);
}

/** Whether a recorded step did not finish (an interrupted set-up or pull). */
export function unfinished(state) {
    const ollama = state.ollama;
    if (!ollama)
        return false;
    return (ollama.installedByFroonty && ollama.step !== 'done') ||
        ollama.models.some(m => m.step !== 'done');
}
