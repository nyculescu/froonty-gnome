// SPDX-License-Identifier: GPL-3.0-or-later
import {actionArgv, isInstalled, parseEnabled} from
    '../../froonty@catalin/features/zerotier/cli.js';
import {isNetworkId, networkProblem, normalizeNetworks, notices, parseJsonOutput,
    ZeroTierService} from '../../froonty@catalin/features/zerotier/service.js';
import {done, eq, test} from './test.js';

const BINARIES = {
    systemctl: '/usr/bin/systemctl',
    'zerotier-cli': '/usr/sbin/zerotier-cli',
    pkexec: '/usr/bin/pkexec',
};

// A ZeroTierService over fake commands: `answers` maps 'is-active',
// 'is-enabled', 'info', 'listnetworks' (or a pkexec action) to a result.
function fakeService(answers, binaries = BINARIES) {
    const calls = [];
    const service = new ZeroTierService({
        find: async name => binaries[name] ?? null,
        execute: async argv => {
            calls.push(argv);
            const key = argv[0] === binaries.pkexec ? argv[2]
                : argv[0] === binaries.systemctl ? argv[1] : argv[2];
            return {success: true, stdout: '', stderr: '', ...answers[key]};
        },
    });
    return {service, calls};
}

const RUNNING = {
    'is-active': {stdout: 'active\n'},
    'is-enabled': {stdout: 'enabled\n'},
    info: {stdout: '{"online":true,"address":"0123456789"}'},
    listnetworks: {stdout: '[{"nwid":"8056c2e21c000001","name":"Mesh","status":"OK",' +
        '"type":"PRIVATE","assignedAddresses":["10.0.0.4/24"]}]'},
};

test('accepts only 16-character hexadecimal network IDs', () => {
    eq(isNetworkId('8056c2e21c000001'), true);
    eq(isNetworkId('8056c2e21c00000z'), false);
    eq(isNetworkId('8056c2e21c00001'), false);
});

test('normalizes joined network status and addresses', () => {
    eq(normalizeNetworks([{
        nwid: '8056c2e21c000001',
        name: 'Private mesh',
        status: 'OK',
        type: 'PRIVATE',
        assignedAddresses: ['10.0.0.4/24'],
    }]), [{
        id: '8056c2e21c000001',
        name: 'Private mesh',
        status: 'OK',
        type: 'PRIVATE',
        addresses: ['10.0.0.4/24'],
    }]);
});

test('parses ZeroTier JSON output', () => {
    eq(parseJsonOutput('{"online":true}'), {online: true});
});

test('elevated actions use fixed argv', () => {
    const paths = {pkexec: '/usr/bin/pkexec', systemctl: '/usr/bin/systemctl',
        install: '/usr/bin/install'};
    eq(actionArgv('start', paths), ['/usr/bin/pkexec', '/usr/bin/systemctl',
        'start', 'zerotier-one.service']);
    eq(actionArgv('allow', paths, {name: 'ada', tokenPath: '/home/ada/.zeroTierOneAuthToken'}),
        ['/usr/bin/pkexec', '/usr/bin/install', '-m', '600', '-o', 'ada',
            '/var/lib/zerotier-one/authtoken.secret', '/home/ada/.zeroTierOneAuthToken']);
    for (const action of ['join', 'enable', 'disable']) {
        let rejected = false;
        try {
            actionArgv(action, paths);
        } catch (e) {
            rejected = true;
        }
        eq(rejected, true, action);
    }
});

test('reads start-at-boot from systemctl is-enabled', () => {
    eq(parseEnabled('enabled\n'), true);
    eq(parseEnabled('disabled\n'), false);
    eq(parseEnabled('static\n'), null);
});

test('installed means zerotier-cli is there', async () => {
    eq(await isInstalled(async name => BINARIES[name] ?? null), true);
    eq(await isInstalled(async () => null), false);
});

test('names what is wrong with a network', () => {
    const network = (status, addresses = ['10.0.0.4/24']) => ({status, addresses});
    eq(networkProblem(network('OK')), null);
    eq(networkProblem(network('OK', [])), 'no-address');
    eq(networkProblem(network('ACCESS_DENIED')), 'not-authorized');
    eq(networkProblem(network('REQUESTING_CONFIGURATION')), 'waiting');
    eq(networkProblem(network('SOMETHING_NEW')), 'unknown');
});

test('notices put a missing install first and alone', () => {
    eq(notices({installed: false, serviceActive: false, autostart: false}), ['not-installed']);
    eq(notices({installed: true, serviceActive: false, autostart: false, networks: null}),
        ['stopped', 'no-autostart']);
    eq(notices({installed: true, serviceActive: true, autostart: true, access: false,
        networks: null}), ['no-access']);
    eq(notices({installed: true, serviceActive: true, autostart: null, access: true,
        online: false, networks: []}), ['offline', 'no-networks']);
});

test('service reads node and network details without elevation', async () => {
    const {service, calls} = fakeService(RUNNING);
    await service.start();
    eq(service.state.installed, true);
    eq(service.state.serviceActive, true);
    eq(service.state.autostart, true);
    eq(service.state.access, true);
    eq(service.state.online, true);
    eq(service.state.nodeId, '0123456789');
    eq(service.state.networks[0].name, 'Mesh');
    eq(notices(service.state), []);
    eq(calls.some(argv => argv[0] === BINARIES.pkexec), false);
    service.stop();
});

test('without zerotier-cli the service reports it is not installed', async () => {
    const {service, calls} = fakeService(RUNNING, {systemctl: BINARIES.systemctl});
    await service.start();
    eq(service.state.installed, false);
    eq(calls, []);
    service.stop();
});

test('a service not starting at boot is reported', async () => {
    const {service} = fakeService({...RUNNING, 'is-enabled': {stdout: 'disabled\n'}});
    await service.start();
    eq(notices(service.state), ['no-autostart']);
    service.stop();
});

test('an unreadable auth token keeps the service state and asks for access', async () => {
    const denied = {success: false, stderr: '/usr/sbin/zerotier-cli: authtoken.secret ' +
        'not found or readable in /var/lib/zerotier-one (try again as root)\n'};
    const {service} = fakeService({...RUNNING, info: denied, listnetworks: denied});
    await service.start();
    eq(service.state.serviceActive, true);
    eq(service.state.access, false);
    eq(service.state.networks, null);
    eq(service.state.error, null);
    eq(notices(service.state), ['no-access']);
    service.stop();
});

test('other CLI failures are shown as errors', async () => {
    const {service} = fakeService({...RUNNING, info: {success: false, stderr: 'boom\n'}});
    await service.start();
    eq(service.state.serviceActive, true);
    eq(service.state.error, 'boom');
    service.stop();
});

test('starting uses pkexec, then refreshes the status', async () => {
    const {service, calls} = fakeService({...RUNNING, start: {stdout: ''}});
    eq(await service.startNode(), true);
    eq(calls[0], ['/usr/bin/pkexec', '/usr/bin/systemctl', 'start', 'zerotier-one.service']);
    eq(service.state.serviceActive, true);
    eq(service.state.error, null);
    service.stop();
});

await done();
