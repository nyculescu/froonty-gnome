// SPDX-License-Identifier: GPL-3.0-or-later
// Calendar settings tab: show the tab, which calendars it shows, and its
// size (docs/features/calendar.md §B). Runs in the preferences process
// (GTK 4 + libadwaita); the calendar list comes from Evolution Data
// Server through the same adapter as the tab (eds.js), read-only.

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {sizeGroup} from '../../prefs/rows.js';
import {sanitizeColor} from './color.js';
import {loadEds} from './eds.js';
import {CALENDAR_ICON_NAME} from './icon.js';
import {detectProvider} from './providers.js';

const HIDDEN_KEY = 'calendar-hidden-sources';

// The tab's icon in the settings window's view switcher.
function addIconPath() {
    const display = Gdk.Display.get_default();
    const icons = Gio.File.new_for_uri(import.meta.url).get_parent().get_child('icons');
    if (display)
        Gtk.IconTheme.get_for_display(display).add_search_path(icons.get_path());
}

function openOnlineAccounts() {
    const app = ['gnome-online-accounts-panel.desktop', 'org.gnome.Settings.desktop']
        .map(id => Gio.DesktopAppInfo.new(id)).find(Boolean);
    try {
        app?.launch([], null);
    } catch (e) {
        console.warn(`Froonty: could not open Online Accounts: ${e.message}`);
    }
}

/**
 * @param {Gio.Settings} settings
 * @param {Adw.PreferencesWindow} window what is connected here is
 *   disconnected when it closes: GTK 4 emits no 'destroy' on the pages of
 *   a closed window
 */
export function calendarPage(settings, window) {
    addIconPath();
    const page = new Adw.PreferencesPage({
        name: 'calendar',
        title: _('Calendar'),
        icon_name: CALENDAR_ICON_NAME,
    });

    const group = new Adw.PreferencesGroup({
        title: _('Calendar'),
        description: _('Events from the calendars GNOME knows: accounts in Settings → Online Accounts (Google, ' +
            'Microsoft 365, Nextcloud, …) and calendars added in GNOME Calendar or Evolution. ' +
            'Read-only: Froonty never adds, changes or removes events. Needs gir1.2-ecal-2.0; ' +
            'Microsoft 365 and Exchange calendars also need Evolution Data Server’s EWS backends ' +
            '(evolution-ews-core).'),
    });
    const enabled = new Adw.SwitchRow({title: _('Show the Calendar tab')});
    settings.bind('calendar-enabled', enabled, 'active', Gio.SettingsBindFlags.DEFAULT);
    group.add(enabled);
    const accounts = new Adw.ActionRow({
        title: _('Online Accounts'),
        subtitle: _('Connect Google, Microsoft 365, Nextcloud and other accounts'),
    });
    const open = new Gtk.Button({label: _('Open'), valign: Gtk.Align.CENTER});
    open.connect('clicked', openOnlineAccounts);
    accounts.add_suffix(open);
    accounts.activatable_widget = open;
    group.add(accounts);
    page.add(group);

    const cleanups = [];
    page.add(calendarsGroup(settings, cleanups));
    page.add(sizeGroup(settings, ['calendar-width', 'calendar-height'],
        _('Of the island while the Calendar tab is shown, in logical pixels. Or drag the open island’s bottom-right corner.'), cleanups));
    const closeId = window.connect('close-request', () => {
        window.disconnect(closeId);
        for (const cleanup of cleanups.splice(0))
            cleanup();
        return false;
    });
    return page;
}

// One switch per calendar GNOME's own calendar shows; off = hidden in
// the tab (calendar-hidden-sources). Adds its teardown to `cleanups`.
function calendarsGroup(settings, cleanups) {
    const group = new Adw.PreferencesGroup({
        title: _('Calendars'),
        description: _('Shown in the tab. The list is the calendars GNOME’s own calendar shows.'),
    });
    // Calendar names and error messages are text, not markup.
    const placeholder = new Adw.ActionRow({title: _('Loading…'), use_markup: false});
    group.add(placeholder);
    const rows = new Map();
    let adapter = null;
    let ids = [];
    let destroyed = false;

    const syncPlaceholder = text => {
        placeholder.title = text ?? _('No calendars');
        placeholder.visible = text !== null || ![...rows.values()].some(row => row.visible);
    };
    const hidden = () => new Set(settings.get_strv(HIDDEN_KEY));
    const setShown = (uid, shown) => {
        const set = hidden();
        if (shown === !set.has(uid))
            return;
        if (shown)
            set.delete(uid);
        else
            set.add(uid);
        settings.set_strv(HIDDEN_KEY, [...set]);
    };
    const describe = (row, info) => {
        const provider = detectProvider(info);
        row.title = info.name || info.uid;
        const account = provider.account ?? info.collectionIdentity ?? info.collectionName ?? null;
        if (provider.kind === 'local')
            row.subtitle = _('On this computer');
        else if (provider.label)
            row.subtitle = [account, provider.label].filter(Boolean).join(' · ');
        else
            row.subtitle = account ?? info.webdav?.host ?? '';
        // Only sanitized hex reaches the markup.
        const color = sanitizeColor(info.color);
        row._dot.set_markup(color ? `<span foreground="${color}">●</span>` : '●');
    };
    const add = info => {
        let row = rows.get(info.uid);
        if (!row) {
            row = new Adw.SwitchRow({active: !hidden().has(info.uid), use_markup: false});
            row._dot = new Gtk.Label({valign: Gtk.Align.CENTER});
            row.add_prefix(row._dot);
            row.connect('notify::active', () => setShown(info.uid, row.active));
            rows.set(info.uid, row);
            group.add(row);
        }
        row.visible = true;
        describe(row, info);
        syncPlaceholder(null);
    };
    // Kept hidden, in case it comes back (ticked again in GNOME Calendar).
    const hide = uid => {
        const row = rows.get(uid);
        if (row)
            row.visible = false;
        syncPlaceholder(null);
    };
    const settingsId = settings.connect(`changed::${HIDDEN_KEY}`, () => {
        const set = hidden();
        for (const [uid, row] of rows)
            row.active = !set.has(uid);
    });

    const cancellable = new Gio.Cancellable();
    loadEds().then(async result => {
        if (destroyed)
            return;
        if (result.status === 'missing') {
            syncPlaceholder(_('Install gir1.2-ecal-2.0 to list your calendars'));
            return;
        }
        if (result.status !== 'ok') {
            syncPlaceholder(_('Could not load the calendar bindings: %s').format(result.message));
            return;
        }
        adapter = result.adapter;
        ids = [
            adapter.connect('calendar-appeared', (_a, info) => add(info)),
            adapter.connect('calendar-changed', (_a, info) => add(info)),
            adapter.connect('calendar-disappeared', (_a, uid) => hide(uid)),
        ];
        await adapter.start(cancellable);
        if (!destroyed)
            syncPlaceholder(null);
    }).catch(e => {
        if (!destroyed)
            syncPlaceholder(_('GNOME’s calendar service did not answer: %s').format(e.message));
    });

    // The adapter's handlers and calendar connections go with the window;
    // the source registry stays for the process (eds.js).
    cleanups.push(() => {
        destroyed = true;
        cancellable.cancel();
        settings.disconnect(settingsId);
        for (const id of ids)
            adapter.disconnect(id);
        ids = [];
        adapter?.stop();
        adapter = null;
    });
    return group;
}
