// SPDX-License-Identifier: GPL-3.0-or-later
// Settings → Widgets → System: which of Btop's readings the System widget
// shows (each read only while chosen), how often it reads them, the span
// of history, a moving average, and the order of each row's parts.

import Adw from 'gi://Adw';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {choiceRow, spinRow} from '../../../prefs/rows.js';
import {LAYOUTS, SYSTEM_METRICS} from './metrics.js';

const METRICS_KEY = 'widgets-system-metrics';

export function systemGroup(settings) {
    const group = new Adw.PreferencesGroup({
        title: _('System'),
        description: _('Btop’s readings on the desktop, each with its recent history. Only the chosen ones are read, and only while the widget is on the desktop. Graphics card readings run nvidia-smi on an NVIDIA card and may keep it awake. Its width is set under On the desktop.'),
    });
    const rows = SYSTEM_METRICS.map(metric => {
        const row = new Adw.SwitchRow({title: metric.title(_)});
        row.connect('notify::active', () => {
            const chosen = new Set(settings.get_strv(METRICS_KEY));
            if (row.active === chosen.has(metric.id))
                return;
            if (row.active)
                chosen.add(metric.id);
            else
                chosen.delete(metric.id);
            settings.set_strv(METRICS_KEY, SYSTEM_METRICS.map(m => m.id).filter(id => chosen.has(id)));
        });
        group.add(row);
        return [metric.id, row];
    });
    const sync = () => {
        const chosen = new Set(settings.get_strv(METRICS_KEY));
        for (const [id, row] of rows)
            row.active = chosen.has(id);
    };
    settings.connect(`changed::${METRICS_KEY}`, sync);
    sync();
    const interval = spinRow(settings, 'widgets-system-interval', _('Refresh interval (s)'));
    interval.subtitle = _('Each reading joins the history');
    group.add(interval);

    const period = spinRow(settings, 'widgets-system-period', _('History (minutes)'));
    period.subtitle = _('What each graph, and its low and high, cover');
    group.add(period);

    const average = choiceRow(settings, 'widgets-system-average', _('Moving average'),
        ['off', '30', '60', '120', '300'],
        [_('Off'), _('30 seconds'), _('1 minute'), _('2 minutes'), _('5 minutes')]);
    average.subtitle = _('Smooths the graphs, so quick swings do not hide the trend; the value is still the latest');
    group.add(average);

    const label = {value: _('Value'), name: _('Name'), graph: _('Graph')};
    group.add(choiceRow(settings, 'widgets-system-layout', _('Order in each row'), LAYOUTS,
        LAYOUTS.map(layout => layout.split('-').map(part => label[part]).join(' · '))));
    return group;
}
