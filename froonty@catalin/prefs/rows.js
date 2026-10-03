// SPDX-License-Identifier: GPL-3.0-or-later
// Rows and groups the settings tabs share. Runs in the preferences process.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

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
 * A tab's island size, with a "Default size" button; applies live.
 *
 * @param {Gio.Settings} settings Froonty's
 * @param {string[]} keys its width and height keys
 * @param {string} description the group's description
 * @param {Function[]} [cleanups] gets a function that disconnects the
 *   group's settings handlers (else they go with the settings object)
 */
export function sizeGroup(settings, [widthKey, heightKey], description, cleanups = null) {
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
    const ids = keys.map(key => settings.connect(`changed::${key}`, sync));
    cleanups?.push(() => ids.forEach(id => settings.disconnect(id)));
    reset.connect('clicked', () => keys.forEach(key => settings.reset(key)));
    return group;
}
