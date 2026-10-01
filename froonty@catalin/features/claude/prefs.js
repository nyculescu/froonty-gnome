// SPDX-License-Identifier: GPL-3.0-or-later
// Claude settings tab. Runs in the preferences process (GTK 4 + libadwaita),
// so it imports nothing from the Shell side of the feature.

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {
    claudeSettingsFile, installStatusLine, readClaudeSettings, removeStatusLine, statusLineState,
} from './statusLineSetup.js';

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
        description: _('Your Claude plan’s usage limits and when each resets. Froonty reads what Claude Code last checked each time you open the tab; it never signs in to Claude itself.'),
    });
    const enabled = new Adw.SwitchRow({title: _('Show the Claude tab')});
    settings.bind('claude-enabled', enabled, 'active', Gio.SettingsBindFlags.DEFAULT);
    group.add(enabled);

    page.add(group);
    page.add(freshnessGroup(settings));
    return page;
}

// How new numbers arrive: Claude Code's /usage on open (A), and the status
// line after each Claude Code reply (B). See docs/features/claude.md.
function freshnessGroup(settings) {
    const group = new Adw.PreferencesGroup({
        title: _('Fresh usage'),
        description: _('Claude Code saves your usage only when it checks it. Froonty can ask it to, and its status line brings in Session and Weekly after each Claude Code reply.'),
    });

    const ask = new Adw.SwitchRow({
        title: _('Ask Claude Code for fresh usage'),
        subtitle: _('When the Claude tab or its panic button comes on screen, run Claude Code’s /usage, at most once a minute. It uses no plan usage. Turns off by itself in Power Saver mode or below 20% on battery, and back on when that ends if it turned itself off; turning it on meanwhile is kept.'),
    });
    settings.bind('claude-ask-claude-code', ask, 'active', Gio.SettingsBindFlags.DEFAULT);
    group.add(ask);

    const row = new Adw.ActionRow({title: _('Claude Code status line')});
    const button = new Gtk.Button({valign: Gtk.Align.CENTER});
    row.add_suffix(button);
    let error = null;
    const sync = () => {
        const read = readClaudeSettings();
        const state = read.error ? 'error' : statusLineState(read.settings);
        const path = claudeSettingsFile().get_path();
        button.visible = state === 'none' || state === 'ours';
        button.label = state === 'ours' ? _('Remove') : _('Set up');
        button.remove_css_class(state === 'ours' ? 'suggested-action' : 'destructive-action');
        if (state === 'none')
            button.add_css_class('suggested-action');
        row.subtitle = {
            none: _('Not set up. Set up adds Froonty’s status line to %s; it then updates Session and Weekly with no extra requests, also in low power.').format(path),
            ours: _('Set up: Session and Weekly update after each Claude Code reply.'),
            other: _('Claude Code already has another status line in %s; Froonty leaves it alone.').format(path),
            error: _('%s could not be read: %s').format(path, read.error),
        }[state];
        if (error)
            row.subtitle = _('Could not change %s: %s').format(path, error);
    };
    button.connect('clicked', () => {
        const read = readClaudeSettings();
        error = statusLineState(read.settings) === 'ours' ? removeStatusLine() : installStatusLine();
        sync();
    });
    sync();
    group.add(row);
    return group;
}
