// SPDX-License-Identifier: GPL-3.0-or-later
// A thermometer panic button: the selected CPU or GPU temperature in °C,
// after a thermometer. A click opens Btop.

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {thermometerIcon} from '../features/sysmon/icon.js';
import {panicTemperature, temperatureColor} from '../features/sysmon/panicMetrics.js';
import {valueButton} from './valueButton.js';

export class TemperatureButton {
    constructor(title, {selectTab, metrics}) {
        this._title = title;
        this._metrics = metrics;
        this.usesMetrics = true;
        const {actor, icon, number} = valueButton(title, 'froonty-sysmon-temp', 'froonty-sysmon-temp-number');
        icon.gicon = thermometerIcon();
        this.actor = actor;
        this._number = number;
        this.actor.connect('clicked', () => selectTab('sysmon'));
        this._metricsId = metrics.connect('changed', () => this._sync());
        this._sync();
    }

    destroy() {
        this._metrics.disconnect(this._metricsId);
        this.actor.destroy();
        this.actor = null;
    }

    _sync() {
        const value = panicTemperature(this._metrics.snapshot,
            this._metrics.temperatureSource, this._metrics.loadSource);
        if (value === null) {
            this._number.text = '?';
            this._number.set_style(null);
            this.actor.accessible_name = _('%s: unknown').format(this._title);
            return;
        }
        const rounded = Math.round(value);
        this._number.text = `${rounded}°C`;
        this._number.set_style(`color: ${temperatureColor(value)};`);
        this.actor.accessible_name = _('%s: %d °C').format(this._title, rounded);
    }
}
