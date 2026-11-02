// SPDX-License-Identifier: GPL-3.0-or-later
// The selected CPU, GPU or RAM load, after its matching system icon. A click
// opens Btop; PanicMetricsService owns sampling while the panic bar is shown.

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {cpuIcon, gpuIcon, memoryIcon} from '../features/sysmon/icon.js';
import {panicLoad} from '../features/sysmon/panicMetrics.js';
import {levelClass} from '../features/sysmon/level.js';
import {valueButton} from './valueButton.js';

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
    // The name comes from the selected source (sourceName), not the title.
    constructor(title, {selectTab, metrics}) {
        this._metrics = metrics;
        this.usesMetrics = true;

        const {actor, icon, number} = valueButton(title, 'froonty-sysmon-cpu', 'froonty-sysmon-cpu-number');
        this.actor = actor;
        this._icon = icon;
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
        const source = this._metrics.loadSource;
        this._icon.gicon = ICONS[source]();
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
