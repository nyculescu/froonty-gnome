// SPDX-License-Identifier: GPL-3.0-or-later
// The System widget's sampling: Btop's sampler, reading only what the
// chosen metrics need, every widgets-system-interval seconds while the
// widget shows, and each metric's readings of the last
// widgets-system-period minutes.

import {SystemSampling} from '../../sysmon/panicMetrics.js';
import {History, MINUTE_MS, chosenMetrics, systemNeeds} from './metrics.js';

export const METRICS_KEY = 'widgets-system-metrics';
export const INTERVAL_KEY = 'widgets-system-interval';
export const PERIOD_KEY = 'widgets-system-period';
export const AVERAGE_KEY = 'widgets-system-average';
export const LAYOUT_KEY = 'widgets-system-layout';

// Module state, so it outlives a screen lock: GNOME disables extensions
// then and the desktop card goes with them, but modules stay loaded. It is
// dropped when the widget is switched off (forgetHistory).
const histories = new Map();

export function forgetHistory() {
    histories.clear();
}

export class SystemHistoryService extends SystemSampling {
    /**
     * @param {Gio.Settings} settings
     * @param {object} [options] SystemSampling's, and wallNow() in ms
     */
    constructor(settings, options = {}) {
        super(options);
        this._settings = settings;
        this._wallNow = options.wallNow ?? (() => Date.now());
        this._readSettings();
        this._settingsIds = [METRICS_KEY, INTERVAL_KEY].map(key =>
            settings.connect(`changed::${key}`, () => {
                this._readSettings();
                this._restart();
            }));
        // How it is drawn: no new reading needed, only a redraw.
        this._settingsIds.push(...[PERIOD_KEY, AVERAGE_KEY, LAYOUT_KEY].map(key =>
            settings.connect(`changed::${key}`, () => {
                this._readSettings();
                this._redrawOnly = true;
                this.emit('changed');
                this._redrawOnly = false;
            })));
        // Connected before any view, so a view always draws what was recorded.
        this._changedId = this.connect('changed', () => this._record());
    }

    /** The chosen metrics, in the catalog's order. */
    get metrics() {
        return this._metrics;
    }

    /** @returns {?History} */
    history(id) {
        return histories.get(id) ?? null;
    }

    stop() {
        this.setActive(false);
        for (const id of this._settingsIds)
            this._settings.disconnect(id);
        this._settingsIds = [];
        this.disconnect(this._changedId);
    }

    _readSettings() {
        this._metrics = chosenMetrics(this._settings.get_strv(METRICS_KEY));
        const {sections, cores} = systemNeeds(this._metrics);
        this.sections = new Set(sections);
        this.cores = cores;
        this.interval = this._settings.get_int(INTERVAL_KEY);
        /** The span the graph and the low and high cover. */
        this.periodMs = this._settings.get_int(PERIOD_KEY) * MINUTE_MS;
        /** The moving average's window; 0, the readings as they are. */
        const average = this._settings.get_string(AVERAGE_KEY);
        this.averageMs = average === 'off' ? 0 : Number(average) * 1000 || 0;
        this.layout = this._settings.get_string(LAYOUT_KEY);
        const now = this._wallNow();
        for (const [id, history] of [...histories]) {
            if (!this._metrics.some(metric => metric.id === id))
                histories.delete(id);
            else
                history.prune(now, this.periodMs);
        }
    }

    _record() {
        if (!this.snapshot || this._redrawOnly)
            return;
        const now = this._wallNow();
        for (const metric of this._metrics) {
            let history = histories.get(metric.id);
            if (!history) {
                history = new History();
                histories.set(metric.id, history);
            }
            history.add(now, metric.value(this.snapshot), this.periodMs);
        }
    }
}
