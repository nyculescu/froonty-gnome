// SPDX-License-Identifier: GPL-3.0-or-later
// Fan settings tab: show the tab, how often it reads, and where llano.py
// is (docs/features/fan.md).

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {FAN_ICON_NAME} from './icon.js';

// The tab's icon in the settings window's view switcher.
function addIconPath() {
    const display = Gdk.Display.get_default();
    const icons = Gio.File.new_for_uri(import.meta.url).get_parent().get_child('icons');
    if (display)
        Gtk.IconTheme.get_for_display(display).add_search_path(icons.get_path());
}

export function fanPage(settings) {
    addIconPath();
    const page = new Adw.PreferencesPage({
        name: 'fan',
        title: _('Fan'),
        icon_name: FAN_ICON_NAME,
    });

    const group = new Adw.PreferencesGroup({
        title: _('Fan'),
        description: _('The llano V12 Ultra cooling pad: its speed, set by hand or handed back to its roller, and the CPU and GPU temperatures over the last five minutes. It reads them only while the tab is on screen.'),
    });
    const show = new Adw.SwitchRow({title: _('Show the Fan tab')});
    settings.bind('fan-enabled', show, 'active', Gio.SettingsBindFlags.DEFAULT);
    group.add(show);

    const [, [lower, upper]] = settings.settings_schema.get_key('fan-interval')
        .get_range().recursiveUnpack();
    const interval = Adw.SpinRow.new_with_range(lower, upper, 1);
    interval.title = _('Refresh every (s)');
    settings.bind('fan-interval', interval, 'value', Gio.SettingsBindFlags.DEFAULT);
    group.add(interval);
    page.add(group);

    const pad = new Adw.PreferencesGroup({
        title: _('Pad'),
        description: _('The tab runs llano.py from llano-v12-linux with /usr/bin/python3. The pad needs that project’s udev rule (contrib/70-llano.rules) for access without a password.'),
    });
    const script = new Adw.EntryRow({title: _('llano.py')});
    settings.bind('fan-llano-path', script, 'text', Gio.SettingsBindFlags.DEFAULT);
    pad.add(script);
    const lut = new Adw.EntryRow({title: _('Recommendation table (fan_lut.json)')});
    settings.bind('fan-lut-path', lut, 'text', Gio.SettingsBindFlags.DEFAULT);
    pad.add(lut);
    page.add(pad);
    return page;
}
