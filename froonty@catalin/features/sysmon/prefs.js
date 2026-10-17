// SPDX-License-Identifier: GPL-3.0-or-later
// Btop (system monitor) settings tab: show the tab, how often it reads, and
// which sections it shows (docs/features/sysmon.md).

import Adw from 'gi://Adw';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {addIconPath, choiceRow, sizeGroup, spinRow, switchRow} from '../../prefs/rows.js';
import {BTOP_ICON_NAME} from './icon.js';
import {PANIC_LOAD_KEY, PANIC_TEMP_KEY} from './panicMetrics.js';

export function sysmonPage(settings) {
    addIconPath(import.meta.url);
    const page = new Adw.PreferencesPage({
        name: 'sysmon',
        title: _('Btop'),
        icon_name: BTOP_ICON_NAME,
    });

    const group = new Adw.PreferencesGroup({
        title: _('Btop'),
        description: _('A system monitor: CPU, graphics cards, memory, disks and network. It reads this computer only while the tab is on screen.'),
    });
    group.add(switchRow(settings, 'sysmon-enabled', _('Show the Btop tab')));
    group.add(spinRow(settings, 'sysmon-interval', _('Refresh every (s)')));
    page.add(group);

    const sections = new Adw.PreferencesGroup({
        title: _('Sections'),
        description: _('Sections that are off are not read.'),
    });
    sections.add(switchRow(settings, 'sysmon-show-cpu', _('CPU'),
        _('Model, clock, temperature and load, and each thread')));
    sections.add(switchRow(settings, 'sysmon-show-gpu', _('Graphics cards'),
        _('Load, temperature, power and memory, as far as the driver reports them. NVIDIA cards need nvidia-smi; a card that sleeps is not woken up.')));
    sections.add(switchRow(settings, 'sysmon-show-memory', _('Memory'),
        _('RAM used and cache')));
    sections.add(switchRow(settings, 'sysmon-show-disks', _('Disks'),
        _('Root, swap and the EFI system partition')));
    sections.add(switchRow(settings, 'sysmon-show-network', _('Network'),
        _('Download and upload speed and totals')));
    page.add(sections);
    page.add(panicMetricsGroup(settings));
    page.add(sizeGroup(settings, ['sysmon-width', 'sysmon-height'],
        _('Of the island while the Btop tab is shown, in logical pixels. Below 460 wide, each thread takes a row of its own. Or drag the open island’s bottom-right corner.')));
    return page;
}

function panicMetricsGroup(settings) {
    const group = new Adw.PreferencesGroup({
        title: _('Panic buttons'),
        description: _('Choose what the load and thermometer panic buttons show. The thermometer shows °C; RAM has no general-purpose temperature sensor, so following RAM load it shows the average CPU temperature.'),
    });
    group.add(choiceRow(settings, PANIC_LOAD_KEY, _('Load to show'),
        ['cpu', 'gpu', 'memory'], [_('CPU load'), _('GPU load'), _('RAM usage')]));
    group.add(choiceRow(settings, PANIC_TEMP_KEY, _('Thermometer to show'),
        ['average-cpu', 'max-cpu', 'gpu', 'load-source'],
        [_('Average CPU temperature'), _('Maximum CPU temperature'), _('GPU temperature'),
            _('Follow the load button')]));
    return group;
}
