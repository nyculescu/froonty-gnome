// SPDX-License-Identifier: GPL-3.0-or-later
// Clipboard settings tab: turn the history on, how many entries it keeps,
// the switcher (Super+V), which apps it never records, and the tab's size
// (docs/features/clipboard.md). Runs in the preferences process.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const IGNORED_KEY = 'clipboard-ignored-apps';
const SHORTCUT_KEY = 'clipboard-switcher-shortcut';
const SIZE_KEYS = ['clipboard-width', 'clipboard-height'];

export function clipboardPage(settings) {
    const page = new Adw.PreferencesPage({
        name: 'clipboard',
        title: _('Clipboard'),
        icon_name: 'edit-paste-symbolic',
    });

    const group = new Adw.PreferencesGroup({
        title: _('Clipboard history'),
        description: _('While on, Froonty reads the clipboard on every copy and keeps what you copy or cut (text, images, file and folder locations) on this computer only, readable by you only, so you can copy it again from the Clipboard tab. Nothing is sent anywhere. Clear it in the tab.'),
    });
    group.add(switchRow(settings, 'clipboard-enabled', _('Show the Clipboard tab and record history')));
    group.add(spinRow(settings, 'clipboard-history-size', _('Entries to keep')));
    page.add(group);

    page.add(switcherGroup(settings));
    page.add(privacyGroup(settings));
    page.add(sizeGroup(settings));
    return page;
}

// The switcher, its shortcut, and what it changes in GNOME's settings
// (features/clipboard/messageTrayKey.js).
function switcherGroup(settings) {
    const group = new Adw.PreferencesGroup({
        title: _('Switcher'),
        description: _('Hold Super and press V (the default shortcut): the newest entry shows by the text cursor. Press V again for older ones, Shift+V for newer ones; release Super to insert it where you were typing, or press Esc. Only while the Clipboard tab is on.'),
    });
    const row = new Adw.SwitchRow({
        title: _('Paste from the history with the shortcut'),
        subtitle: _('Changes a GNOME setting: the notification list loses this shortcut and opens with Super+M. Turning this or the tab off puts your previous shortcut back.'),
    });
    settings.bind('clipboard-switcher-enabled', row, 'active', Gio.SettingsBindFlags.DEFAULT);
    group.add(row);

    // Typed, as GNOME writes it (<Super>v); it needs a modifier, whose
    // release inserts.
    const shortcut = new Adw.EntryRow({
        title: _('Shortcut, e.g. <Super>v'),
        use_markup: false,
        show_apply_button: true,
    });
    const sync = () => {
        shortcut.text = settings.get_strv(SHORTCUT_KEY).join(', ');
        shortcut.remove_css_class('error');
    };
    sync();
    settings.connect(`changed::${SHORTCUT_KEY}`, sync);
    shortcut.connect('apply', () => {
        const accelerators = shortcut.text.split(',').map(word => word.trim()).filter(Boolean);
        const valid = accelerators.length > 0 && accelerators.every(accelerator => {
            const [ok, key, mods] = Gtk.accelerator_parse(accelerator);
            return ok && key !== 0 && mods !== 0;
        });
        if (valid)
            settings.set_strv(SHORTCUT_KEY, accelerators);
        else
            shortcut.add_css_class('error');
    });
    settings.bind('clipboard-switcher-enabled', shortcut, 'sensitive', Gio.SettingsBindFlags.GET);
    group.add(shortcut);

    const reset = new Gtk.Button({
        label: _('Default shortcut'),
        valign: Gtk.Align.CENTER,
        css_classes: ['flat'],
    });
    const syncReset = () => {
        reset.sensitive = settings.get_user_value(SHORTCUT_KEY) !== null;
    };
    syncReset();
    settings.connect(`changed::${SHORTCUT_KEY}`, syncReset);
    reset.connect('clicked', () => settings.reset(SHORTCUT_KEY));
    group.header_suffix = reset;
    return group;
}

function privacyGroup(settings) {
    const group = new Adw.PreferencesGroup({
        title: _('Passwords'),
        description: _('A password is never saved. The latest one is listed as •••••••• and can be copied again, until the minutes below pass, the clipboard is cleared or something else is copied, whichever comes first.'),
    });
    const minutes = spinRow(settings, 'clipboard-password-minutes', _('Show a copied password for (minutes)'));
    minutes.subtitle = _('Hidden, in memory only. 0: never list passwords');
    group.add(minutes);
    const detect = new Adw.SwitchRow({
        title: _('Recognise passwords in copied text'),
        subtitle: _('Browsers do not mark copied passwords. One word mixing at least three of lower case, upper case, digits and symbols is treated as one (API keys and tokens too)'),
    });
    settings.bind('clipboard-detect-passwords', detect, 'active', Gio.SettingsBindFlags.DEFAULT);
    group.add(detect);
    const row = new Adw.EntryRow({
        title: _('Password apps: everything copied there is a password'),
        show_apply_button: true,
    });
    const sync = () => {
        row.text = settings.get_strv(IGNORED_KEY).join(', ');
    };
    sync();
    settings.connect(`changed::${IGNORED_KEY}`, sync);
    row.connect('apply', () => {
        const words = row.text.split(',').map(word => word.trim()).filter(Boolean);
        settings.set_strv(IGNORED_KEY, words);
    });
    group.add(row);

    const reset = new Gtk.Button({
        label: _('Default list'),
        valign: Gtk.Align.CENTER,
        css_classes: ['flat'],
    });
    const syncReset = () => {
        reset.sensitive = settings.get_user_value(IGNORED_KEY) !== null;
    };
    syncReset();
    settings.connect(`changed::${IGNORED_KEY}`, syncReset);
    reset.connect('clicked', () => settings.reset(IGNORED_KEY));
    group.header_suffix = reset;
    return group;
}

// Island size while the Clipboard tab is shown; applies live. As Notes'.
function sizeGroup(settings) {
    const reset = new Gtk.Button({
        label: _('Default size'),
        valign: Gtk.Align.CENTER,
        css_classes: ['flat'],
    });
    const group = new Adw.PreferencesGroup({
        title: _('Size'),
        description: _('Of the island while the Clipboard tab is shown, in logical pixels. Or drag the open island’s bottom-right corner.'),
        header_suffix: reset,
    });
    group.add(spinRow(settings, 'clipboard-width', _('Width')));
    group.add(spinRow(settings, 'clipboard-height', _('Height')));

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
