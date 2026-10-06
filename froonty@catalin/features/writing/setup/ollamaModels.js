// SPDX-License-Identifier: GPL-3.0-or-later
// Settings → Writing → Ollama → "Download model…" (docs/features/writing.md
// §5.3): Ollama's own pull and delete, through its local API. A model
// Froonty downloads is recorded (with its digest) before and after, so
// Remove deletes only that one, and only while it is unchanged. A model
// already there is never downloaded again, nor recorded. No Gtk.

import {WritingError} from '../errors.js';
import {networkFailure, parseJson, request, streamNdjson} from '../http.js';
import {localModels} from '../engines/ollama.js';
import {isModelName, readState, writeState} from './state.js';

/**
 * Sizes as listed on ollama.com on 2026-10-02 (the Qwen3 instruct one as
 * Ollama reported it after a download on 2026-10-05); they may change.
 * The notes come from trying the Writing prompts on 2026-10-05
 * (docs/features/writing.md §3).
 */
export const MODEL_CHOICES = [
    {name: 'qwen3:4b-instruct-2507-q4_K_M', size: '2.5 GB', note: 'best for Fix grammar'},
    {name: 'gemma3:4b', size: '3.3 GB', note: 'multilingual: best for Translate'},
    {name: 'llama3.2:3b', size: '2.0 GB', note: ''},
    {name: 'qwen3:4b', size: '2.5 GB', note: 'thinks first: slow'},
    {name: 'phi4-mini', size: '2.5 GB', note: ''},
    {name: 'granite4:3b', size: '2.1 GB', note: ''},
    {name: 'llama3.2:1b', size: '1.3 GB', note: ''},
    {name: 'gemma3:1b', size: '815 MB', note: ''},
];
export const SIZES_DATE = '2026-10-02';

/**
 * Settings → Writing → Ollama's Model list: its rows and the row shown as
 * chosen. With no model chosen yet, a first row "Choose a model" (no name)
 * is shown as chosen, so picking a model, even the only one, is a change
 * the list reports and saves. A list that showed the first model as
 * chosen while writing-ollama-model stayed empty left Ollama unusable
 * with nothing to fix it. A chosen model that is not there is listed as
 * not downloaded.
 *
 * @param {object[]} models [{name, size}] on this computer
 * @param {string} chosen writing-ollama-model
 * @returns {{rows: {name: ?string, size: ?number, kind: 'choose'|'model'|'missing'}[],
 *   selected: number}} `selected` is -1 when there are no rows
 */
export function modelRows(models, chosen) {
    const rows = (models ?? []).map(m => ({name: m.name, size: m.size ?? null, kind: 'model'}));
    if (chosen && !rows.some(r => r.name === chosen))
        rows.push({name: chosen, size: null, kind: 'missing'});
    if (!rows.length)
        return {rows, selected: -1};
    if (!chosen) {
        rows.unshift({name: null, size: null, kind: 'choose'});
        return {rows, selected: 0};
    }
    return {rows, selected: rows.findIndex(r => r.name === chosen)};
}

/** The local models ([{name, size, digest}]), or null when Ollama does not answer. */
export async function listModels({session, url, cancellable = null}) {
    try {
        const answer = await request(session, 'GET', `${url}/api/tags`, {cancellable});
        return answer.status === 200 ? localModels(parseJson(answer.body)) : null;
    } catch (e) {
        return null;
    }
}

const sameName = (a, b) => a === b || `${a}:latest` === b || a === `${b}:latest`;

async function record(paths, update) {
    const state = await readState(paths);
    state.ollama ??= {
        installedByFroonty: false,
        prefix: null,
        unit: null,
        release: null,
        asset: null,
        sha256: null,
        step: 'done',
        models: [],
    };
    update(state.ollama);
    await writeState(paths, state);
}

/**
 * Downloads `name` with Ollama's /api/pull, recording it in setup.json.
 *
 * @param {object} options
 * @param {Function} [options.onProgress] (status, completed, total)
 * @returns {Promise<{name: string, downloaded: boolean}>} downloaded false
 *   when the model was already there (then nothing is recorded)
 */
export async function pullModel({session, url, paths, name, cancellable = null,
    onProgress = () => {}, now = () => new Date().toISOString()}) {
    if (!isModelName(name))
        throw new WritingError('failed', `Not a model name: ${name}`);
    const before = await listModels({session, url, cancellable});
    if (before === null)
        throw new WritingError('not-running', 'Ollama is not running.');
    const existing = before.find(m => sameName(m.name, name));
    if (existing)
        return {name: existing.name, downloaded: false};

    await record(paths, ollama => {
        ollama.models = ollama.models.filter(m => m.name !== name);
        ollama.models.push({name, digest: null, pulledAt: now(), step: 'pulling'});
    });
    let failure = null;
    let success = false;
    try {
        const status = await streamNdjson(session, 'POST', `${url}/api/pull`, {
            json: {model: name, stream: true},
            cancellable,
            onObject: object => {
                if (object.error) {
                    failure ??= String(object.error);
                    return;
                }
                if (object.status === 'success')
                    success = true;
                onProgress(String(object.status ?? ''), Number(object.completed ?? 0),
                    Number(object.total ?? 0));
            },
        });
        if (status !== 200 && !failure)
            failure = `Ollama answered ${status}`;
    } catch (e) {
        if (networkFailure(e) === 'cancelled') {
            throw new WritingError('cancelled',
                'Cancelled. Ollama deletes the partly downloaded files when it next starts.');
        }
        throw new WritingError('failed', `The download failed: ${e.message}`);
    }
    if (failure || !success)
        throw new WritingError('failed', `Ollama could not download ${name}: ${failure ?? 'no success reported'}`);

    const after = await listModels({session, url, cancellable});
    const model = after?.find(m => sameName(m.name, name));
    if (!model)
        throw new WritingError('failed', `${name} is not listed after the download.`);
    await record(paths, ollama => {
        ollama.models = ollama.models.filter(m => m.name !== name);
        ollama.models.push({name: model.name, digest: model.digest, pulledAt: now(), step: 'done'});
    });
    return {name: model.name, downloaded: true};
}

/** Ollama's /api/delete. A model already gone is fine. */
export async function deleteModel({session, url, name, cancellable = null}) {
    if (!isModelName(name))
        throw new WritingError('failed', `Not a model name: ${name}`);
    let answer;
    try {
        answer = await request(session, 'DELETE', `${url}/api/delete`, {json: {model: name},
            cancellable});
    } catch (e) {
        throw new WritingError('not-running', 'Ollama is not running: start it, then Remove again.');
    }
    if (answer.status !== 200 && answer.status !== 404)
        throw new WritingError('failed', `Ollama could not delete ${name} (${answer.status}).`);
}
