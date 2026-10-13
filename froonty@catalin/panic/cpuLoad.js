// SPDX-License-Identifier: GPL-3.0-or-later
// The selected CPU, GPU or RAM load, over its matching system icon. A click
// opens Btop; PanicMetricsService owns sampling while the panic bar is shown.

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {cpuIcon, gpuIcon, memoryIcon} from '../features/sysmon/icon.js';
import {panicLoad} from '../features/sysmon/panicMetrics.js';
import {levelClass} from '../features/sysmon/level.js';

const ICONS = {cpu: cpuIcon, gpu: gpuIcon, memory: memoryIcon};

function sourceName(source) {
    switch (source) {
    case 'gpu':
        return _('GPU load');
    case 'memory':
        return _('RAM load');
    default:
        return _('CPU load');
    }
}

export class CpuLoadButton {
    constructor(title, {selectTab, metrics}) {
        this._title = title;
        this._metrics = metrics;
        this.usesMetrics = true;

        this._number = new St.Label({
            style_class: 'froonty-sysmon-cpu-number',
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._icon = new St.Icon({
            style_class: 'froonty-sysmon-cpu-icon',
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const stack = new St.Widget({
            style_class: 'froonty-sysmon-cpu-stack',
            layout_manager: new Clutter.BinLayout(),
        });
        stack.add_child(this._icon);
        stack.add_child(this._number);

        this.actor = new St.Button({
            style_class: 'froonty-icon-button froonty-panic-button froonty-sysmon-cpu',
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
        const source = this._metrics.loadSource;
        const icon = ICONS[source] ?? ICONS.cpu;
        this._icon.gicon = icon();
        this.actor.accessible_name = sourceName(source);
        const percent = panicLoad(this._metrics.snapshot, source);
        for (let cell = 1; cell <= 5; cell++)
            this._number.remove_style_class_name(`froonty-sysmon-cell-${cell}`);
        if (percent === null) {
            this._number.text = '?';
            this.actor.accessible_name = _('%s: unknown').format(this.actor.accessible_name);
            return;
        }
        const rounded = Math.round(percent);
        this._number.text = `${rounded}%`;
        this._number.add_style_class_name(levelClass(rounded));
        this.actor.accessible_name = _('%s: %d%%').format(this.actor.accessible_name, rounded);
    }
}
