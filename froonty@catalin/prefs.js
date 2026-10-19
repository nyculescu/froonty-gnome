// SPDX-License-Identifier: GPL-3.0-or-later
// Froonty preferences (runs in the separate org.gnome.Shell.Extensions
// process, GTK 4 and libadwaita).

import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {
    ExtensionPreferences,
    gettext as _,
} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

// Feature settings tabs, after the general ones. (Imported here, not via
// features/registry.js: that loads Shell-side modules this process cannot.)
import {attachAllNotes} from './features/notes/allNotesPage.js';
import {notesPage} from './features/notes/prefs.js';
import {addFeatureIconPaths, featurePages} from './features/pages.js';
import {panicPage} from './panic/prefs.js';
import {choiceRow, spinRow, switchRow} from './prefs/rows.js';

const CLOCK_FORMATS = ['system', '24h', '12h'];

// Pages, in display order. The window opens on the first one.
const GENERAL_PAGE = 'general';
const APPEARANCE_PAGE = 'appearance';
const PREFS_PAGE_KEY = 'prefs-page';

export default class FroontyPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        // Keep the settings object alive as long as the window.
        window._settings = settings;
        // Bundled icons used in feature tabs and preferences (some also by
        // the Panic buttons page).
        addFeatureIconPaths();

        const pageStack = new Gtk.Stack({
            hexpand: true,
            vexpand: true,
            transition_type: Gtk.StackTransitionType.NONE,
        });
        const pages = [
            this._generalPage(settings),
            this._appearancePage(settings),
            panicPage(settings),
            // Feature pages in the hub's tab order (features/registry.js).
            notesPage(settings),
            ...featurePages(window, settings, pageStack),
        ];

        const pageRows = new Map();
        const sidebar = new Gtk.ListBox({
            selection_mode: Gtk.SelectionMode.SINGLE,
            css_classes: ['navigation-sidebar'],
        });
        for (const page of pages) {
            pageStack.add_named(page, page.name);
            const label = new Gtk.Label({
                label: page.title,
                xalign: 0,
                wrap: true,
                hexpand: true,
                margin_top: 6,
                margin_bottom: 6,
            });
            const contents = new Gtk.Box({
                orientation: Gtk.Orientation.HORIZONTAL,
                spacing: 10,
                margin_start: 12,
                margin_end: 12,
            });
            contents.append(new Gtk.Image({
                icon_name: page.icon_name,
                pixel_size: 16,
            }));
            contents.append(label);
            const row = new Gtk.ListBoxRow({child: contents});
            row._pageName = page.name;
            sidebar.append(row);
            pageRows.set(page.name, row);
        }

        const pageScroller = new Gtk.ScrolledWindow({
            child: sidebar,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            width_request: 180,
            vexpand: true,
        });
        const split = new Gtk.Paned({
            orientation: Gtk.Orientation.HORIZONTAL,
            position: 220,
            resize_start_child: false,
            shrink_start_child: false,
            hexpand: true,
            vexpand: true,
        });
        split.set_start_child(pageScroller);
        split.set_end_child(pageStack);
        sidebar.connect('row-selected', (_sidebar, row) => {
            if (row)
                pageStack.visible_child_name = row._pageName;
        });

        const title = new Adw.WindowTitle({
            title: pages[0].title,
            subtitle: window.title,
        });
        pageStack.connect('notify::visible-child-name', () => {
            title.title = pages.find(item => item.name === pageStack.visible_child_name).title;
        });
        sidebar.select_row(pageRows.get(GENERAL_PAGE));

        const toolbar = new Adw.ToolbarView();
        toolbar.add_top_bar(new Adw.HeaderBar({title_widget: title}));
        toolbar.set_content(split);
        const rootPage = new Adw.NavigationPage({
            tag: 'settings',
            title: window.title,
            child: toolbar,
        });
        const navigationView = new Adw.NavigationView();
        navigationView.add(rootPage);
        window.set_default_size(960, 700);
        // The preferences service checks for at least one registered page.
        window.add(new Adw.PreferencesPage({
            name: 'settings',
            title: window.title,
        }));
        window.set_content(navigationView);

        // The All notes page (pushed onto navigationView), when the island
        // asked for it.
        attachAllNotes(window, settings, navigationView);
        this._followPrefsPage(window, settings, sidebar, pageRows);
    }

    // A tab's "Open Settings" button names the page to show (prefs-page),
    // also while the window is already open; the key is emptied after.
    _followPrefsPage(window, settings, sidebar, pageRows) {
        const show = () => {
            const name = settings.get_string(PREFS_PAGE_KEY);
            if (pageRows.has(name))
                sidebar.select_row(pageRows.get(name));
            if (name)
                settings.reset(PREFS_PAGE_KEY);
        };
        show();
        const id = settings.connect(`changed::${PREFS_PAGE_KEY}`, show);
        window.connect('close-request', () => {
            settings.disconnect(id);
            return false;
        });
    }

    _generalPage(settings) {
        const page = new Adw.PreferencesPage({
            name: GENERAL_PAGE,
            title: _('General'),
            icon_name: 'emblem-system-symbolic',
        });
        page.add(this._startupGroup(settings));
        page.add(this._islandGroup(settings));
        page.add(this._clockGroup(settings));
        return page;
    }

    _appearancePage(settings) {
        const page = new Adw.PreferencesPage({
            name: APPEARANCE_PAGE,
            title: _('Appearance'),
            icon_name: 'preferences-desktop-appearance-symbolic',
        });
        page.add(this._sizeGroup(settings));
        page.add(this._animationGroup(settings));
        return page;
    }

    _startupGroup(settings) {
        const group = new Adw.PreferencesGroup({title: _('Startup')});

        // Stop: for a computer that needs all its power (long scripts);
        // Start brings it back. Also: the top bar icon, the shortcut, and
        // Froonty in Show Apps (make install).
        const running = new Adw.ActionRow({use_markup: false});
        const toggle = new Gtk.Button({valign: Gtk.Align.CENTER});
        toggle.connect('clicked', () =>
            settings.set_boolean('running', !settings.get_boolean('running')));
        running.add_suffix(toggle);
        running.activatable_widget = toggle;
        // `make install` adds Froonty to Show Apps (tools/froonty.desktop).
        const inApps = GLib.file_test(GLib.build_filenamev([GLib.get_user_data_dir(),
            'applications', 'froonty.desktop']), GLib.FileTest.EXISTS);
        const syncRunning = () => {
            const on = settings.get_boolean('running');
            running.title = on ? _('Froonty is running') : _('Froonty is stopped');
            const again = inApps
                ? _('The top bar icon, the shortcut, Froonty in Show Apps or this button start it again')
                : _('The top bar icon, the shortcut or this button start it again');
            running.subtitle = on
                ? `${_('Stop it to free the computer: no island and no background work.')} ${again}`
                : `${_('Nothing of it runs but the top bar icon. At the next login it follows Start at login.')} ${again}`;
            toggle.label = on ? _('Stop Froonty') : _('Start Froonty');
            toggle.css_classes = on ? ['destructive-action'] : ['suggested-action'];
        };
        syncRunning();
        settings.connect('changed::running', syncRunning);
        group.add(running);

        group.add(switchRow(settings, 'start-at-login', _('Start at login'),
            _('When off, Froonty waits after login until you click its icon in the top bar or press the shortcut')));
        return group;
    }

    _islandGroup(settings) {
        const group = new Adw.PreferencesGroup({title: _('Island')});
        group.add(switchRow(settings, 'island-enabled', _('Show island'),
            _('When off, a small icon in the top bar opens these settings')));
        group.add(switchRow(settings, 'hide-panel-clock', _('Hide top bar clock'),
            _('The island replaces the clock; its calendar menu keeps working')));
        const hoverRow = spinRow(settings, 'hover-open-delay', _('Open on hover after (ms)'), 50);
        hoverRow.subtitle = _('0 turns opening on hover off');
        group.add(hoverRow);

        // Read-only for now; a shortcut editor is not worth its size yet.
        // Change with: gsettings set org.gnome.shell.extensions.froonty
        //              toggle-shortcut "['<Super><Alt>i']"
        const shortcutRow = new Adw.ActionRow({
            title: _('Toggle shortcut'),
            use_markup: false,
        });
        const syncShortcutRow = () => {
            const labels = settings.get_strv('toggle-shortcut').map(acceleratorLabel);
            shortcutRow.subtitle = labels.join(', ') || _('Disabled');
        };
        syncShortcutRow();
        settings.connect('changed::toggle-shortcut', syncShortcutRow);
        group.add(shortcutRow);
        return group;
    }

    _clockGroup(settings) {
        const group = new Adw.PreferencesGroup({title: _('Clock')});
        group.add(switchRow(settings, 'show-date', _('Show date when collapsed')));

        group.add(choiceRow(settings, 'clock-format', _('Clock format'), CLOCK_FORMATS,
            [_('Follow system'), _('24-hour'), _('12-hour')]));
        return group;
    }

    _sizeGroup(settings) {
        const group = new Adw.PreferencesGroup({
            title: _('Size'),
            description: _('In logical pixels. While the top bar clock is hidden, the collapsed island grows to cover it.'),
        });
        group.add(spinRow(settings, 'collapsed-width', _('Collapsed width (minimum)')));
        group.add(spinRow(settings, 'collapsed-height', _('Collapsed height (minimum)')));
        // Each tab has a size of its own, on its page.
        for (const [key, title] of [['expanded-width', _('Expanded width')],
            ['expanded-height', _('Expanded height')]]) {
            const row = spinRow(settings, key, title);
            row.subtitle = _('While no tab is on');
            group.add(row);
        }
        group.add(spinRow(settings, 'corner-radius', _('Corner radius')));
        return group;
    }

    _animationGroup(settings) {
        const group = new Adw.PreferencesGroup({title: _('Animation')});
        group.add(spinRow(settings, 'animation-duration', _('Duration (ms)'), 50));
        return group;
    }
}

// "<Super><Alt>i" -> "Super+Alt+I"
function acceleratorLabel(accelerator) {
    const [ok, key, mods] = Gtk.accelerator_parse(accelerator);
    return ok ? Gtk.accelerator_get_label(key, mods) : accelerator;
}
