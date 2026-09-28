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

// Feature settings tabs, after the general ones. (Imported here, not via
// features/registry.js: that loads Shell-side modules this process cannot.)
import {notesPage} from './features/notes/prefs.js';

const CLOCK_FORMATS = ['system', '24h', '12h'];

// Tabs, in display order. The window opens on the first one.
const GENERAL_PAGE = 'general';
const APPEARANCE_PAGE = 'appearance';

export default class FroontyPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        // Keep the settings object alive as long as the window.
        window._settings = settings;

        // With more than one page, Adw.PreferencesWindow shows them as tabs
        // (a view switcher in the header bar).
        window.add(this._generalPage(settings));
        window.add(this._appearancePage(settings));
        window.add(notesPage(settings));
        window.visible_page_name = GENERAL_PAGE;
    }

    _generalPage(settings) {
        const page = new Adw.PreferencesPage({
            name: GENERAL_PAGE,
            title: _('General'),
            icon_name: 'emblem-system-symbolic',
        });
        page.add(this._islandGroup(settings));
        page.add(this._clockGroup(settings));
        return page;
    }

    _appearancePage(settings) {
        const page = new Adw.PreferencesPage({
            name: APPEARANCE_PAGE,
            title: _('Appearance'),
            icon_name: 'preferences-desktop-appearance-symbolic',
        });
        page.add(this._sizeGroup(settings));
        page.add(this._animationGroup(settings));
        return page;
    }

    _islandGroup(settings) {
        const group = new Adw.PreferencesGroup({title: _('Island')});
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

    _sizeGroup(settings) {
        const group = new Adw.PreferencesGroup({
            title: _('Size'),
            description: _('In logical pixels. While the top bar clock is hidden, the collapsed island grows to cover it.'),
        });
        group.add(spinRow(settings, 'collapsed-width', _('Collapsed width (minimum)')));
        group.add(spinRow(settings, 'collapsed-height', _('Collapsed height (minimum)')));
        group.add(spinRow(settings, 'expanded-width', _('Expanded width')));
        group.add(spinRow(settings, 'expanded-height', _('Expanded height')));
        group.add(spinRow(settings, 'corner-radius', _('Corner radius')));
        return group;
    }

    _animationGroup(settings) {
        const group = new Adw.PreferencesGroup({title: _('Animation')});
        group.add(spinRow(settings, 'animation-duration', _('Duration (ms)'), 50));
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
