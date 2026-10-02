// SPDX-License-Identifier: GPL-3.0-or-later
// Kill Process settings tab: show the tab, how often it reads the
// processes, what is never killed, and the tab's size
// (docs/features/kill-process.md). Runs in the preferences process.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {PROTECTED_NAMES} from './rules.js';

const SIZE_KEYS = ['killprocess-width', 'killprocess-height'];

export function killProcessPage(settings) {
    const page = new Adw.PreferencesPage({
        name: 'killprocess',
        title: _('Kill Process'),
        icon_name: 'process-stop-symbolic',
    });

    const group = new Adw.PreferencesGroup({
        title: _('Kill Process'),
        description: _('Your own processes, busiest first, each with a button to kill it: a click, then a confirmation. A process is asked to quit first; “Force quit” is offered only if it is still running a few seconds later. Other users’ processes are not listed, and Froonty never asks for administrator rights. It reads the processes only while the tab is on screen.'),
    });
    group.add(switchRow(settings, 'killprocess-enabled', _('Show the Kill Process tab')));
    group.add(spinRow(settings, 'killprocess-interval', _('Refresh every (s)')));
    page.add(group);

    const protectedGroup = new Adw.PreferencesGroup({
        title: _('Never killed'),
        description: _('These have a lock instead of a kill button: ending them would end your session or break the desktop.'),
    });
    protectedGroup.add(new Adw.ActionRow({
        title: _('GNOME Shell, and whatever started it'),
        subtitle: _('Froonty runs inside GNOME Shell'),
    }));
    protectedGroup.add(new Adw.ActionRow({
        title: _('Session programs'),
        subtitle: PROTECTED_NAMES.join(', '),
        subtitle_selectable: true,
    }));
    page.add(protectedGroup);
    page.add(sizeGroup(settings));
    return page;
}

// Island size while the Kill Process tab is shown; applies live. As Notes'.
function sizeGroup(settings) {
    const reset = new Gtk.Button({
        label: _('Default size'),
        valign: Gtk.Align.CENTER,
        css_classes: ['flat'],
    });
    const group = new Adw.PreferencesGroup({
        title: _('Size'),
        description: _('Of the island while the Kill Process tab is shown, in logical pixels.'),
        header_suffix: reset,
    });
    group.add(spinRow(settings, 'killprocess-width', _('Width')));
    group.add(spinRow(settings, 'killprocess-height', _('Height')));

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

function switchRow(settings, key, title) {
    const row = new Adw.SwitchRow({title});
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
