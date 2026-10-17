// SPDX-License-Identifier: GPL-3.0-or-later
// Claude settings tab. Runs in the preferences process (GTK 4 + libadwaita),
// so it imports nothing from the Shell side of the feature.

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {addIconPath as addIconFolder, choiceRow} from '../../prefs/rows.js';
import {attentionHooksState, installAttentionHooks, removeAttentionHooks} from './attentionSetup.js';
import {
    claudeSettingsFile, installStatusLine, readClaudeSettings, removeStatusLine, statusLineState,
} from './statusLineSetup.js';
import {SPARK_ICON_NAME} from './icon.js';

/** Makes the bundled Spark an icon name. */
export const addIconPath = () => addIconFolder(import.meta.url);

// Both Remove buttons: Claude Code's own settings, so red, but lighter than
// destructive-action. The text is libadwaita's red for text on the window
// background, the fill a tint of it, in both light and dark styles.
const CSS = `
button.froonty-remove { color: var(--destructive-color); background-color: alpha(currentColor, 0.12); }
button.froonty-remove:hover { background-color: alpha(currentColor, 0.18); }
button.froonty-remove:active { background-color: alpha(currentColor, 0.28); }
`;
let cssAdded = false;

function addCss() {
    if (cssAdded)
        return;
    cssAdded = true;
    const provider = new Gtk.CssProvider();
    provider.load_from_string(CSS);
    Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), provider,
        Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
}

export function claudePage(settings) {
    addCss();
    const page = new Adw.PreferencesPage({
        name: 'claude',
        title: _('Claude'),
        icon_name: SPARK_ICON_NAME,
    });

    const group = new Adw.PreferencesGroup({
        title: _('Claude'),
        description: _('Your Claude plan’s usage limits and when each resets. Froonty reads what Claude Code last checked each time you open the tab; it never signs in to Claude itself.'),
    });
    const enabled = new Adw.SwitchRow({title: _('Show the Claude tab')});
    settings.bind('claude-enabled', enabled, 'active', Gio.SettingsBindFlags.DEFAULT);
    group.add(enabled);

    const panicUsageGroup = new Adw.PreferencesGroup({
        title: _('Panic button'),
        description: _('Choose which Claude usage window appears in the Claude panic button.'),
    });
    panicUsageGroup.add(choiceRow(settings, 'claude-panic-usage-window', _('Usage to show'),
        ['session', 'weekly'], [_('Session'), _('Weekly')]));

    page.add(group);
    page.add(panicUsageGroup);
    const freshness = freshnessGroup(settings);
    page.add(freshness.group);
    const attention = attentionGroup(settings);
    page.add(attention.group);
    followClaudeSettings(page, [freshness.sync, attention.sync]);
    return page;
}

// The rows that show what Claude Code's settings.json holds are read again
// whenever the page comes on screen, and while it is on screen whenever the
// file changes (Claude Code itself may rewrite it, and drop Froonty's
// entries; see docs/features/claude-attention.md §5).
function followClaudeSettings(page, syncs) {
    let monitor = null;
    const syncAll = () => syncs.forEach(sync => sync());
    page.connect('map', () => {
        syncAll();
        const file = claudeSettingsFile();
        // Only an existing folder: GLib would look for a missing one every
        // 4 s.
        if (monitor || !file.get_parent().query_exists(null))
            return;
        try {
            monitor = file.monitor_file(Gio.FileMonitorFlags.WATCH_MOVES, null);
            monitor.connect('changed', syncAll);
        } catch (e) {
            console.warn(`Froonty: cannot watch ${file.get_path()}: ${e.message}`);
        }
    });
    page.connect('unmap', () => {
        monitor?.cancel();
        monitor = null;
    });
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
    // A failed click's message, shown while the state it was made in lasts.
    let error = null;
    const sync = () => {
        const read = readClaudeSettings();
        const state = read.error ? 'error' : statusLineState(read.settings);
        const path = claudeSettingsFile().get_path();
        if (error?.state !== state)
            error = null;
        button.visible = state === 'none' || state === 'ours';
        button.label = state === 'ours' ? _('Remove') : _('Set up');
        for (const css of ['suggested-action', 'froonty-remove'])
            button.remove_css_class(css);
        if (state === 'none' || state === 'ours')
            button.add_css_class(state === 'ours' ? 'froonty-remove' : 'suggested-action');
        row.subtitle = {
            none: _('Not set up. Set up adds Froonty’s status line to %s; it then updates Session and Weekly with no extra requests, also in low power.').format(path),
            ours: _('Set up: Session and Weekly update after each Claude Code reply.'),
            other: _('Claude Code already has another status line in %s; Froonty leaves it alone.').format(path),
            error: _('%s could not be read: %s').format(path, read.error),
        }[state];
        if (error)
            row.subtitle = _('Could not change %s: %s').format(path, error.message);
    };
    button.connect('clicked', () => {
        const read = readClaudeSettings();
        const state = statusLineState(read.settings);
        const message = state === 'ours' ? removeStatusLine() : installStatusLine();
        error = message ? {state, message} : null;
        sync();
    });
    sync();
    group.add(row);
    return {group, sync};
}

// "When Claude needs you": the bar under the island, and Froonty's hooks in
// Claude Code's settings (docs/features/claude-attention.md).
function attentionGroup(settings) {
    const group = new Adw.PreferencesGroup({
        title: _('When Claude needs you'),
        description: _('A slim bar under the island while a Claude session waits for you: a permission, a question, or a finished reply. Click it to go there; × hides it. Nothing is polled: Claude Code and the Claude app tell Froonty.'),
    });

    const enabled = new Adw.SwitchRow({
        title: _('Show the bar'),
        subtitle: _('Under the collapsed island, only while something waits. Hidden while the island is open, a GNOME banner shows, the overview is open, or Do Not Disturb is on.'),
    });
    settings.bind('claude-attention-enabled', enabled, 'active', Gio.SettingsBindFlags.DEFAULT);
    group.add(enabled);

    const row = new Adw.ActionRow({title: _('Claude Code hooks')});
    const button = new Gtk.Button({valign: Gtk.Align.CENTER});
    row.add_suffix(button);
    // A failed click's message, shown while the state it was made in lasts.
    let error = null;
    let state = 'error';
    const sync = () => {
        const read = readClaudeSettings();
        const hooks = read.error ? null : attentionHooksState(read.settings);
        state = hooks?.state ?? 'error';
        const path = claudeSettingsFile().get_path();
        if (error?.state !== state)
            error = null;
        button.visible = state !== 'error';
        button.label = {none: _('Set up'), ours: _('Remove'), outdated: _('Update')}[state] ?? '';
        for (const css of ['suggested-action', 'froonty-remove'])
            button.remove_css_class(css);
        if (state !== 'error')
            button.add_css_class(state === 'ours' ? 'froonty-remove' : 'suggested-action');
        let subtitle = {
            none: _('Not set up. Set up adds Froonty’s hooks to %s, next to any of your own: Claude Code (terminal, VS Code, the Claude app’s Code tab) then tells Froonty when a session needs you. Needs Claude Code 2.1.233 or later.').format(path),
            ours: _('Set up. Claude Code runs Froonty’s script when a session needs you or finishes, and a one-line command after each prompt and step to clear it.'),
            outdated: _('Froonty’s hooks in %s are from another copy or version of Froonty. Update replaces them.').format(path),
            error: _('%s could not be read: %s').format(path, read.error),
        }[state];
        if (hooks?.disableAllHooks)
            subtitle += _(' Claude Code’s disableAllHooks is on, so no hook runs.');
        if (state !== 'none' && state !== 'error' && !settings.get_boolean('claude-attention-enabled'))
            subtitle += _(' The bar is off, so the hooks record nothing.');
        if (error)
            subtitle = _('Could not change %s: %s').format(path, error.message);
        row.subtitle = subtitle;
    };
    button.connect('clicked', () => {
        // What the row showed is what the click does.
        const message = state === 'ours' ? removeAttentionHooks() : installAttentionHooks();
        error = message ? {state, message} : null;
        sync();
    });
    settings.connect('changed::claude-attention-enabled', sync);
    sync();
    group.add(row);

    const rows = [
        [_('Also when Claude finishes'), 'claude-attention-finished',
            _('A finished reply, or one stopped by an error. Not shown while you are looking at that window.')],
        [_('Sessions in the Claude app'), 'claude-attention-app',
            _('From the Claude app’s own notifications, which it closes once you have seen the session; × also removes it from GNOME’s list. Off: from Claude Code’s hooks, as for VS Code.')],
        [_('Browser notifications from claude.ai'), 'claude-attention-browsers',
            _('Best effort: a notification from your web browser that mentions claude.ai, if claude.ai may send them. Clicking the bar opens it in the browser; × also removes it from GNOME’s list.')],
    ];
    for (const [title, key, subtitle] of rows) {
        const sw = new Adw.SwitchRow({title, subtitle});
        settings.bind(key, sw, 'active', Gio.SettingsBindFlags.DEFAULT);
        settings.bind('claude-attention-enabled', sw, 'sensitive', Gio.SettingsBindFlags.GET);
        group.add(sw);
    }
    return {group, sync};
}
