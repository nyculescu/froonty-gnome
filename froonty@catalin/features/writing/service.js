// SPDX-License-Identifier: GPL-3.0-or-later
// The Writing tab's state (docs/features/writing.md §6): the text, the
// engine it goes to, one request at a time, and its result or error.
// Text and results are kept in memory only, and dropped by stop() (the
// tab turned off, the screen locked, Froonty disabled).
//
// Nothing is sent but on run(), which the view calls on an action click.
// Which engines are ready is checked when the tab comes on screen, when a
// Writing setting changes, and, while the tab is on screen, when the
// network goes on or off line (Gio.NetworkMonitor's signals); never on a
// timer.
//
// No St: unit-tested with plain gjs and fake engines. Emits 'changed'.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {Emitter} from '../../core/emitter.js';
import {checkSendable, cleanPartial} from './actions.js';
import {describeError} from './errors.js';
import {ENGINES, enabledKey} from './engines/index.js';

export const ENGINE_KEY = 'writing-engine';
const AUTH_KEY = 'claude-code-auth';
// GLib 2.80's NetworkManager backend reports its connectivity check only as
// property notifications; 'network-changed' comes with route changes.
const NETWORK_SIGNALS = ['network-changed', 'notify::connectivity', 'notify::network-available'];
// A streamed reply is redrawn at most this often while it arrives.
const PARTIAL_EVERY_US = 250 * 1000;

const isOnline = network => network?.connectivity === Gio.NetworkConnectivity.FULL;

export class WritingService extends Emitter {
    /**
     * @param {object} options
     * @param {Gio.Settings} options.settings
     * @param {object[]} [options.engines] tests: fakes
     * @param {Function} [options.peekRecorder] () → the Clipboard tab's
     *   recorder or null; never creates one
     */
    constructor({settings, engines = ENGINES, peekRecorder = () => null}) {
        super();
        this._settings = settings;
        this._engines = engines;
        this._peekRecorder = peekRecorder;
        // Gio.NetworkMonitor.get_default() on first use; tests swap it.
        this._network = null;
        // The monitor watched while the tab is on screen, and its handlers.
        this._watched = null;
        this._networkIds = [];
        this._online = null;
        this._active = false;
        this._settingsIds = [];
        // Soup sessions and per-model facts for the service's lifetime,
        // plus the Claude Code sign-in check until the tab is next shown.
        this._cache = new Map();
        this._availability = new Map();
        this._availabilityRun = 0;
        this._runId = 0;
        this._cancellable = null;
        this._stopped = false;

        this.input = '';
        /** 'idle' | 'busy' | 'done' | 'error' */
        this.state = 'idle';
        this.busyText = '';
        /** While busy: {engineId, destination} of the request in flight. */
        this.running = null;
        // While busy: what the engine streamed so far, {raw, code}.
        this._partial = null;
        this._partialShownAt = 0;
        /**
         * {text, changes, moreChanges, notes, attribution, engineId} or
         * null; with `partial: true`, what a stopped run wrote until then.
         */
        this.result = null;
        /** {code, message, hint} or null */
        this.error = null;
        /** A passing remark (e.g. why "From clipboard" put nothing in), or null. */
        this.notice = null;
    }

    get network() {
        this._network ??= Gio.NetworkMonitor.get_default();
        return this._network;
    }

    /** Tests: a fake monitor, watched at once if the tab is on screen. */
    set network(monitor) {
        this._unwatchNetwork();
        this._network = monitor;
        if (this._active && !this._stopped)
            this._watchNetwork();
    }

    start() {
        const keys = [...this._engines.map(e => enabledKey(e.id)), ENGINE_KEY,
            'writing-claude-code-model', 'writing-languagetool-variants', 'writing-ollama-model',
            'clipboard-enabled'];
        for (const key of keys) {
            this._settingsIds.push(this._settings.connect(`changed::${key}`,
                () => this._settingChanged(key)));
        }
    }

    _settingChanged(key) {
        // Switching off the engine a request is running on means stop.
        if (this.state === 'busy' && this.running &&
            key === enabledKey(this.running.engineId) && !this._settings.get_boolean(key))
            this.cancel();
        this.refreshAvailability();
        this.emit('changed');
    }

    stop() {
        this._stopped = true;
        this._active = false;
        this._unwatchNetwork();
        this.cancel();
        for (const id of this._settingsIds)
            this._settings.disconnect(id);
        this._settingsIds = [];
        for (const value of this._cache.values())
            value?.abort?.();
        this._cache.clear();
        this._availabilityRun++;
        this.input = '';
        this._partial = null;
        this.result = null;
        this.error = null;
        this.notice = null;
    }

    /**
     * Shown: readiness is checked again (the sign-in before the next Claude
     * run), and network changes are followed until hidden.
     */
    setActive(active) {
        if (this._stopped)
            return;
        this._active = active;
        if (!active) {
            this._unwatchNetwork();
            return;
        }
        this._cache.delete(AUTH_KEY);
        this._watchNetwork();
        this.refreshAvailability();
    }

    _watchNetwork() {
        if (this._watched)
            return;
        const network = this.network;
        this._watched = network;
        this._online = isOnline(network);
        this._networkIds = NETWORK_SIGNALS.map(signal =>
            network.connect(signal, () => this._networkChanged()));
    }

    _unwatchNetwork() {
        for (const id of this._networkIds)
            this._watched?.disconnect(id);
        this._networkIds = [];
        this._watched = null;
    }

    // Only a change between online and not is worth a new check.
    _networkChanged() {
        const online = isOnline(this._watched);
        if (online === this._online)
            return;
        this._online = online;
        this.refreshAvailability();
    }

    _isEnabled(engine) {
        return this._settings.get_boolean(enabledKey(engine.id));
    }

    /** The switched-on engines, in order: [{id, title, engine, availability}]. */
    get enabledEngines() {
        return this._engines.filter(e => this._isEnabled(e)).map(engine => ({
            id: engine.id,
            title: engine.title,
            engine,
            availability: this._availability.get(engine.id) ??
                {ready: false, reason: 'checking…', checking: true},
        }));
    }

    /** The engine chosen last if it is on, else the first one on; or null. */
    get engine() {
        const enabled = this._engines.filter(e => this._isEnabled(e));
        const chosen = this._settings.get_string(ENGINE_KEY);
        return enabled.find(e => e.id === chosen) ?? enabled[0] ?? null;
    }

    availabilityOf(id) {
        return this._availability.get(id) ?? {ready: false, reason: 'checking…', checking: true};
    }

    /** Another engine; not while a request runs (the line names its destination). */
    select(id) {
        if (this.state === 'busy')
            return;
        if (this._engines.some(e => e.id === id) && this._settings.get_string(ENGINE_KEY) !== id)
            this._settings.set_string(ENGINE_KEY, id);
    }

    /** What the engine in flight has written so far ('' when nothing). */
    get partialText() {
        return this._partial ? cleanPartial(this._partial.raw, this._partial.code) : '';
    }

    // A stopped run keeps what it wrote until then.
    _keepPartial(engineId) {
        const text = this.partialText;
        this._partial = null;
        this.result = text ? {text, partial: true, engineId} : null;
    }

    async refreshAvailability() {
        const run = ++this._availabilityRun;
        const enabled = this._engines.filter(e => this._isEnabled(e));
        const results = await Promise.all(enabled.map(async engine => {
            try {
                return [engine.id, await engine.availability({
                    settings: this._settings,
                    network: this.network,
                    cache: this._cache,
                })];
            } catch (e) {
                return [engine.id, {ready: false, reason: e.message}];
            }
        }));
        if (run !== this._availabilityRun || this._stopped)
            return;
        for (const [id, availability] of results)
            this._availability.set(id, availability);
        this.emit('changed');
    }

    /** The text box changed (the view). */
    setInput(text) {
        if (text === this.input)
            return;
        this.input = text;
        this.notice = null;
        this.emit('changed');
    }

    /**
     * Sends the text to the chosen engine for `actionId`. Does nothing
     * while a request runs, or for an action the engine does not offer.
     */
    async run(actionId) {
        const engine = this.engine;
        if (this.state === 'busy' || this._stopped || !engine || !engine.actions.includes(actionId))
            return;
        // The view's buttons are off then too; nothing goes to an engine not ready.
        if (!this.availabilityOf(engine.id).ready)
            return;
        this.notice = null;
        // The Clipboard tab's hidden password, compared in memory only.
        const check = checkSendable(this.input, engine,
            {hiddenPassword: this._peekRecorder()?.password?.text ?? null});
        if (!check.ok) {
            this.state = 'error';
            this.result = null;
            this.error = {code: check.code, message: check.message, hint: ''};
            this.emit('changed');
            return;
        }
        const runId = ++this._runId;
        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;
        this.state = 'busy';
        this.busyText = engine.busyText({chars: this.input.length});
        this.running = {engineId: engine.id, destination: engine.destination(this._settings)};
        this._partial = null;
        this.result = null;
        this.error = null;
        this.emit('changed');
        try {
            const result = await engine.run({
                action: actionId,
                text: this.input,
                settings: this._settings,
                cancellable,
                network: this.network,
                cache: this._cache,
                onBusy: text => {
                    if (runId === this._runId && this.state === 'busy') {
                        this.busyText = text;
                        this.emit('changed');
                    }
                },
                onPartial: (raw, code) => {
                    if (runId !== this._runId || this.state !== 'busy')
                        return;
                    this._partial = {raw, code};
                    const now = GLib.get_monotonic_time();
                    if (now - this._partialShownAt >= PARTIAL_EVERY_US) {
                        this._partialShownAt = now;
                        this.emit('changed');
                    }
                },
            });
            if (runId !== this._runId || this._stopped)
                return;
            this.result = {...result, engineId: engine.id};
            this.state = 'done';
        } catch (e) {
            if (runId !== this._runId || this._stopped)
                return;
            this.error = describeError(e);
            this.state = this.error.code === 'cancelled' ? 'idle' : 'error';
            // A timeout keeps what was streamed until then.
            this._keepPartial(engine.id);
            if (['not-signed-in', 'api-key', 'not-a-plan'].includes(this.error.code))
                this._cache.delete(AUTH_KEY);
        } finally {
            if (this._cancellable === cancellable)
                this._cancellable = null;
            if (runId === this._runId) {
                this.running = null;
                this._partial = null;
            }
        }
        this.emit('changed');
    }

    /** Stops the request in flight (SIGTERM to Claude Code, Soup aborted). */
    cancel() {
        if (this.state !== 'busy')
            return;
        this._runId++;
        this._cancellable?.cancel();
        this._cancellable = null;
        this.state = 'idle';
        this.error = {code: 'cancelled', message: 'Cancelled.', hint: ''};
        this._keepPartial(this.running?.engineId ?? null);
        this.running = null;
        if (!this._stopped)
            this.emit('changed');
    }

    /**
     * Puts the Clipboard tab's current entry in the box, if it is text.
     * The hidden password is never offered, and no recorder is ever
     * created here (so this never starts recording).
     */
    fromClipboard() {
        if (!this._settings.get_boolean('clipboard-enabled'))
            return;
        const recorder = this._peekRecorder();
        const current = recorder?.currentId ?? null;
        if (!current) {
            this.notice = 'Nothing from the Clipboard history yet: copy the text again, or paste it with Ctrl+V.';
        } else if (recorder.password && current === recorder.password.id) {
            this.notice = 'The clipboard holds a hidden password; it is never offered here.';
        } else {
            const entry = recorder.entries.find(e => e.id === current);
            if (!entry) {
                this.notice = 'Nothing from the Clipboard history yet: copy the text again, or paste it with Ctrl+V.';
            } else if (entry.kind !== 'text') {
                this.notice = 'The clipboard holds an image or files, not text.';
            } else {
                this.input = entry.text;
                this.notice = null;
                if (this.state !== 'busy') {
                    this.state = 'idle';
                    this.error = null;
                    this.result = null;
                }
            }
        }
        this.emit('changed');
    }

    /** Clears the box and the result. */
    clear() {
        if (this.state === 'busy')
            return;
        this.input = '';
        this.result = null;
        this.error = null;
        this.notice = null;
        this.state = 'idle';
        this.emit('changed');
    }
}
