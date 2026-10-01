// SPDX-License-Identifier: GPL-3.0-or-later
// ZeroTier settings tab: show the tab, and let Froonty read ZeroTier's
// status (docs/features/zerotier.md). Networks and starting with the
// computer are set up in ZeroTier itself.

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {actionArgv, findExecutable, NO_TOKEN, NODE_TOKEN, run, userTokenPath} from './cli.js';
import {ZEROTIER_ICON_NAME} from './icon.js';

export function addIconPath() {
    const display = Gdk.Display.get_default();
    const icons = Gio.File.new_for_uri(import.meta.url).get_parent().get_child('icons');
    if (display)
        Gtk.IconTheme.get_for_display(display).add_search_path(icons.get_path());
}

/**
 * Whether zerotier-cli works for this user: 'not-installed', 'allowed',
 * 'denied' (no readable token), or 'unknown' (e.g. ZeroTier is stopped).
 */
async function accessState() {
    const cli = await findExecutable('zerotier-cli');
    if (!cli)
        return 'not-installed';
    const result = await run([cli, '-j', 'info']);
    if (result.success)
        return 'allowed';
    return NO_TOKEN.test(result.stderr + result.stdout) ? 'denied' : 'unknown';
}

// Copies the node's token to the user's home with pkexec; zerotier-cli
// then works without elevation. Froonty itself never reads the token.
async function allowAccess() {
    const tokenPath = userTokenPath();
    // Root writes this file: never through a link the user left there.
    const type = Gio.File.new_for_path(tokenPath).query_file_type(
        Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
    if (type !== Gio.FileType.UNKNOWN && type !== Gio.FileType.REGULAR)
        throw new Error(_('%s is not a regular file.').format(tokenPath));
    const argv = actionArgv('allow', {
        pkexec: await findExecutable('pkexec'),
        install: await findExecutable('install'),
    }, {name: GLib.get_user_name(), tokenPath});
    const result = await run(argv);
    if (!result.success)
        throw new Error(result.stderr.trim() || _('Not allowed.'));
}

function accessGroup() {
    const group = new Adw.PreferencesGroup({
        title: _('Status access'),
        description: _('ZeroTier lets only the system read its status. Allowing it copies ZeroTier’s access token (%s) to your home folder, readable only by you; that also lets your own programs control ZeroTier without a password.').format(NODE_TOKEN),
    });
    const row = new Adw.ActionRow({title: _('Read ZeroTier’s status')});
    const button = new Gtk.Button({
        label: _('Allow'),
        valign: Gtk.Align.CENTER,
        css_classes: ['suggested-action'],
    });
    row.add_suffix(button);
    group.add(row);

    let error = null;
    const warn = e => console.warn(`Froonty: ZeroTier access check failed: ${e.message}`);
    const sync = async () => {
        button.sensitive = false;
        const state = await accessState();
        button.visible = state === 'denied';
        button.sensitive = true;
        row.subtitle = error ?? {
            'not-installed': _('ZeroTier is not installed.'),
            allowed: _('Allowed: the ZeroTier tab shows the node and its networks.'),
            denied: _('Not allowed yet: the ZeroTier tab cannot show the node or its networks.'),
            unknown: _('Cannot tell while ZeroTier is not running.'),
        }[state];
    };
    button.connect('clicked', async () => {
        button.sensitive = false;
        try {
            await allowAccess();
            error = null;
        } catch (e) {
            error = _('Could not allow it: %s').format(e.message);
        }
        await sync().catch(warn);
    });
    sync().catch(warn);
    return group;
}

export function zeroTierPage(settings) {
    const page = new Adw.PreferencesPage({
        name: 'zerotier',
        title: _('ZeroTier'),
        icon_name: ZEROTIER_ICON_NAME,
    });
    const group = new Adw.PreferencesGroup({
        title: _('ZeroTier'),
        description: _('Networks are joined and left, and ZeroTier is set to start with the computer, in ZeroTier itself; the tab shows how they are doing.'),
    });
    const enabled = new Adw.SwitchRow({title: _('Show the ZeroTier tab')});
    settings.bind('zerotier-enabled', enabled, 'active', Gio.SettingsBindFlags.DEFAULT);
    group.add(enabled);
    page.add(group);
    page.add(accessGroup());
    return page;
}
