// SPDX-License-Identifier: GPL-3.0-or-later
// Froonty preferences (runs in the separate org.gnome.Shell.Extensions
// process, GTK 4 + libadwaita 1.5 on Ubuntu 24.04).

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {
    ExtensionPreferences,
    gettext as _,
} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const CLOCK_FORMATS = ['system', '24h', '12h'];

export default class FroontyPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        // Keep the settings object alive as long as the window.
        window._settings = settings;

        const page = new Adw.PreferencesPage();
        window.add(page);

        page.add(this._generalGroup(settings));
        page.add(this._clockGroup(settings));
        page.add(this._appearanceGroup(settings));
    }

    _generalGroup(settings) {
        const group = new Adw.PreferencesGroup({title: _('General')});
        group.add(switchRow(settings, 'island-enabled', _('Show island')));
        group.add(switchRow(settings, 'hide-panel-clock', _('Hide top bar clock'),
            _('The island replaces the clock; its calendar menu keeps working')));

        // Read-only for now; a shortcut editor is not worth its size yet.
        // Change with: gsettings set org.gnome.shell.extensions.froonty
        //              toggle-shortcut "['<Super><Alt>i']"
        const shortcutRow = new Adw.ActionRow({
            title: _('Toggle shortcut'),
            use_markup: false,
        });
        const syncShortcutRow = () => {
            const labels = settings.get_strv('toggle-shortcut').map(acceleratorLabel);
            shortcutRow.subtitle = labels.join(', ') || _('Disabled');
        };
        syncShortcutRow();
        settings.connect('changed::toggle-shortcut', syncShortcutRow);
        group.add(shortcutRow);
        return group;
    }

    _clockGroup(settings) {
        const group = new Adw.PreferencesGroup({title: _('Clock')});
        group.add(switchRow(settings, 'show-date', _('Show date when collapsed')));

        const formatRow = new Adw.ComboRow({
            title: _('Clock format'),
            model: Gtk.StringList.new([_('Follow system'), _('24-hour'), _('12-hour')]),
        });
        const syncFormatRow = () => {
            const index = CLOCK_FORMATS.indexOf(settings.get_string('clock-format'));
            formatRow.selected = Math.max(index, 0);
        };
        syncFormatRow();
        formatRow.connect('notify::selected', () => {
            settings.set_string('clock-format', CLOCK_FORMATS[formatRow.selected]);
        });
        settings.connect('changed::clock-format', syncFormatRow);
        group.add(formatRow);
        return group;
    }

    _appearanceGroup(settings) {
        const group = new Adw.PreferencesGroup({
            title: _('Appearance'),
            description: _('Sizes are in logical pixels'),
        });
        group.add(spinRow(settings, 'collapsed-width', _('Collapsed width')));
        group.add(spinRow(settings, 'collapsed-height', _('Collapsed height')));
        group.add(spinRow(settings, 'expanded-width', _('Expanded width')));
        group.add(spinRow(settings, 'expanded-height', _('Expanded height')));
        group.add(spinRow(settings, 'corner-radius', _('Corner radius')));
        group.add(spinRow(settings, 'animation-duration', _('Animation duration (ms)'), 50));
        return group;
    }
}

// "<Super><Alt>i" -> "Super+Alt+I"
function acceleratorLabel(accelerator) {
    const [ok, key, mods] = Gtk.accelerator_parse(accelerator);
    return ok ? Gtk.accelerator_get_label(key, mods) : accelerator;
}

function switchRow(settings, key, title, subtitle = '') {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

// Spin bounds are read from the schema's <range>, so they are defined once.
function spinRow(settings, key, title, step = 1) {
    const [, [lower, upper]] = settings.settings_schema.get_key(key)
        .get_range().recursiveUnpack();
    const row = Adw.SpinRow.new_with_range(lower, upper, step);
    row.title = title;
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}
