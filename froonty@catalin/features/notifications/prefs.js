// SPDX-License-Identifier: GPL-3.0-or-later
// Notifications settings tab: show the tab, and its size
// (docs/features/notifications.md). Runs in the preferences process.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const SIZE_KEYS = ['notifications-width', 'notifications-height'];

export function notificationsPage(settings) {
    const page = new Adw.PreferencesPage({
        name: 'notifications',
        title: _('Notifications'),
        icon_name: 'preferences-system-notifications-symbolic',
    });

    const group = new Adw.PreferencesGroup({
        title: _('Notifications'),
        description: _('GNOME’s own notifications, newest first, urgent ones on top. Click one to open it, as in' +
            ' GNOME’s list (for an app that gave it no “open” action, GNOME then opens the app and ' +
            'removes all of that app’s notifications, as its own list does); × dismisses it; Clear ' +
            'all (after a confirmation) dismisses them all. Froonty keeps no copy and never removes ' +
            'one on its own. Opening this tab on purpose marks what it lists as seen, as GNOME’s list' +
            ' does, which clears the unread dot; opening it by hover alone does not. Per-app rules ' +
            'and Do Not Disturb are GNOME’s (Settings → Notifications).'),
    });
    group.add(switchRow(settings, 'notifications-enabled', _('Show the Notifications tab')));
    page.add(group);
    page.add(sizeGroup(settings));
    return page;
}

// Island size while the Notifications tab is shown; applies live. As Kill
// Process's.
function sizeGroup(settings) {
    const reset = new Gtk.Button({
        label: _('Default size'),
        valign: Gtk.Align.CENTER,
        css_classes: ['flat'],
    });
    const group = new Adw.PreferencesGroup({
        title: _('Size'),
        description: _('Of the island while the Notifications tab is shown, in logical pixels. Or drag the open island’s bottom-right corner.'),
        header_suffix: reset,
    });
    group.add(spinRow(settings, 'notifications-width', _('Width')));
    group.add(spinRow(settings, 'notifications-height', _('Height')));

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
