// SPDX-License-Identifier: GPL-3.0-or-later
// LocalSend settings tab (docs/features/localsend.md): show the tab, the
// name other devices see, where received files go, the PIN for a new
// device, trusted devices and networks, devices added by address,
// ZeroTier, the port.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {spinRow, switchRow} from '../../prefs/rows.js';

const FOLDER_KEY = 'localsend-folder';
const ALIAS_KEY = 'localsend-alias';

// Must match defaultFolder() (service.js): ~/Downloads/LocalSend.
function defaultFolder() {
    const downloads = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD) ||
        GLib.build_filenamev([GLib.get_home_dir(), 'Downloads']);
    return GLib.build_filenamev([downloads, 'LocalSend']);
}

const defaultAlias = () => `Froonty (${GLib.get_host_name()})`;

function aliasRow(settings) {
    const row = new Adw.EntryRow({title: _('Name other devices see'), show_apply_button: true});
    const sync = () => {
        row.text = settings.get_string(ALIAS_KEY) || defaultAlias();
    };
    sync();
    settings.connect(`changed::${ALIAS_KEY}`, sync);
    row.connect('apply', () => {
        const text = row.text.trim();
        if (!text || text === defaultAlias())
            settings.reset(ALIAS_KEY);
        else
            settings.set_string(ALIAS_KEY, text.slice(0, 64));
    });
    return row;
}

function folderRow(settings) {
    const row = new Adw.ActionRow({title: _('Save received files in')});
    const reset = new Gtk.Button({
        icon_name: 'edit-undo-symbolic',
        valign: Gtk.Align.CENTER,
        css_classes: ['flat'],
        tooltip_text: defaultFolder(),
    });
    const choose = new Gtk.Button({
        icon_name: 'folder-open-symbolic',
        valign: Gtk.Align.CENTER,
        css_classes: ['flat'],
        tooltip_text: _('Choose a folder'),
    });
    row.add_suffix(reset);
    row.add_suffix(choose);
    const sync = () => {
        const custom = settings.get_string(FOLDER_KEY);
        row.subtitle = custom || defaultFolder();
        reset.sensitive = Boolean(custom);
    };
    sync();
    settings.connect(`changed::${FOLDER_KEY}`, sync);
    reset.connect('clicked', () => settings.reset(FOLDER_KEY));
    choose.connect('clicked', () => {
        const dialog = new Gtk.FileDialog({
            title: _('LocalSend folder'),
            initial_folder: Gio.File.new_for_path(GLib.path_get_dirname(row.subtitle)),
        });
        dialog.select_folder(row.get_root(), null, (_dialog, result) => {
            try {
                settings.set_string(FOLDER_KEY, dialog.select_folder_finish(result).get_path());
            } catch (e) {
                if (!e.matches(Gtk.DialogError, Gtk.DialogError.DISMISSED))
                    logError(e);
            }
        });
    });
    return row;
}

const TRUSTED_KEY = 'localsend-trusted';
const NETWORKS_KEY = 'localsend-trusted-networks';
const DEVICES_KEY = 'localsend-devices';

/**
 * Rows for a list kept in a setting, each with Remove; rebuilt when it
 * changes. `entries()` gives [key, title, subtitle]; `remove(key)`.
 */
function listRows(group, settings, key, entries, remove, empty) {
    let rows = [];
    const sync = () => {
        for (const row of rows)
            group.remove(row);
        rows = [];
        const list = entries();
        if (!list.length)
            rows.push(new Adw.ActionRow({title: empty, sensitive: false}));
        for (const [id, title, subtitle] of list) {
            const row = new Adw.ActionRow({title, subtitle});
            const button = new Gtk.Button({label: _('Remove'), valign: Gtk.Align.CENTER, css_classes: ['flat']});
            button.connect('clicked', () => remove(id));
            row.add_suffix(button);
            rows.push(row);
        }
        for (const row of rows)
            group.add(row);
    };
    sync();
    settings.connect(`changed::${key}`, sync);
}

const dict = (settings, key) => settings.get_value(key).deepUnpack();
const setDict = (settings, key, value) => settings.set_value(key, new GLib.Variant('a{ss}', value));

function securityGroup(settings) {
    const group = new Adw.PreferencesGroup({
        title: _('New devices and networks'),
        description: _('A device you have not used before must enter a PIN Froonty shows, so nobody else on the network can send you anything. A café’s Wi-Fi is not trusted: there, only ZeroTier is used. Your home network is trusted from the tab’s Networks list (Trust). A wired profile such as “Wired connection 1” is the same on every cable: trusting it trusts every wired network.'),
    });
    group.add(switchRow(settings, 'localsend-pin-first', _('Ask a new device for a PIN'),
        _('Its first transfer waits for the PIN shown here; the PIN makes it trusted. Off: its first transfer asks for Accept')));
    group.add(switchRow(settings, 'localsend-only-trusted-networks', _('Visible only on trusted networks and ZeroTier'),
        _('Off: visible on every network, but on an untrusted one every transfer asks')));
    listRows(group, settings, NETWORKS_KEY,
        () => Object.entries(dict(settings, NETWORKS_KEY)).sort(([, a], [, b]) => a.localeCompare(b))
            .map(([uuid, name]) => [uuid, name || _('Unnamed network'), _('Trusted network')]),
        uuid => {
            const now = dict(settings, NETWORKS_KEY);
            delete now[uuid];
            setDict(settings, NETWORKS_KEY, now);
        }, _('No trusted network yet'));
    return group;
}

function devicesGroup(settings) {
    const group = new Adw.PreferencesGroup({
        title: _('Devices added by address'),
        description: _('Added in the tab (“Add a device by IP address”), for a phone that discovery does not reach, such as over ZeroTier. Froonty introduces itself to them every few seconds, so this computer shows up there whenever LocalSend is open.'),
    });
    listRows(group, settings, DEVICES_KEY,
        () => settings.get_strv(DEVICES_KEY).map(a => [a, a, '']),
        address => settings.set_strv(DEVICES_KEY, settings.get_strv(DEVICES_KEY).filter(a => a !== address)),
        _('None'));
    return group;
}

function trustGroup(settings) {
    const group = new Adw.PreferencesGroup({
        title: _('Trusted devices'),
        description: _('A device is trusted once you entered its PIN (or, with the PIN off, accepted its first transfer). Its transfers are then accepted without asking, over ZeroTier or a trusted network. A device is known by the ID it announces, which another device on the same network could copy: that is why only trusted networks count.'),
    });
    group.add(switchRow(settings, 'localsend-auto-accept', _('Accept automatically from trusted devices'),
        _('Off: every transfer waits for Accept')));
    listRows(group, settings, TRUSTED_KEY,
        () => Object.entries(dict(settings, TRUSTED_KEY)).sort(([, a], [, b]) => a.localeCompare(b))
            .map(([fingerprint, name]) => [fingerprint, name || _('Unnamed device'), `${fingerprint.slice(0, 16)}…`]),
        fingerprint => {
            const now = dict(settings, TRUSTED_KEY);
            delete now[fingerprint];
            setDict(settings, TRUSTED_KEY, now);
        }, _('None yet'));
    return group;
}

export function localSendPage(settings) {
    const page = new Adw.PreferencesPage({
        name: 'localsend',
        title: _('LocalSend'),
        icon_name: 'send-to-symbolic',
    });

    const group = new Adw.PreferencesGroup({
        title: _('LocalSend'),
        description: _('Files and text between this computer and a phone (or computer) running the LocalSend app, over your own network: nothing goes through the internet. Every incoming transfer waits for you to accept it.'),
    });
    group.add(switchRow(settings, 'localsend-enabled', _('Show the LocalSend tab'),
        _('While it is on, Froonty listens for LocalSend on this computer’s network')));
    group.add(switchRow(settings, 'localsend-visible', _('Visible to other devices'),
        _('Off: nothing listens, and nothing can be sent either (the tab’s Hide button)')));
    group.add(aliasRow(settings));
    group.add(folderRow(settings));
    page.add(group);
    page.add(securityGroup(settings));
    page.add(trustGroup(settings));
    page.add(devicesGroup(settings));

    const network = new Adw.PreferencesGroup({
        title: _('Network'),
        description: _('Wi-Fi and wired networks are always used; Docker, virtual machines and other VPNs never. If a firewall is on (sudo ufw status), allow the port: sudo ufw allow 53317/tcp and sudo ufw allow 53317/udp.'),
    });
    network.add(switchRow(settings, 'localsend-zerotier', _('Also over ZeroTier'),
        _('Away from home: with ZeroTier on the phone too, add the phone by its ZeroTier address in the tab; this computer then shows up in LocalSend there')));
    network.add(spinRow(settings, 'localsend-port', _('Port')));
    page.add(network);
    return page;
}
