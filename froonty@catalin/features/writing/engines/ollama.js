// SPDX-License-Identifier: GPL-3.0-or-later
// Writing engine: a local model through Ollama's HTTP API on 127.0.0.1
// (docs/features/writing.md §2, §5). The text never leaves the computer:
// the address is fixed to this computer (only the tests may move it, and
// only to another port on it), and Ollama's cloud models are never
// offered. If Froonty installed Ollama (Settings → Writing) and it is
// stopped, the first click starts its user service.
//
// No St or Gtk.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {actionById, systemPrompt, wrapText, cleanOutput, LIMITS, LONG_TEXT_CHARS} from '../actions.js';
import {WritingError} from '../errors.js';
import {networkFailure, newSession, parseJson, request, sleep, streamNdjson} from '../http.js';
import {defaultPaths, override, SYSTEM_OLLAMA, SYSTEM_OLLAMA_UNITS, UNIT_NAME} from '../paths.js';
import {runProcess} from '../process.js';
import {exists} from '../setup/fs.js';
import {readState} from '../setup/state.js';

export const ID = 'ollama';
export const LOCAL_URL = 'http://127.0.0.1:11434';
const PROBE_TIMEOUT_S = 2;
// Per read: loading a model can take a while, and a stream that stalls
// this long has stopped.
const RUN_TIMEOUT_S = 120;
const START_WAIT_MS = 15 * 1000;
const START_POLL_MS = 500;

/**
 * The cap on one whole request, on top of the per-read timeout: 3 min plus
 * 60 ms per character, so 15 min at the 12,000-character limit. Rewrites
 * answer about as much as they read, and without a graphics card a 3B
 * model writes perhaps 8-20 tokens a second (an estimate, not measured).
 */
export function overallTimeoutMs(chars) {
    return 180 * 1000 + 60 * Math.max(0, chars);
}

export function busyText(chars = 0) {
    return chars > LONG_TEXT_CHARS
        ? 'Rewriting with Ollama (a long text can take several minutes without a graphics card)…'
        : 'Rewriting with Ollama (loading the model can take a while)…';
}

/** Whether `url` is plain HTTP to this computer (127.0.0.1, ::1 or localhost). */
export function isLoopback(url) {
    let uri;
    try {
        uri = GLib.Uri.parse(url, GLib.UriFlags.NONE);
    } catch (e) {
        return false;
    }
    return uri.get_scheme() === 'http' && ['127.0.0.1', '::1', 'localhost'].includes(uri.get_host());
}

/**
 * Ollama's address: 127.0.0.1:11434. Under the tests FROONTY_OLLAMA_URL
 * replaces it, and even then only by an address on this computer.
 */
export function baseUrl() {
    const url = override('FROONTY_OLLAMA_URL') ?? LOCAL_URL;
    if (!isLoopback(url))
        throw new Error(`Ollama's address must be on this computer, not ${url}`);
    return url;
}

/**
 * An Ollama of the user's own: {binary, unit}, each a path or null. The
 * binary in a system folder, on PATH or in ~/.local/bin; the unit is
 * Ollama's system service (its install script adds one, the manual steps
 * may). Under the tests, only inside FROONTY_OLLAMA_SYSTEM_ROOT.
 */
export async function systemOllama() {
    const root = override('FROONTY_OLLAMA_SYSTEM_ROOT');
    const inRoot = path => (root ? `${root}${path}` : path);
    const binaries = SYSTEM_OLLAMA.map(inRoot);
    if (!root) {
        binaries.push(GLib.find_program_in_path('ollama'),
            GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', 'ollama']));
    }
    const first = async paths => {
        for (const path of paths.filter(Boolean)) {
            // eslint-disable-next-line no-await-in-loop
            if (await exists(path))
                return path;
        }
        return null;
    };
    return {binary: await first(binaries), unit: await first(SYSTEM_OLLAMA_UNITS.map(inRoot))};
}

/** Why Ollama cannot be used: not installed, or how to start it. */
export function notRunningError(system) {
    if (!system?.binary) {
        return new WritingError('not-installed', 'Ollama is not installed.',
            'Settings → Writing explains how to set it up.');
    }
    return new WritingError('not-running', 'Ollama is not running.', system.unit
        ? 'Start it with: sudo systemctl start ollama'
        : 'Start it with: ollama serve');
}

export function systemctlPath() {
    return override('FROONTY_SYSTEMCTL') ?? '/usr/bin/systemctl';
}

/** Whether a listed model runs elsewhere (Ollama's cloud models). */
export function isCloudModel(model) {
    const name = String(model?.name ?? model?.model ?? '');
    return Boolean(model?.remote_host || model?.remote_model) ||
        /[-:]cloud$/.test(name);
}

/** The models of /api/tags that run on this computer: [{name, size, digest}]. */
export function localModels(tags) {
    const models = Array.isArray(tags?.models) ? tags.models : [];
    return models.filter(m => !isCloudModel(m) && typeof (m.name ?? m.model) === 'string')
        .map(m => ({
            name: m.name ?? m.model,
            size: Number.isFinite(m.size) ? m.size : null,
            digest: typeof m.digest === 'string' ? m.digest : null,
        }));
}

/** The context window for a text of `chars` characters, in tokens. */
export function numCtx(chars) {
    const tokens = 2.5 * Math.ceil(chars / 3) + 512;
    const rounded = Math.ceil(tokens / 1024) * 1024;
    return Math.min(16384, Math.max(4096, rounded));
}

/** The body of one /api/chat request. */
export function chatBody({model, actionId, message, chars, thinking = false}) {
    const action = actionById(actionId);
    if (!action)
        throw new WritingError('failed', `Unknown action ${actionId}`);
    const body = {
        model,
        stream: true,
        messages: [
            {role: 'system', content: systemPrompt(actionId)},
            {role: 'user', content: message},
        ],
        options: {temperature: action.temperature, num_ctx: numCtx(chars)},
    };
    if (thinking)
        body.think = false;
    return body;
}

/** Ollama's error text as a WritingError. */
export function mapError(status, text, model) {
    const message = String(text ?? '');
    if (status === 404 || /model .*not found|not found, try pulling/i.test(message)) {
        return new WritingError('needs-setup',
            `The model ${model} is not in Ollama. Download it in Settings → Writing.`);
    }
    return new WritingError('failed', `Ollama: ${message.slice(0, 200) || `answered ${status}`}`);
}

function sessions(cache) {
    if (!cache.get('ollama-probe'))
        cache.set('ollama-probe', newSession(PROBE_TIMEOUT_S));
    if (!cache.get('ollama-session'))
        cache.set('ollama-session', newSession(RUN_TIMEOUT_S));
    return {probe: cache.get('ollama-probe'), main: cache.get('ollama-session')};
}

/**
 * Whether Ollama answers, its version, and its local models.
 *
 * @returns {Promise<{running: boolean, version: ?string, models: object[]}>}
 */
export async function probe({url = baseUrl(), cache = new Map(), cancellable = null} = {}) {
    const {probe: session} = sessions(cache);
    try {
        const version = await request(session, 'GET', `${url}/api/version`, {cancellable});
        if (version.status !== 200)
            return {running: false, version: null, models: []};
        const tags = await request(session, 'GET', `${url}/api/tags`, {cancellable});
        return {
            running: true,
            version: parseJson(version.body)?.version ?? null,
            models: tags.status === 200 ? localModels(parseJson(tags.body)) : [],
        };
    } catch (e) {
        if (networkFailure(e) === 'cancelled')
            throw e;
        return {running: false, version: null, models: []};
    }
}

/** Whether Froonty installed Ollama and its user service is there. */
export async function froontyOwned(paths = defaultPaths()) {
    const state = await readState(paths);
    return Boolean(state.ollama?.installedByFroonty && state.ollama.step === 'done' &&
        await exists(paths.unitFile));
}

/**
 * Starts Froonty's own Ollama (its user service) and waits until it
 * answers, at most 15 s.
 */
export async function startOwn({url = baseUrl(), cache = new Map(), cancellable = null,
    run = runProcess, waitMs = START_WAIT_MS} = {}) {
    // Cancelled while Froonty's set-up record was read: nothing is started.
    if (cancellable?.is_cancelled())
        throw new WritingError('cancelled', 'Cancelled.');
    const result = await run({argv: [systemctlPath(), '--user', 'start', UNIT_NAME],
        cancellable, timeoutMs: 20000, label: 'systemctl (Writing)'});
    if (!result.exitOk) {
        throw new WritingError('not-running',
            `Could not start Froonty's Ollama: ${result.stderr.trim().slice(0, 200)}`);
    }
    const {probe: session} = sessions(cache);
    for (let waited = 0; waited <= waitMs; waited += START_POLL_MS) {
        try {
            // eslint-disable-next-line no-await-in-loop
            const answer = await request(session, 'GET', `${url}/api/version`, {cancellable});
            if (answer.status === 200)
                return;
        } catch (e) {
            if (networkFailure(e) === 'cancelled')
                throw new WritingError('cancelled', 'Cancelled.');
        }
        try {
            // eslint-disable-next-line no-await-in-loop
            await sleep(START_POLL_MS, cancellable);
        } catch (e) {
            throw new WritingError('cancelled', 'Cancelled.');
        }
    }
    throw new WritingError('timeout', 'Froonty\'s Ollama did not start in time.');
}

async function thinks(session, url, model, cache, cancellable) {
    const key = `ollama-thinks:${model}`;
    if (!cache.has(key)) {
        const answer = await request(session, 'POST', `${url}/api/show`, {json: {model},
            cancellable});
        if (answer.status !== 200)
            throw mapError(answer.status, parseJson(answer.body)?.error ?? answer.body, model);
        const capabilities = parseJson(answer.body)?.capabilities;
        cache.set(key, Array.isArray(capabilities) && capabilities.includes('thinking'));
    }
    return cache.get(key);
}

/**
 * One rewrite with the model in writing-ollama-model.
 *
 * @param {object} request see claudeCode.js run(); `onBusy(text)` tells
 *   the view when Ollama is being started, and `onPartial(raw, code)`
 *   hands over the reply streamed so far (see actions.js cleanPartial)
 */
export async function run({action, text, settings, cancellable = null, cache = new Map(),
    onBusy = () => {}, onPartial = () => {}, deps = {}}) {
    const {url = baseUrl(), paths = defaultPaths(), run: exec = runProcess,
        overallMs = overallTimeoutMs(text.length), waitMs = START_WAIT_MS,
        system = null} = deps;
    const model = settings.get_string('writing-ollama-model');
    if (!model) {
        throw new WritingError('needs-setup', 'No model chosen.',
            'Choose or download one in Settings → Writing.');
    }
    // An overall cap on top of the per-read timeout.
    const local = new Gio.Cancellable();
    const parentId = cancellable?.connect(() => local.cancel()) ?? 0;
    let timedOut = false;
    let timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, overallMs, () => {
        timer = 0;
        timedOut = true;
        local.cancel();
        return GLib.SOURCE_REMOVE;
    });
    try {
        const state = await probe({url, cache, cancellable: local});
        if (!state.running) {
            if (!await froontyOwned(paths))
                throw notRunningError(system ?? await systemOllama().catch(() => null));
            onBusy('Starting Ollama…');
            await startOwn({url, cache, cancellable: local, run: exec, waitMs});
        }
        onBusy(busyText(text.length));
        const {main} = sessions(cache);
        const thinking = await thinks(main, url, model, cache, local);
        const wrapped = wrapText(text);
        let reply = '';
        let failure = null;
        const status = await streamNdjson(main, 'POST', `${url}/api/chat`, {
            json: chatBody({model, actionId: action, message: wrapped.message, chars: text.length,
                thinking}),
            cancellable: local,
            onObject: object => {
                if (object.error)
                    failure ??= String(object.error);
                else if (typeof object.message?.content === 'string' && object.message.content) {
                    reply += object.message.content;
                    onPartial(reply, wrapped.code);
                }
            },
        });
        if (status !== 200 || failure)
            throw mapError(status, failure ?? `answered ${status}`, model);
        return {text: cleanOutput(reply, wrapped.code, text.includes('```'))};
    } catch (e) {
        if (e instanceof WritingError) {
            if (e.code === 'cancelled' && timedOut)
                throw new WritingError('timeout', 'Ollama did not finish in time.');
            throw e;
        }
        const kind = networkFailure(e);
        if (kind === 'cancelled') {
            throw timedOut ? new WritingError('timeout', 'Ollama did not finish in time.')
                : new WritingError('cancelled', 'Cancelled.');
        }
        if (kind === 'timeout')
            throw new WritingError('timeout', 'Ollama did not answer in time.');
        if (kind === 'refused')
            throw notRunningError(system ?? await systemOllama().catch(() => null));
        throw new WritingError('failed', `Ollama: ${e.message}`);
    } finally {
        if (timer)
            GLib.source_remove(timer);
        if (parentId)
            cancellable.disconnect(parentId);
    }
}

export default {
    id: ID,
    title: 'Ollama',
    cloud: false,
    actions: ['paraphrase', 'grammar', 'shorten', 'formal', 'casual', 'summarise'],
    limit: LIMITS[ID],
    busyText: ({chars = 0} = {}) => busyText(chars),
    destination: settings =>
        `Stays on this computer: Ollama, ${settings.get_string('writing-ollama-model') || 'no model chosen'}`,
    /**
     * Ready when Ollama runs with the chosen model, or when it is
     * Froonty's own (it starts when used). Otherwise why not: no model
     * chosen, the model not downloaded, not running, or not installed.
     */
    async availability({settings, cache = new Map(), deps = {}}) {
        const {paths = defaultPaths()} = deps;
        let url;
        try {
            url = deps.url ?? baseUrl();
        } catch (e) {
            return {ready: false, reason: 'not running'};
        }
        const model = settings.get_string('writing-ollama-model');
        const state = await probe({url, cache});
        if (state.running) {
            if (!model)
                return {ready: false, reason: 'no model chosen'};
            if (state.models.some(m => m.name === model))
                return {ready: true, reason: ''};
            return {ready: false, reason: 'model not downloaded'};
        }
        if (await froontyOwned(paths)) {
            return model ? {ready: true, reason: 'starts when used'}
                : {ready: false, reason: 'no model chosen'};
        }
        const system = deps.system ?? await systemOllama().catch(() => ({binary: null}));
        return {ready: false, reason: system.binary ? 'not running' : 'not installed'};
    },
    run,
};
