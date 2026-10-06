// SPDX-License-Identifier: GPL-3.0-or-later
// The Ollama engine and model downloads, against a local fake server and a
// fake systemctl only.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import ollama, {baseUrl, chatBody, isLoopback, LOCAL_URL, localModels, maxTokens, modelFor, numCtx,
    overallTimeoutMs, run, startOwn, systemOllama} from '../../froonty@catalin/features/writing/engines/ollama.js';
import {buildRequest, cleanPartial, IDIOMS_SCHEMA, stepsFor} from '../../froonty@catalin/features/writing/actions.js';
import {override} from '../../froonty@catalin/features/writing/paths.js';
import {deleteModel, modelRows, pullModel} from '../../froonty@catalin/features/writing/setup/ollamaModels.js';
import {readState, writeState} from '../../froonty@catalin/features/writing/setup/state.js';
import {newSession} from '../../froonty@catalin/features/writing/http.js';
import {done, eq, ok, test} from './test.js';
import {FakeServer, fakePaths, exists, makeSettings, readFile, rejectsWith, tempDir, writeFile,
    writeScript} from './writing-helpers.js';

const DIGEST = 'a'.repeat(64);
const ndjson = objects => objects.map(o => JSON.stringify(o)).join('\n');

test('only models on this computer are offered', () => {
    eq(localModels({models: [
        {name: 'llama3.2:3b', size: 2019393189, digest: DIGEST},
        {name: 'gpt-oss:120b-cloud', size: 384},
        {name: 'qwen3-coder:480b-cloud'},
        {name: 'deepseek:671b', remote_host: 'https://ollama.com:443', remote_model: 'deepseek'},
        {name: 'x:cloud'},
    ]}), [{name: 'llama3.2:3b', size: 2019393189, digest: DIGEST}]);
    eq(localModels(null), []);
});

test('the context window grows with the text, within 4096-16384', () => {
    eq(numCtx(0), 4096);
    eq(numCtx(1000), 4096);
    eq(numCtx(12000), 11264);
    eq(numCtx(40000), 16384);
});

test('the chat body: the step\'s prompts, streaming; a thinking model thinks apart', () => {
    const [b2] = stepsFor('grammar');
    const request = buildRequest(b2, 'teh cat');
    const body = chatBody({model: 'llama3.2:3b', request, chars: 10});
    eq(body.stream, true);
    eq(body.messages.map(m => m.role), ['system', 'user']);
    eq(body.messages[0].content, b2.system);
    ok(body.messages[0].content.includes('English editor'));
    eq(body.messages[1].content, request.message);
    eq(body.options, {temperature: 0.3, num_ctx: 4096, num_predict: 266});
    eq([maxTokens(0), maxTokens(4000), maxTokens(10, 'idioms')], [256, 4256, 1024],
        'a reply stops at about four times the text');
    eq(body.format, b2.schema, 'held to {"rewrite": "…"}');
    eq('think' in body, false);
    // Asked not to think, Qwen3-4B-Thinking-2507 wrote its reasoning into
    // the reply: a thinking model is asked to think, apart from it.
    eq(chatBody({model: 'qwen3:4b', request, chars: 1, thinking: true}).think, true);
    const idioms = buildRequest(stepsFor('translate')[1], 'x', {translation: 'y'});
    eq(chatBody({model: 'gemma3:4b', request: idioms, chars: 1}).format, IDIOMS_SCHEMA);
});

test('Translate uses its own model when one is chosen', () => {
    const settings = makeSettings();
    settings.set_string('writing-ollama-model', 'qwen3:4b-instruct-2507-q4_K_M');
    eq(modelFor(settings, 'translate'), 'qwen3:4b-instruct-2507-q4_K_M');
    settings.set_string('writing-ollama-translate-model', 'gemma3:4b');
    eq([modelFor(settings, 'translate'), modelFor(settings, 'grammar')],
        ['gemma3:4b', 'qwen3:4b-instruct-2507-q4_K_M']);
    eq(ollama.destination(settings),
        'Stays on this computer: Ollama, qwen3:4b-instruct-2507-q4_K_M (Translate: gemma3:4b)');
});

// The reply the Writing tab showed on 2026-10-05 (qwen3:4b, think: false):
// its reasoning, then </think>, then the result.
const LEAKED = 'We are given a block of text that starts with <<<TEXT-bb4c9d21d7b7>>>.\n' +
    'Task: Fix grammar, spelling and punctuation only.\n\nLet\'s analyze the text:\n' +
    '1. "throughut" -> This is a typo.\n</think>\n\nLet\'s update the PhD thesis path.';

test('reasoning a thinking model leaves in its reply is not shown', async () => {
    const server = ollamaServer({
        'POST /api/show': () => ({body: '{"capabilities":["completion","thinking"]}'}),
        'POST /api/chat': () => ({type: 'application/x-ndjson', body: ndjson([
            {message: {role: 'assistant', content: LEAKED.slice(0, 60)}, done: false},
            {message: {role: 'assistant', content: LEAKED.slice(60)}, done: false},
            {message: {role: 'assistant', content: ''}, done: true}])}),
    });
    try {
        const partials = [];
        const result = await ollamaRun(server, {onPartial: (raw, key) => partials.push(cleanPartial(raw, key))});
        eq(result.text, 'Let\'s update the PhD thesis path.');
        eq(partials.at(-1), 'Let\'s update the PhD thesis path.');
        eq(JSON.parse(server.requests.find(r => r.path === '/api/chat').body).think, true);
    } finally {
        server.close();
    }
});

function ollamaServer(extra = {}) {
    return new FakeServer({
        'GET /api/version': () => ({body: '{"version":"0.35.1"}'}),
        'GET /api/tags': () => ({body: JSON.stringify({models: [
            {name: 'llama3.2:3b', size: 2019393189, digest: DIGEST}]})}),
        'POST /api/show': () => ({body: '{"capabilities":["completion"]}'}),
        'POST /api/chat': () => ({type: 'application/x-ndjson', body: ndjson([
                {message: {role: 'assistant', content: '{"rewrite": "The '}, done: false},
                {message: {role: 'assistant', content: 'cat sat."}'}, done: false},
                {message: {role: 'assistant', content: ''}, done: true, done_reason: 'stop'},
            ])}),
        ...extra,
    });
}

const NO_OLLAMA = {binary: null, unit: null};

function ollamaRun(server, extra = {}) {
    const settings = makeSettings();
    settings.set_string('writing-ollama-model', 'llama3.2:3b');
    return run({action: 'grammar', text: 'teh cat sat', settings,
        deps: {url: server.url, paths: fakePaths(), system: NO_OLLAMA}, ...extra});
}

test('a rewrite: streamed pieces joined, markers dropped', async () => {
    const server = ollamaServer();
    try {
        eq((await ollamaRun(server)).text, 'The cat sat.');
        const chat = server.requests.find(r => r.path === '/api/chat');
        const body = JSON.parse(chat.body);
        eq(body.model, 'llama3.2:3b');
        ok(body.messages[1].content.includes('teh cat sat'));
    } finally {
        server.close();
    }
});

test('an error mid-stream (status 200) fails; a missing model needs set-up', async () => {
    const midStream = ollamaServer({
        'POST /api/chat': () => ({type: 'application/x-ndjson', body: ndjson([
            {message: {content: 'The'}, done: false},
            {error: 'an error was encountered while running the model'}])}),
    });
    try {
        const error = await rejectsWith(ollamaRun(midStream), 'failed');
        ok(error.message.includes('an error was encountered'), error.message);
    } finally {
        midStream.close();
    }
    const missing = ollamaServer({
        'POST /api/show': () => ({status: 404, body: '{"error":"model \'llama3.2:3b\' not found"}'}),
    });
    try {
        await rejectsWith(ollamaRun(missing), 'needs-setup');
    } finally {
        missing.close();
    }
});

test('the overall timeout and cancel end a hanging request', async () => {
    const server = ollamaServer({'POST /api/chat': () => 'hang'});
    try {
        await rejectsWith(ollamaRun(server, {deps: {url: server.url, paths: fakePaths(), overallMs: 300,
            system: NO_OLLAMA}}), 'timeout');
        const cancellable = new Gio.Cancellable();
        const running = ollamaRun(server, {cancellable});
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            cancellable.cancel();
            return GLib.SOURCE_REMOVE;
        });
        await rejectsWith(running, 'cancelled');
    } finally {
        server.close();
    }
});

test('the overall cap grows with the text: 3 min, plus 60 ms a character', () => {
    eq(overallTimeoutMs(0), 180000);
    eq(overallTimeoutMs(12000), 900000, '15 min at the limit');
});

test('a reply streamed and then stalled: the timeout, with what came until then', async () => {
    const server = ollamaServer({
        'POST /api/chat': () => ({chunksThenHang: [
            `${JSON.stringify({message: {content: '{"rewrite": "The cat'}, done: false})}\n`,
            `${JSON.stringify({message: {content: ' sat on'}, done: false})}\n`]}),
    });
    try {
        const partials = [];
        await rejectsWith(ollamaRun(server, {
            onPartial: (raw, key) => partials.push(cleanPartial(raw, key)),
            deps: {url: server.url, paths: fakePaths(), overallMs: 600, system: NO_OLLAMA},
        }), 'timeout');
        eq(partials, ['The cat', 'The cat sat on']);
    } finally {
        server.close();
    }
});

test('not running and not Froonty\'s: not installed, or how to start yours', async () => {
    const refused = system => {
        const settings = makeSettings();
        settings.set_string('writing-ollama-model', 'llama3.2:3b');
        return run({action: 'grammar', text: 'teh', settings,
            deps: {url: 'http://127.0.0.1:1', paths: fakePaths(), system}});
    };
    let error = await rejectsWith(refused(NO_OLLAMA), 'not-installed');
    ok(error.hint.includes('Settings → Writing'), error.hint);
    error = await rejectsWith(refused({binary: '/usr/bin/ollama', unit: '/etc/systemd/system/ollama.service'}),
        'not-running');
    eq(error.hint, 'Start it with: sudo systemctl start ollama');
    error = await rejectsWith(refused({binary: '/usr/local/bin/ollama', unit: null}), 'not-running');
    eq(error.hint, 'Start it with: ollama serve', 'no ollama.service: no systemctl hint');
});

test('readiness: no model chosen, model not downloaded, not running, not installed', async () => {
    const server = ollamaServer();
    const settings = makeSettings();
    const check = (deps = {}) => ollama.availability({settings,
        deps: {url: server.url, paths: fakePaths(), system: NO_OLLAMA, ...deps}});
    try {
        eq(await check(), {ready: false, reason: 'no model chosen'});
        settings.set_string('writing-ollama-model', 'gemma3:1b');
        eq(await check(), {ready: false, reason: 'model not downloaded'});
        settings.set_string('writing-ollama-model', 'llama3.2:3b');
        eq(await check(), {ready: true, reason: ''});
        const off = {url: 'http://127.0.0.1:1'};
        eq(await check(off), {ready: false, reason: 'not installed'});
        eq(await check({...off, system: {binary: '/usr/bin/ollama', unit: null}}),
            {ready: false, reason: 'not running'});
        const paths = fakePaths();
        await ownOllama(paths);
        eq(await check({...off, paths}), {ready: true, reason: 'starts when used'});
        settings.set_string('writing-ollama-model', '');
        eq(await check({...off, paths}), {ready: false, reason: 'no model chosen'});
    } finally {
        server.close();
    }
});

test('your own Ollama is found in the system folders, with its system service', async () => {
    const root = tempDir();
    GLib.setenv('FROONTY_OLLAMA_SYSTEM_ROOT', root, true);
    try {
        eq(await systemOllama(), {binary: null, unit: null});
        writeScript(`${root}/usr/local/bin/ollama`, 'true');
        eq(await systemOllama(), {binary: `${root}/usr/local/bin/ollama`, unit: null});
        writeFile(`${root}/etc/systemd/system/ollama.service`, '[Unit]\n');
        eq((await systemOllama()).unit, `${root}/etc/systemd/system/ollama.service`);
    } finally {
        GLib.unsetenv('FROONTY_OLLAMA_SYSTEM_ROOT');
    }
});

test('Ollama\'s address is on this computer; the test addresses are ignored outside the tests', () => {
    ok(isLoopback('http://127.0.0.1:11434') && isLoopback('http://[::1]:8080') &&
        isLoopback('http://localhost:1'));
    ok(!isLoopback('http://nas:11434') && !isLoopback('https://127.0.0.1:11434') &&
        !isLoopback('http://192.168.1.5:11434') && !isLoopback('not a url'));
    const saved = ['FROONTY_OLLAMA_URL', 'FROONTY_LANGUAGETOOL_URL', 'FROONTY_UNIT_ISOLATED',
        'FROONTY_HEADLESS_TEST'].map(name => [name, GLib.getenv(name)]);
    try {
        GLib.setenv('FROONTY_OLLAMA_URL', 'http://nas:11434', true);
        GLib.setenv('FROONTY_LANGUAGETOOL_URL', 'http://nas:8081/v2/check', true);
        let threw = false;
        try {
            baseUrl();
        } catch (e) {
            threw = true;
        }
        ok(threw, 'under the tests, another host is refused');
        // As in the real Shell and settings window: no test variable set.
        GLib.unsetenv('FROONTY_UNIT_ISOLATED');
        GLib.unsetenv('FROONTY_HEADLESS_TEST');
        eq(baseUrl(), LOCAL_URL, 'a stale FROONTY_OLLAMA_URL is ignored');
        eq(override('FROONTY_LANGUAGETOOL_URL'), null, 'and FROONTY_LANGUAGETOOL_URL');
        eq(override('FROONTY_SYSTEMCTL'), null, 'nothing throws outside the tests');
    } finally {
        for (const [name, value] of saved) {
            if (value === null)
                GLib.unsetenv(name);
            else
                GLib.setenv(name, value, true);
        }
    }
    ok(GLib.getenv('FROONTY_UNIT_ISOLATED'), 'restored');
});

test('Settings → Writing → Model: with none chosen, picking the only model is a change', () => {
    const one = [{name: 'llama3.2:3b', size: 2019393189}];
    // The bug: shown as chosen at row 0, never saved; picking row 0 again
    // emits nothing. Now row 0 is "Choose a model", with no name.
    const empty = modelRows(one, '');
    eq(empty.rows.map(r => [r.kind, r.name]), [['choose', null], ['model', 'llama3.2:3b']]);
    eq(empty.selected, 0);
    ok(empty.rows[empty.selected].name === null, 'what is shown as chosen is not a model');
    const chosen = modelRows(one, 'llama3.2:3b');
    eq([chosen.rows.length, chosen.selected], [1, 0]);
    const missing = modelRows(one, 'gemma3:1b');
    eq(missing.rows.map(r => r.kind), ['model', 'missing']);
    eq(missing.selected, 1);
    eq(modelRows([], ''), {rows: [], selected: -1});
    eq(modelRows([], 'gemma3:1b').rows.map(r => [r.kind, r.name]), [['missing', 'gemma3:1b']]);
});

async function ownOllama(paths) {
    await writeState(paths, {version: 1, ollama: {installedByFroonty: true, prefix: paths.ollamaPrefix,
        unit: paths.unitName, release: 'v0.35.1', asset: 'ollama-linux-amd64.tar.zst',
        sha256: DIGEST, step: 'done', models: []}});
    writeFile(paths.unitFile, '# Created by Froonty\n');
}

test('Froonty\'s own Ollama is started on first use: systemctl --user start, then a wait', async () => {
    const dir = tempDir();
    const log = `${dir}/systemctl.log`;
    GLib.setenv('FROONTY_SYSTEMCTL', writeScript(`${dir}/systemctl`, `echo "$@" >>"${log}"`), true);
    const server = ollamaServer({
        'GET /api/version': () => (exists(log) ? {body: '{"version":"0.35.1"}'} : {status: 503}),
    });
    try {
        const paths = fakePaths();
        await ownOllama(paths);
        const busy = [];
        const settings = makeSettings();
        settings.set_string('writing-ollama-model', 'llama3.2:3b');
        const result = await run({action: 'grammar', text: 'teh cat', settings,
            onBusy: text => busy.push(text), deps: {url: server.url, paths, system: NO_OLLAMA}});
        eq(result.text, 'The cat sat.');
        eq(readFile(log), '--user start froonty-ollama.service\n');
        eq(busy[0], 'Starting Ollama…');
        // A service that never answers: the wait ends, no timer is left.
        GLib.unlink(log);
        const silent = new FakeServer({'GET /api/version': () => ({status: 503})});
        try {
            await rejectsWith(startOwn({url: silent.url, waitMs: 600}), 'timeout');
            // Cancelled before it got there (while setup.json was read):
            // systemctl is never run.
            GLib.unlink(log);
            const cancelled = new Gio.Cancellable();
            cancelled.cancel();
            await rejectsWith(startOwn({url: silent.url, cancellable: cancelled}), 'cancelled');
            eq(exists(log), false, 'no systemctl after Cancel');
        } finally {
            silent.close();
        }
    } finally {
        server.close();
        GLib.unsetenv('FROONTY_SYSTEMCTL');
    }
});

test('a model download: recorded before and after, with its digest', async () => {
    let pulled = false;
    const server = new FakeServer({
        'GET /api/tags': () => ({body: JSON.stringify({models: pulled
            ? [{name: 'gemma3:1b', size: 815000000, digest: DIGEST}] : []})}),
        'POST /api/pull': () => {
            pulled = true;
            return {type: 'application/x-ndjson', body: ndjson([
                {status: 'pulling manifest'},
                {status: 'pulling abc', digest: 'sha256:abc', total: 1000, completed: 250},
                {status: 'pulling abc', digest: 'sha256:abc', total: 1000, completed: 1000},
                {status: 'verifying sha256 digest'},
                {status: 'success'}])};
        },
        'DELETE /api/delete': () => ({body: ''}),
    });
    try {
        const paths = fakePaths();
        const progress = [];
        const session = newSession(5);
        const result = await pullModel({session, url: server.url, paths, name: 'gemma3:1b',
            onProgress: (status, completed, total) => progress.push([status, completed, total])});
        eq(result, {name: 'gemma3:1b', downloaded: true});
        ok(progress.some(([, completed, total]) => completed === 250 && total === 1000));
        const state = await readState(paths);
        eq(state.ollama.installedByFroonty, false);
        eq(state.ollama.models.map(m => [m.name, m.digest, m.step]), [['gemma3:1b', DIGEST, 'done']]);
        eq(JSON.parse(server.requests.find(r => r.path === '/api/pull').body),
            {model: 'gemma3:1b', stream: true});

        // Already there: chosen, not downloaded again, not recorded twice.
        const again = await pullModel({session, url: server.url, paths, name: 'gemma3:1b'});
        eq(again.downloaded, false);
        eq(server.requests.filter(r => r.path === '/api/pull').length, 1);

        await deleteModel({session, url: server.url, name: 'gemma3:1b'});
        eq(JSON.parse(server.requests.find(r => r.method === 'DELETE').body), {model: 'gemma3:1b'});
        await rejectsWith(pullModel({session, url: server.url, paths, name: '../etc'}), 'failed');
    } finally {
        server.close();
    }
});

await done();
