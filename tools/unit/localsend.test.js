// SPDX-License-Identifier: GPL-3.0-or-later
// LocalSend tab (features/localsend/service.js, run.js): its state made
// from the helper's events, with a fake helper and a fake notifier;
// nothing listens on the network.

import {done, eq, makeSettings, ok, test} from './test.js';

import GLib from 'gi://GLib';
import {parseEvent} from '../../froonty@catalin/features/localsend/run.js';
import {
    DEFAULT_PORT, formatSize, helperConfig, liveConfig, LocalSendService, settingsStore, trustedDevices,
    trustedNetworks,
} from '../../froonty@catalin/features/localsend/service.js';

function fakeHelper() {
    const runs = [];
    const start = (config, onEvent, onExit) => {
        const run = {config, onEvent, onExit, sent: [], stopped: false};
        runs.push(run);
        return {send: c => run.sent.push(c), stop: () => {
            run.stopped = true;
        }};
    };
    return {runs, start};
}

function fakeNotifier() {
    const log = [];
    const handlers = new Map();
    return {
        log,
        handlers,
        offer: (offer, h) => {
            log.push(['offer', offer.id]);
            handlers.set(offer.id, h);
        },
        offerGone: id => log.push(['gone', id]),
        received: item => log.push(['received', item.paths.length]),
        interrupted: (sender, reason, kept) => log.push(['interrupted', reason, kept]),
        message: (sender, text) => log.push(['message', sender, text]),
        pin: p => log.push(['pin', p.ip]),
        pinGone: ip => log.push(['pin-gone', ip]),
    };
}

function makeService(store = null) {
    const helper = fakeHelper();
    const notifier = fakeNotifier();
    const laters = [];
    const service = new LocalSendService({
        config: () => ({alias: 'Test', folder: '/tmp/in', port: DEFAULT_PORT, zerotier: true}),
        start: helper.start,
        notifier,
        store,
        later: (seconds, fn) => {
            laters.push(fn);
            return () => laters.splice(laters.indexOf(fn), 1);
        },
    });
    return {service, helper, notifier, laters};
}

test('the configuration: a default name and folder, the settings otherwise', () => {
    const settings = makeSettings();
    eq(helperConfig(settings, {hostName: 'box', downloads: '/home/u/Downloads'}),
        {alias: 'Froonty (box)', port: 53317, zerotier: true, folder: '/home/u/Downloads/LocalSend',
            manual: [], trusted: [], trustedNetworks: [], onlyTrusted: true, pinFirst: true});
    settings.set_string('localsend-alias', '  Desk  ');
    settings.set_string('localsend-folder', '/data/in');
    settings.set_boolean('localsend-zerotier', false);
    const config = helperConfig(settings, {hostName: 'box', downloads: '/d'});
    eq([config.alias, config.folder, config.zerotier], ['Desk', '/data/in', false]);
    eq(liveConfig(settings).folder, '/data/in');
    for (const key of ['localsend-alias', 'localsend-folder', 'localsend-zerotier'])
        settings.reset(key);
    eq(settings.get_boolean('localsend-enabled'), false, 'off by default: it opens a port');
});

test('events: only JSON objects with an event name', () => {
    eq(parseEvent('{"event": "ready"}'), {event: 'ready'});
    eq(parseEvent('[1]'), null);
    eq(parseEvent('not json'), null);
    eq(parseEvent('{"no": "event"}'), null);
    eq(parseEvent(''), null);
});

test('sizes read as in Files', () => {
    eq([formatSize(512), formatSize(2100000), formatSize(34500000), formatSize(-1)],
        ['512 B', '2.1 MB', '35 MB', '']);
});

test('ready, peers, then an offer accepted from the notification', () => {
    const {service, helper, notifier} = makeService();
    service.start();
    eq(service.state.status, 'starting');
    const run = helper.runs[0];
    eq(run.config.alias, 'Test');
    run.onEvent({event: 'ready', alias: 'Test', port: 53317, fingerprint: 'F',
        addresses: [{interface: 'wlo1', address: '10.0.0.2'}]});
    eq(service.state.status, 'ready');
    run.onEvent({event: 'peers', peers: [{fingerprint: 'P', alias: 'iPhone', ip: '10.0.0.9'}]});
    eq(service.state.peers.map(p => p.alias), ['iPhone']);
    run.onEvent({event: 'offer', id: 'o1', sender: 'iPhone', files: [{name: 'a.heic', size: 10}]});
    eq(service.state.offers.length, 1);
    notifier.handlers.get('o1').accept();
    eq(run.sent, [{cmd: 'accept', id: 'o1'}]);
    eq(service.state.offers, []);
    ok(notifier.log.some(([kind, id]) => kind === 'gone' && id === 'o1'), 'the notification goes');
    // A second answer to the same offer is not sent.
    service.decline('o1');
    eq(run.sent.length, 1);
    run.onEvent({event: 'progress', sender: 'iPhone', received: 5, total: 10});
    eq(service.state.receiving, {sender: 'iPhone', received: 5, total: 10});
    run.onEvent({event: 'received', sender: 'iPhone', paths: ['/tmp/in/a.heic']});
    eq([service.state.receiving, service.state.recent[0].paths], [null, ['/tmp/in/a.heic']]);
    ok(notifier.log.some(([kind]) => kind === 'received'));
});

test('an offer that timed out, a message, a cancelled transfer', () => {
    const {service, helper, notifier} = makeService();
    service.start();
    const run = helper.runs[0];
    run.onEvent({event: 'offer', id: 'o1', sender: 'iPhone', files: []});
    run.onEvent({event: 'offer-gone', id: 'o1', reason: 'timeout'});
    eq(service.state.offers, []);
    run.onEvent({event: 'message', sender: 'iPhone', text: 'https://example.org'});
    run.onEvent({event: 'cancelled', sender: 'iPhone', reason: 'sender', paths: ['/tmp/in/x']});
    eq(notifier.log.slice(-2), [['message', 'iPhone', 'https://example.org'], ['interrupted', 'sender', 1]]);
    eq(service.state.recent[0].paths, ['/tmp/in/x'], 'what was saved before the cancel is listed');
});

test('sending: one at a time, then its result', () => {
    const {service, helper} = makeService();
    service.start();
    const run = helper.runs[0];
    run.onEvent({event: 'peers', peers: [{fingerprint: 'P', alias: 'iPhone'}]});
    service.sendTo('P', ['/home/u/a.pdf']);
    eq(service.state.sending, {to: 'iPhone', sent: 0, total: 0, waiting: true});
    service.sendTo('P', ['/home/u/b.pdf']);
    eq(run.sent, [{cmd: 'send', to: 'P', paths: ['/home/u/a.pdf']}], 'not while one is going');
    run.onEvent({event: 'send-failed', reason: 'declined'});
    eq(service.state.sendResult, {ok: false, to: 'iPhone', reason: 'declined'});
    eq(service.state.sending, null);
    service.dismissResult();
    eq(service.state.sendResult, null);
});

test('a helper that stops is restarted a few times; a fatal one is not', () => {
    const {service, helper, laters} = makeService();
    service.start();
    helper.runs[0].onExit(1);
    eq([service.state.status, laters.length], ['failed', 1]);
    laters.shift()();
    eq(helper.runs.length, 2);
    helper.runs[1].onEvent({event: 'fatal', reason: 'port-in-use', port: 53317});
    helper.runs[1].onExit(1);
    eq([service.state.status, service.state.error.reason, laters.length], ['failed', 'port-in-use', 0]);
});

test('the sender gives up while the offer waits: it goes, nothing is received', () => {
    const {service, helper, notifier} = makeService();
    service.start();
    const run = helper.runs[0];
    run.onEvent({event: 'offer', id: 'o1', sender: 'iPhone', files: [{name: 'a.jpg', size: 9}]});
    run.onEvent({event: 'offer-gone', id: 'o1', sender: 'iPhone', reason: 'sender'});
    eq([service.state.offers, service.state.receiving], [[], null]);
    eq(notifier.log.slice(-2), [['gone', 'o1'], ['interrupted', 'sender', 0]]);
    // Gone just as it was accepted: no "Receiving 0%" left behind.
    run.onEvent({event: 'offer', id: 'o2', sender: 'iPhone', files: [{name: 'b.jpg', size: 9}]});
    service.accept('o2');
    run.onEvent({event: 'offer-gone', id: 'o2', sender: 'iPhone', reason: 'sender'});
    eq(service.state.receiving, null);
});

test('trust: the first accepted transfer trusts the device; later ones are accepted at once', () => {
    const settings = makeSettings();
    const {service, helper, notifier} = makeService(settingsStore(settings));
    service.start();
    const run = helper.runs[0];
    run.onEvent({event: 'offer', id: 'o1', sender: 'iPhone', fingerprint: 'FP', files: []});
    eq(notifier.log.filter(([k]) => k === 'offer').length, 1, 'the first one asks');
    service.accept('o1');
    eq(trustedDevices(settings), {FP: 'iPhone'});
    run.onEvent({event: 'offer', id: 'o2', sender: 'iPhone', fingerprint: 'FP', trustedNetwork: true, files: []});
    eq(run.sent.at(-1), {cmd: 'accept', id: 'o2'});
    eq([service.state.offers, notifier.log.filter(([k]) => k === 'offer').length], [[], 1],
        'no question, no notification to answer');
    // Another device, or one without an ID, still asks.
    run.onEvent({event: 'offer', id: 'o3', sender: 'Laptop', fingerprint: 'OTHER', files: []});
    run.onEvent({event: 'offer', id: 'o4', sender: 'Old app', fingerprint: '', files: []});
    eq(service.state.offers.map(o => o.id), ['o3', 'o4']);
    service.accept('o4');
    eq(Object.keys(trustedDevices(settings)), ['FP'], 'no ID: never trusted');
    // The key off: every transfer asks, and accepting trusts nobody.
    settings.set_boolean('localsend-auto-accept', false);
    run.onEvent({event: 'offer', id: 'o5', sender: 'iPhone', fingerprint: 'FP', trustedNetwork: true, files: []});
    service.accept('o3');
    eq([service.state.offers.map(o => o.id), Object.keys(trustedDevices(settings))], [['o5'], ['FP']]);
    settings.set_value('localsend-trusted', new GLib.Variant('a{ss}', {}));
});

test('a new device: the PIN shows, and once entered there it is accepted and trusted', () => {
    const settings = makeSettings();
    const {service, helper, notifier} = makeService(settingsStore(settings));
    service.start();
    const run = helper.runs[0];
    run.onEvent({event: 'pin', ip: '10.40.196.27', sender: 'iPhone', pin: '482913'});
    eq(service.state.pins, [{ip: '10.40.196.27', sender: 'iPhone', pin: '482913'}]);
    run.onEvent({event: 'pin-gone', ip: '10.40.196.27', reason: 'used'});
    eq(service.state.pins, []);
    run.onEvent({event: 'offer', id: 'o1', sender: 'iPhone', fingerprint: 'FP', pinVerified: true,
        trustedNetwork: false, files: [{name: 'a.jpg', size: 1}]});
    eq([run.sent.at(-1), service.state.offers], [{cmd: 'accept', id: 'o1'}, []]);
    eq(trustedDevices(settings), {FP: 'iPhone'});
    eq(notifier.log.filter(([k]) => k === 'offer').length, 0, 'the PIN was the question');
    settings.reset('localsend-trusted');
});

test('a trusted device on an untrusted network still asks', () => {
    const settings = makeSettings();
    const store = settingsStore(settings);
    store.trust('FP', 'iPhone');
    const {service, helper} = makeService(store);
    service.start();
    const run = helper.runs[0];
    run.onEvent({event: 'offer', id: 'o1', sender: 'iPhone', fingerprint: 'FP', trustedNetwork: false, files: []});
    eq(service.state.offers.map(o => o.id), ['o1']);
    run.onEvent({event: 'offer', id: 'o2', sender: 'iPhone', fingerprint: 'FP', trustedNetwork: true, files: []});
    eq(run.sent.at(-1), {cmd: 'accept', id: 'o2'});
    settings.reset('localsend-trusted');
});

test('networks, devices by address and the folder are kept in the settings', () => {
    const settings = makeSettings();
    const {service, helper} = makeService(settingsStore(settings));
    service.start();
    const run = helper.runs[0];
    eq(service.addDevice('not an address'), false);
    eq(service.addDevice(' 10.40.196.27 '), true);
    eq(service.addDevice('10.40.196.27'), true);
    eq(settings.get_strv('localsend-devices'), ['10.40.196.27'], 'once');
    eq(run.sent.at(-1), {cmd: 'add', address: '10.40.196.27'});
    service.trustNetwork('uuid-home', 'Home Wi-Fi');
    eq(trustedNetworks(settings), {'uuid-home': 'Home Wi-Fi'});
    eq(liveConfig(settings).trustedNetworks, ['uuid-home']);
    service.untrustNetwork('uuid-home');
    service.forgetDevice('10.40.196.27');
    service.setFolder('/data/LocalSend');
    eq([trustedNetworks(settings), settings.get_strv('localsend-devices'), liveConfig(settings).folder],
        [{}, [], '/data/LocalSend']);
    service.update({folder: '/x'});
    eq(run.sent.at(-1), {cmd: 'update', folder: '/x'});
    settings.reset('localsend-folder');
});

test('stop: the helper and its pending offers go; events from it are ignored', () => {
    const {service, helper, notifier} = makeService();
    service.start();
    const run = helper.runs[0];
    run.onEvent({event: 'offer', id: 'o1', sender: 'iPhone', files: []});
    service.stop('hidden');
    eq([run.stopped, service.state.status, service.state.offers], [true, 'hidden', []]);
    ok(notifier.log.some(([kind, id]) => kind === 'gone' && id === 'o1'));
    run.onEvent({event: 'ready'});
    run.onExit(0);
    eq(service.state.status, 'hidden');
});

await done();
