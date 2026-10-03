// SPDX-License-Identifier: GPL-3.0-or-later
// The Writing tab's service, with fake engines (nothing is sent).
import Gio from 'gi://Gio';

import languageTool from '../../froonty@catalin/features/writing/engines/languageTool.js';
import {WritingError} from '../../froonty@catalin/features/writing/errors.js';
import {WritingService} from '../../froonty@catalin/features/writing/service.js';
import {done, eq, ok, test} from './test.js';
import {FakeNetwork, makeSettings, sleep} from './writing-helpers.js';

// A fake engine: records requests; `answer` decides each one.
function fakeEngine(id, {actions = ['paraphrase', 'grammar'], cloud = true, ready = true} = {}) {
    const engine = {
        id,
        title: id,
        cloud,
        actions,
        limit: {chars: 100},
        requests: [],
        checks: 0,
        ready,
        answer: request => Promise.resolve({text: `${id}: ${request.text}`}),
        busyText: ({chars = 0} = {}) => (chars > 4000 ? `Working long with ${id}…` : `Working with ${id}…`),
        destination: settings => `Sends to ${id} (${settings.get_string('writing-claude-code-model')})`,
        availability() {
            engine.checks++;
            return Promise.resolve(engine.ready ? {ready: true, reason: ''}
                : {ready: false, reason: 'not running'});
        },
        run(request) {
            engine.requests.push(request);
            return engine.answer(request);
        },
    };
    return engine;
}

function setup() {
    const settings = makeSettings();
    const engines = [fakeEngine('claude-code'), fakeEngine('languagetool', {actions: ['grammar']}),
        fakeEngine('ollama', {cloud: false})];
    const service = new WritingService({settings, engines});
    service.network = new FakeNetwork();
    service.start();
    return {settings, engines, service};
}

// A run that waits for release(text) or fail(error).
function pending(engine) {
    const control = {};
    engine.answer = request => new Promise((resolve, reject) => {
        control.request = request;
        control.release = text => resolve({text});
        control.fail = reject;
    });
    return control;
}

test('only the engines switched on are listed, in order', async () => {
    const {settings, service} = setup();
    eq(service.enabledEngines, []);
    eq(service.engine, null);
    settings.set_boolean('writing-ollama-enabled', true);
    settings.set_boolean('writing-claude-code-enabled', true);
    await sleep(10);
    eq(service.enabledEngines.map(e => e.id), ['claude-code', 'ollama']);
    eq(service.enabledEngines.map(e => e.availability.ready), [true, true]);
    service.stop();
});

test('the engine chosen last, or the first one switched on', () => {
    const {settings, service} = setup();
    settings.set_boolean('writing-languagetool-enabled', true);
    settings.set_boolean('writing-ollama-enabled', true);
    eq(service.engine.id, 'languagetool', 'claude-code is chosen but off');
    service.select('ollama');
    eq(settings.get_string('writing-engine'), 'ollama');
    eq(service.engine.id, 'ollama');
    settings.set_boolean('writing-ollama-enabled', false);
    eq(service.engine.id, 'languagetool');
    service.stop();
});

test('a run: busy, then the result; a second run while busy does nothing', async () => {
    const {settings, engines, service} = setup();
    settings.set_boolean('writing-claude-code-enabled', true);
    await service.refreshAvailability();
    let release;
    engines[0].answer = request => new Promise(resolve => {
        release = () => resolve({text: `done: ${request.text}`});
    });
    service.setInput('Hello there');
    const first = service.run('paraphrase');
    eq(service.state, 'busy');
    eq(service.busyText, 'Working with claude-code…');
    service.run('grammar');
    eq(engines[0].requests.length, 1);
    eq(engines[0].requests[0].action, 'paraphrase');
    eq(engines[0].requests[0].text, 'Hello there');
    release();
    await first;
    eq(service.state, 'done');
    eq(service.result.text, 'done: Hello there');
    eq(service.result.engineId, 'claude-code');
    service.stop();
});

test('an action the engine lacks, empty text, a password: nothing is sent', async () => {
    const {settings, engines, service} = setup();
    settings.set_boolean('writing-languagetool-enabled', true);
    await service.refreshAvailability();
    service.setInput('Hello');
    await service.run('paraphrase');
    eq(engines[1].requests.length, 0, 'LanguageTool only fixes grammar');
    service.setInput('   ');
    await service.run('grammar');
    eq([service.state, service.error.code], ['error', 'empty']);
    service.setInput('Kx9vR2mQpL4wTz8!');
    await service.run('grammar');
    eq(service.error.code, 'password');
    eq(engines[1].requests.length, 0);
    service.stop();
});

test('cancel: idle, the engine\'s cancellable cancelled, its late answer ignored', async () => {
    const {settings, engines, service} = setup();
    settings.set_boolean('writing-ollama-enabled', true);
    await service.refreshAvailability();
    let release;
    engines[2].answer = () => new Promise(resolve => {
        release = () => resolve({text: 'too late'});
    });
    service.setInput('Hello');
    const running = service.run('grammar');
    const {cancellable} = engines[2].requests[0];
    service.cancel();
    eq(cancellable.is_cancelled(), true);
    eq([service.state, service.error.code], ['idle', 'cancelled']);
    release();
    await running;
    eq(service.result, null);
    eq(service.state, 'idle');
    service.stop();
});

test('stop() cancels and forgets the text and result', async () => {
    const {settings, engines, service} = setup();
    settings.set_boolean('writing-ollama-enabled', true);
    await service.refreshAvailability();
    service.setInput('Secret plans');
    await service.run('grammar');
    eq(service.result.text, 'ollama: Secret plans');
    engines[2].answer = () => new Promise(() => {});
    service.run('paraphrase');
    const {cancellable} = engines[2].requests[1];
    service.stop();
    eq(cancellable.is_cancelled(), true);
    eq([service.input, service.result], ['', null]);
});

test('shown again: availability is checked again and the sign-in check forgotten', async () => {
    const {settings, engines, service} = setup();
    settings.set_boolean('writing-claude-code-enabled', true);
    await service.refreshAvailability();
    service._cache.set('claude-code-auth', {ok: true});
    const before = engines[0].checks;
    service.setActive(true);
    await sleep(10);
    ok(engines[0].checks > before);
    eq(service._cache.has('claude-code-auth'), false);
    engines[0].ready = false;
    service.setActive(true);
    await sleep(10);
    eq(service.availabilityOf('claude-code'), {ready: false, reason: 'not running'});
    service.stop();
});

test('an engine not ready (or not checked yet) gets nothing', async () => {
    const {settings, engines, service} = setup();
    settings.set_boolean('writing-ollama-enabled', true);
    service.setInput('Hello');
    await service.run('grammar');
    eq(engines[2].requests.length, 0, 'not checked yet');
    engines[2].ready = false;
    await service.refreshAvailability();
    await service.run('grammar');
    eq(engines[2].requests.length, 0, 'not ready');
    eq(service.state, 'idle');
    service.stop();
});

test('a setting change emits changed', async () => {
    const {settings, service} = setup();
    let changes = 0;
    service.connect('changed', () => changes++);
    settings.set_boolean('writing-ollama-enabled', true);
    settings.set_string('writing-ollama-model', 'gemma3:1b');
    ok(changes >= 2);
    service.stop();
    const after = changes;
    settings.set_boolean('writing-ollama-enabled', false);
    await sleep(10);
    eq(changes, after, 'no handlers left after stop()');
});

// Secrets that looksLikePassword lets through (actions.js has the list).
const PASSPHRASE = 'correct horse battery staple';
const API_KEY = `sk-ant-api03-${'Ab3dEf9hIj'.repeat(9)}xyzAA`;

test('the Clipboard tab\'s hidden password, pasted into the box, never reaches a cloud engine', async () => {
    const settings = makeSettings();
    const engines = [fakeEngine('claude-code'), fakeEngine('ollama', {cloud: false})];
    for (const engine of engines)
        engine.limit = {chars: 1000};
    let recorder = null;
    const service = new WritingService({settings, engines, peekRecorder: () => recorder});
    service.network = new FakeNetwork();
    service.start();
    settings.set_boolean('writing-claude-code-enabled', true);
    settings.set_boolean('writing-ollama-enabled', true);
    await service.refreshAvailability();
    for (const secret of [PASSPHRASE, API_KEY, '9f86d081884c7d659a2feaa0c55ad015', 'Tr0ub4d']) {
        // As the Clipboard recorder keeps it: {id, kind, hash, text, reason}.
        recorder = {currentId: 'p1', entries: [],
            password: {id: 'p1', kind: 'password', hash: 'password:x', text: secret, reason: 'hint'}};
        service.select('claude-code');
        service.setInput(secret); // what Ctrl+V or a middle click puts in
        // eslint-disable-next-line no-await-in-loop
        await service.run('paraphrase');
        eq([service.state, service.error?.code], ['error', 'password'], secret);
        service.setInput(`Here it is: ${secret} (do not share)`);
        // eslint-disable-next-line no-await-in-loop
        await service.run('grammar');
        eq(service.error?.code, 'password', `${secret} inside text`);
    }
    eq(engines[0].requests.length, 0, 'nothing reached the cloud engine');
    service.select('ollama');
    await service.run('grammar');
    eq([service.state, engines[1].requests.length], ['done', 1], 'Ollama keeps it on this computer');
    recorder = {currentId: 't1', entries: [], password: null};
    service.select('claude-code');
    service.setInput(PASSPHRASE);
    await service.run('paraphrase');
    eq(service.state, 'done', 'with no hidden password it is ordinary text');
    service.stop();
});

test('the network: watched only while shown; going online checks readiness again', async () => {
    const settings = makeSettings();
    const network = new FakeNetwork(Gio.NetworkConnectivity.LOCAL);
    const service = new WritingService({settings, engines: [languageTool]});
    service.network = network;
    service.start();
    settings.set_boolean('writing-languagetool-enabled', true);
    eq(network.handlers.size, 0, 'nothing watched before the tab is shown');
    service.setActive(true);
    await sleep(10);
    eq(network.handlers.size, 3, 'network-changed, connectivity, network-available');
    eq(service.availabilityOf('languagetool'), {ready: false, reason: 'offline'});
    let changes = 0;
    service.connect('changed', () => changes++);
    network.set(Gio.NetworkConnectivity.FULL);
    await sleep(10);
    eq(service.availabilityOf('languagetool'), {ready: true, reason: ''}, 'back online while shown');
    ok(changes > 0);
    network.set(Gio.NetworkConnectivity.PORTAL);
    await sleep(10);
    eq(service.availabilityOf('languagetool').reason, 'offline');
    service.setActive(false);
    eq(network.handlers.size, 0, 'hidden: not watched');
    service.setActive(true);
    service.setActive(true);
    eq(network.handlers.size, 3, 'shown twice: watched once');
    const other = new FakeNetwork();
    service.network = other;
    eq([network.handlers.size, other.handlers.size], [0, 3], 'a swapped monitor is watched instead');
    service.stop();
    eq(other.handlers.size, 0, 'none left after stop()');
});

test('while a request runs: no other engine, and switching its engine off stops it', async () => {
    const {settings, engines, service} = setup();
    settings.set_boolean('writing-claude-code-enabled', true);
    settings.set_boolean('writing-ollama-enabled', true);
    await service.refreshAvailability();
    const claude = pending(engines[0]);
    service.setInput('Hello');
    const running = service.run('paraphrase');
    eq(service.running, {engineId: 'claude-code', destination: 'Sends to claude-code (haiku)'});
    settings.set_string('writing-claude-code-model', 'sonnet');
    eq(service.running.destination, 'Sends to claude-code (haiku)', 'where this text went');
    service.select('ollama');
    eq([service.engine.id, service.state], ['claude-code', 'busy'], 'no switch mid-run');
    settings.set_boolean('writing-ollama-enabled', false);
    eq(service.state, 'busy', 'another engine switched off: it goes on');
    settings.set_boolean('writing-claude-code-enabled', false);
    eq([service.state, service.error.code], ['idle', 'cancelled'], 'its engine switched off: stopped');
    eq(claude.request.cancellable.is_cancelled(), true);
    claude.release('too late');
    await running;
    eq([service.result, service.running], [null, null]);
    service.stop();
});

test('a stopped run keeps what it streamed: Cancel and a timeout', async () => {
    const {settings, engines, service} = setup();
    settings.set_boolean('writing-ollama-enabled', true);
    await service.refreshAvailability();
    let control = pending(engines[2]);
    service.setInput('Hello there');
    let running = service.run('paraphrase');
    control.request.onPartial('<<<TEXT-c0de>>>\nHi ', 'c0de');
    control.request.onPartial('<<<TEXT-c0de>>>\nHi there, how', 'c0de');
    eq(service.partialText, 'Hi there, how', 'shown while it runs');
    service.cancel();
    eq([service.state, service.result], ['idle', {text: 'Hi there, how', partial: true, engineId: 'ollama'}]);
    control.release('late');
    await running;
    eq(service.result.text, 'Hi there, how', 'a late answer does not replace it');

    control = pending(engines[2]);
    running = service.run('paraphrase');
    eq(service.result, null, 'a new run starts empty');
    control.request.onPartial('Half a rewr', 'c0de');
    control.fail(new WritingError('timeout', 'Ollama did not finish in time.'));
    await running;
    eq([service.state, service.error.code, service.result],
        ['error', 'timeout', {text: 'Half a rewr', partial: true, engineId: 'ollama'}]);

    control = pending(engines[2]);
    running = service.run('paraphrase');
    service.cancel();
    control.release('late');
    await running;
    eq(service.result, null, 'nothing streamed: nothing kept');
    service.stop();
});

test('the busy line names a long wait for a long text', async () => {
    const {settings, engines, service} = setup();
    engines[0].limit = {chars: 20000};
    settings.set_boolean('writing-claude-code-enabled', true);
    await service.refreshAvailability();
    let control = pending(engines[0]);
    service.setInput('short');
    let running = service.run('paraphrase');
    eq(service.busyText, 'Working with claude-code…');
    control.release('ok');
    await running;
    control = pending(engines[0]);
    service.setInput('word '.repeat(1000));
    running = service.run('paraphrase');
    eq(service.busyText, 'Working long with claude-code…');
    control.release('ok');
    await running;
    service.stop();
});

test('From clipboard: text only, never the hidden password, no recorder made', () => {
    const settings = makeSettings();
    let recorder = null;
    const service = new WritingService({settings, engines: [], peekRecorder: () => recorder});
    service.fromClipboard();
    eq(service.notice, null, 'nothing while the Clipboard tab is off');
    settings.set_boolean('clipboard-enabled', true);
    service.fromClipboard();
    ok(service.notice.startsWith('Nothing from the Clipboard history yet'));
    const passwordHolder = {id: 'p1'};
    recorder = {currentId: 'p1', entries: [], get password() {
        return passwordHolder;
    }};
    service.fromClipboard();
    eq(service.notice, 'The clipboard holds a hidden password; it is never offered here.');
    eq(service.input, '');
    recorder = {currentId: 'i1', password: null, entries: [{id: 'i1', kind: 'image'}]};
    service.fromClipboard();
    eq(service.notice, 'The clipboard holds an image or files, not text.');
    recorder = {currentId: 't1', password: null, entries: [{id: 't1', kind: 'text', text: 'Copied words'}]};
    service.setInput('old');
    service.fromClipboard();
    eq([service.input, service.notice], ['Copied words', null]);
});

await done();
