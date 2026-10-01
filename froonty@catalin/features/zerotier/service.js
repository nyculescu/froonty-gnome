// SPDX-License-Identifier: GPL-3.0-or-later
// Reads the installed ZeroTier for the tab (docs/features/zerotier.md):
// service state from systemctl, node and networks from zerotier-cli with
// the user's own permissions. Networks are joined and left in ZeroTier's
// own tools; only Start/Stop is elevated (pkexec).

import Gio from 'gi://Gio';

import {Emitter} from '../../core/emitter.js';
import {actionArgv, findExecutable, NO_TOKEN, parseEnabled, run, UNIT} from './cli.js';

const NETWORK_ID = /^[0-9a-f]{16}$/i;

export function isNetworkId(value) {
    return NETWORK_ID.test(value);
}

export function parseJsonOutput(text) {
    try {
        return JSON.parse(text);
    } catch (e) {
        throw new Error('ZeroTier returned unreadable status data.');
    }
}

export function normalizeNetworks(networks) {
    if (!Array.isArray(networks))
        throw new Error('ZeroTier returned an unexpected network list.');
    return networks.map(network => ({
        id: String(network.nwid ?? ''),
        name: String(network.name || ''),
        status: String(network.status ?? 'unknown'),
        type: String(network.type ?? ''),
        addresses: Array.isArray(network.assignedAddresses)
            ? network.assignedAddresses.map(String) : [],
    })).filter(network => isNetworkId(network.id));
}

// ZeroTier's network statuses that need the user (or the network's admin).
const NETWORK_PROBLEMS = {
    ACCESS_DENIED: 'not-authorized',
    NOT_FOUND: 'not-found',
    REQUESTING_CONFIGURATION: 'waiting',
    PORT_ERROR: 'port-error',
    CLIENT_TOO_OLD: 'too-old',
    AUTHENTICATION_REQUIRED: 'sign-in',
};

/**
 * What is wrong with a joined network, or null when it works.
 *
 * @returns {?string} a NETWORK_PROBLEMS value, 'no-address' (joined and
 *   authorized but the controller assigned no address) or 'unknown'
 */
export function networkProblem(network) {
    if (network.status === 'OK')
        return network.addresses.length ? null : 'no-address';
    return NETWORK_PROBLEMS[network.status] ?? 'unknown';
}

/**
 * What the tab should tell the user, most important first.
 *
 * @returns {string[]} of 'not-installed', 'stopped', 'no-autostart',
 *   'no-access', 'offline', 'no-networks'
 */
export function notices(state) {
    if (state.installed === false)
        return ['not-installed'];
    const list = [];
    if (state.serviceActive === false)
        list.push('stopped');
    if (state.autostart === false)
        list.push('no-autostart');
    if (state.serviceActive === false)
        return list;
    if (state.access === false)
        list.push('no-access');
    if (state.online === false)
        list.push('offline');
    if (state.networks?.length === 0)
        list.push('no-networks');
    return list;
}

function commandError(result) {
    return result.stderr.trim() || result.stdout.trim() || 'The command failed.';
}

class NoAccessError extends Error {}

export class ZeroTierService extends Emitter {
    constructor({execute = run, find = findExecutable} = {}) {
        super();
        this._execute = execute;
        this._find = find;
        this._cancellable = new Gio.Cancellable();
        this._refreshing = null;
        this.state = {
            /** Whether zerotier-cli is there; null before the first read. */
            installed: null,
            serviceActive: null,
            /** Whether the service starts at boot; null when unknown. */
            autostart: null,
            /** Whether zerotier-cli works for this user; null when unknown. */
            access: null,
            online: null,
            nodeId: null,
            /** Joined networks; null while they cannot be read. */
            networks: null,
            busy: false,
            error: null,
        };
    }

    start() {
        return this.refresh();
    }

    stop() {
        this._cancellable.cancel();
    }

    setActive(active) {
        if (active)
            this.refresh();
    }

    refresh() {
        if (this._refreshing || this.state.busy || this._cancellable.is_cancelled())
            return this._refreshing;

        this._refreshing = this._readState().then(state => {
            this.state = {...this.state, error: null, ...state};
        }).catch(error => {
            if (!this._cancellable.is_cancelled())
                this.state = {...this.state, error: error.message};
        }).finally(() => {
            this._refreshing = null;
            this.emit('changed');
        });
        return this._refreshing;
    }

    startNode() {
        return this._act('start');
    }

    stopNode() {
        return this._act('stop');
    }

    async _readState() {
        const cli = await this._find('zerotier-cli');
        if (!cli) {
            return {installed: false, serviceActive: null, autostart: null, access: null,
                online: null, nodeId: null, networks: null};
        }

        const systemctl = await this._find('systemctl');
        let serviceActive = null;
        let autostart = null;
        if (systemctl) {
            const active = await this._execute([systemctl, 'is-active', UNIT], this._cancellable);
            const status = active.stdout.trim();
            if (status === 'active')
                serviceActive = true;
            else if (status === 'inactive' || status === 'failed')
                serviceActive = false;
            const enabled = await this._execute([systemctl, 'is-enabled', UNIT],
                this._cancellable);
            autostart = parseEnabled(enabled.stdout);
        }
        const service = {installed: true, serviceActive, autostart};
        if (serviceActive === false)
            return {...service, access: null, online: false, nodeId: null, networks: null};

        // systemctl's answer stands when the node cannot be read.
        try {
            return {...service, serviceActive: serviceActive ?? true, access: true,
                ...await this._readNode(cli)};
        } catch (error) {
            if (this._cancellable.is_cancelled())
                throw error;
            const unread = {...service, online: null, nodeId: null, networks: null};
            if (error instanceof NoAccessError)
                return {...unread, access: false};
            return {...unread, access: null, error: error.message};
        }
    }

    async _readNode(cli) {
        const info = await this._cli(cli, 'info');
        const networks = await this._cli(cli, 'listnetworks');
        return {
            online: typeof info.online === 'boolean' ? info.online : null,
            nodeId: typeof info.address === 'string' ? info.address : null,
            networks: normalizeNetworks(networks),
        };
    }

    async _cli(cli, command) {
        const result = await this._execute([cli, '-j', command], this._cancellable);
        if (!result.success) {
            const message = commandError(result);
            throw NO_TOKEN.test(message) ? new NoAccessError(message) : new Error(message);
        }
        return parseJsonOutput(result.stdout);
    }

    async _act(action) {
        if (this.state.busy || this._cancellable.is_cancelled())
            return false;

        let argv;
        try {
            argv = actionArgv(action, {
                pkexec: await this._find('pkexec'),
                systemctl: await this._find('systemctl'),
            });
        } catch (error) {
            this.state = {...this.state, error: error.message};
            this.emit('changed');
            return false;
        }

        this.state = {...this.state, busy: true, error: null};
        this.emit('changed');
        let succeeded = false;
        try {
            const result = await this._execute(argv, this._cancellable);
            if (!result.success)
                throw new Error(commandError(result));
            succeeded = true;
        } catch (error) {
            if (!this._cancellable.is_cancelled())
                this.state = {...this.state, error: error.message};
        } finally {
            this.state = {...this.state, busy: false};
            this.emit('changed');
        }
        if (succeeded)
            await this.refresh();
        return succeeded;
    }
}
