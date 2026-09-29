// SPDX-License-Identifier: GPL-3.0-or-later
// Claude settings tab. Runs in the preferences process (GTK 4 + libadwaita),
// so it imports nothing from the Shell side of the feature.

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

// Makes the bundled Spark an icon name. The folder is laid out as an icon
// theme (icons/hicolor/scalable/actions/): GTK 4.14 recolours a -symbolic
// icon found that way, but not a loose file on the search path.
export function addIconPath() {
    const display = Gdk.Display.get_default();
    const icons = Gio.File.new_for_uri(import.meta.url).get_parent().get_child('icons');
    if (display)
        Gtk.IconTheme.get_for_display(display).add_search_path(icons.get_path());
}

export function claudePage(settings) {
    const page = new Adw.PreferencesPage({
        name: 'claude',
        title: _('Claude'),
        icon_name: 'froonty-claude-symbolic',
    });

    const group = new Adw.PreferencesGroup({
        title: _('Claude'),
        description: _('Your Claude plan’s usage limits and when each resets, as Claude Code last checked them. Froonty reads them from Claude Code’s settings file each time you open the tab; it never contacts Claude itself.'),
    });
    const enabled = new Adw.SwitchRow({title: _('Show the Claude tab')});
    settings.bind('claude-enabled', enabled, 'active', Gio.SettingsBindFlags.DEFAULT);
    group.add(enabled);

    page.add(group);
    return page;
}
