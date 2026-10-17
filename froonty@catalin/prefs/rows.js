// SPDX-License-Identifier: GPL-3.0-or-later
// Rows and groups the settings tabs share. Runs in the preferences process.

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

/**
 * Puts a feature's bundled icons (the icons folder next to `moduleUrl`) on
 * the icon search path, so they are icon names. The folder is laid out as
 * an icon theme (icons/hicolor/scalable/actions/): GTK 4.14 recolours a
 * -symbolic icon found that way, but not a loose file on the search path.
 *
 * @param {string} moduleUrl import.meta.url of a module in the feature's folder
 */
export function addIconPath(moduleUrl) {
    const display = Gdk.Display.get_default();
    const icons = Gio.File.new_for_uri(moduleUrl).get_parent().get_child('icons');
    if (display)
        Gtk.IconTheme.get_for_display(display).add_search_path(icons.get_path());
}

export function switchRow(settings, key, title, subtitle = '') {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

// Spin bounds are read from the schema's <range>, so they are defined once.
export function spinRow(settings, key, title, step = 1) {
    const [, [lower, upper]] = settings.settings_schema.get_key(key)
        .get_range().recursiveUnpack();
    const row = Adw.SpinRow.new_with_range(lower, upper, step);
    row.title = title;
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

/**
 * A drop-down for a string key that holds one of `values`, shown as `labels`.
 *
 * @param {Gio.Settings} settings Froonty's
 * @param {string} key
 * @param {string} title
 * @param {string[]} values
 * @param {string[]} labels one per value
 */
export function choiceRow(settings, key, title, values, labels) {
    const row = new Adw.ComboRow({title, model: Gtk.StringList.new(labels)});
    // Showing the setting must not write it back: a change made elsewhere
    // (the Shell, gsettings) reaches this process late, and writing back
    // what it shows then would undo a newer one.
    let syncing = false;
    const sync = () => {
        syncing = true;
        row.selected = Math.max(values.indexOf(settings.get_string(key)), 0);
        syncing = false;
    };
    sync();
    row.connect('notify::selected', () => {
        if (!syncing)
            settings.set_string(key, values[row.selected]);
    });
    settings.connect(`changed::${key}`, sync);
    return row;
}

/**
 * A tab's island size, with a "Default size" button; applies live.
 *
 * @param {Gio.Settings} settings Froonty's
 * @param {string[]} keys its width and height keys
 * @param {string} description the group's description
 */
export function sizeGroup(settings, [widthKey, heightKey], description) {
    const keys = [widthKey, heightKey];
    const reset = new Gtk.Button({
        label: _('Default size'),
        valign: Gtk.Align.CENTER,
        css_classes: ['flat'],
    });
    const group = new Adw.PreferencesGroup({
        title: _('Size'),
        description,
        header_suffix: reset,
    });
    group.add(spinRow(settings, widthKey, _('Width')));
    group.add(spinRow(settings, heightKey, _('Height')));

    const sync = () => {
        const defaults = keys.map(key => settings.get_default_value(key).unpack());
        reset.tooltip_text = defaults.join(' × ');
        reset.sensitive = keys.some(key => settings.get_user_value(key) !== null);
    };
    sync();
    keys.forEach(key => settings.connect(`changed::${key}`, sync));
    reset.connect('clicked', () => keys.forEach(key => settings.reset(key)));
    return group;
}
