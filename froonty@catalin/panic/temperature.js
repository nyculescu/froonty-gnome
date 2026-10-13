// SPDX-License-Identifier: GPL-3.0-or-later
// A thermometer panic button: the selected CPU or GPU temperature in °C,
// overlaid on a thermometer. A click opens Btop.

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {thermometerIcon} from '../features/sysmon/icon.js';
import {panicTemperature, temperatureColor} from '../features/sysmon/panicMetrics.js';

export class TemperatureButton {
    constructor(title, {selectTab, metrics}) {
        this._title = title;
        this._metrics = metrics;
        this.usesMetrics = true;
        this._number = new St.Label({
            style_class: 'froonty-sysmon-temp-number',
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const stack = new St.Widget({
            style_class: 'froonty-sysmon-cpu-stack',
            layout_manager: new Clutter.BinLayout(),
        });
        stack.add_child(new St.Icon({
            style_class: 'froonty-sysmon-cpu-icon',
            gicon: thermometerIcon(),
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        stack.add_child(this._number);
        this.actor = new St.Button({
            style_class: 'froonty-icon-button froonty-panic-button froonty-sysmon-temp',
            accessible_name: title,
            can_focus: true,
            track_hover: true,
            child: stack,
        });
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
