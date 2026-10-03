// SPDX-License-Identifier: GPL-3.0-or-later
// Btop (system monitor) settings tab: show the tab, how often it reads, and
// which sections it shows (docs/features/sysmon.md).

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {BTOP_ICON_NAME} from './icon.js';

const SIZE_KEYS = ['sysmon-width', 'sysmon-height'];

// The tab's icon in the settings window's view switcher.
function addIconPath() {
    const display = Gdk.Display.get_default();
    const icons = Gio.File.new_for_uri(import.meta.url).get_parent().get_child('icons');
    if (display)
        Gtk.IconTheme.get_for_display(display).add_search_path(icons.get_path());
}

export function sysmonPage(settings) {
    addIconPath();
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
    page.add(sizeGroup(settings));
    return page;
}

// Island size while the Btop tab is shown; applies live. As Notes' (notes/prefs.js).
function sizeGroup(settings) {
    const reset = new Gtk.Button({
        label: _('Default size'),
        valign: Gtk.Align.CENTER,
        css_classes: ['flat'],
    });
    const group = new Adw.PreferencesGroup({
        title: _('Size'),
        description: _('Of the island while the Btop tab is shown, in logical pixels. Below 460 wide, each thread takes a row of its own. Or drag the open island’s bottom-right corner.'),
        header_suffix: reset,
    });
    group.add(spinRow(settings, 'sysmon-width', _('Width')));
    group.add(spinRow(settings, 'sysmon-height', _('Height')));

    const sync = () => {
        const defaults = SIZE_KEYS.map(key => settings.get_default_value(key).unpack());
        reset.tooltip_text = defaults.join(' × ');
        reset.sensitive = SIZE_KEYS.some(key => settings.get_user_value(key) !== null);
    };
    sync();
    for (const key of SIZE_KEYS)
        settings.connect(`changed::${key}`, sync);
    reset.connect('clicked', () => SIZE_KEYS.forEach(key => settings.reset(key)));
    return group;
}

function switchRow(settings, key, title, subtitle = '') {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

// Spin bounds are read from the schema's <range>, as in prefs.js.
function spinRow(settings, key, title) {
    const [, [lower, upper]] = settings.settings_schema.get_key(key)
        .get_range().recursiveUnpack();
    const row = Adw.SpinRow.new_with_range(lower, upper, 1);
    row.title = title;
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}
