// SPDX-License-Identifier: GPL-3.0-or-later
// Notifications settings tab: show the tab, and its size
// (docs/features/notifications.md). Runs in the preferences process.

import Adw from 'gi://Adw';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {sizeGroup, switchRow} from '../../prefs/rows.js';

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
    page.add(sizeGroup(settings, ['notifications-width', 'notifications-height'],
        _('Of the island while the Notifications tab is shown, in logical pixels.')));
    return page;
}
