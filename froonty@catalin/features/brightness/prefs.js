// SPDX-License-Identifier: GPL-3.0-or-later
// Settings → Brightness: software display brightness (overlay.js).

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {spinRow, switchRow} from '../../prefs/rows.js';
import {TARGETS} from './levels.js';

export function brightnessPage(settings) {
    const page = new Adw.PreferencesPage({
        name: 'brightness',
        title: _('Brightness'),
        icon_name: 'display-brightness-symbolic',
    });
    const group = new Adw.PreferencesGroup({
        title: _('Software brightness'),
        description: _('For monitors whose brightness GNOME cannot set (no DDC/CI): Froonty ' +
            'darkens them with a black layer, with its own slider in Quick Settings. The ' +
            'backlight stays as it is, so this saves no power. The mouse pointer is not dimmed.'),
    });
    group.add(switchRow(settings, 'brightness-enabled', _('Software brightness'),
        _('A second brightness slider in Quick Settings, under GNOME\'s')));

    const monitorsRow = new Adw.ComboRow({
        title: _('Monitors'),
        model: Gtk.StringList.new([
            _('External monitors'), _('Built-in screen'), _('All monitors'),
        ]),
    });
    // Showing the setting must not write it back (as Clock format, prefs.js).
    let syncing = false;
    const syncMonitorsRow = () => {
        syncing = true;
        monitorsRow.selected = Math.max(TARGETS.indexOf(settings.get_string('brightness-monitors')), 0);
        syncing = false;
    };
    syncMonitorsRow();
    monitorsRow.connect('notify::selected', () => {
        if (!syncing)
            settings.set_string('brightness-monitors', TARGETS[monitorsRow.selected]);
    });
    settings.connect('changed::brightness-monitors', syncMonitorsRow);
    group.add(monitorsRow);

    const minimum = spinRow(settings, 'brightness-min', _('Lowest brightness (%)'), 5);
    minimum.subtitle = _('The slider\'s left end, so a screen never goes black');
    group.add(minimum);

    page.add(group);
    return page;
}
