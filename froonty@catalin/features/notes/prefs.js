// SPDX-License-Identifier: GPL-3.0-or-later
// Notes settings tab. Runs in the preferences process (GTK 4 + libadwaita),
// so it imports nothing from the Shell side of the feature.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const FOLDER_KEY = 'notes-folder';
const SIZE_KEYS = ['notes-width', 'notes-height'];

export function notesPage(settings) {
    const page = new Adw.PreferencesPage({
        name: 'notes',
        title: _('Notes'),
        icon_name: 'document-edit-symbolic',
    });

    const group = new Adw.PreferencesGroup({
        title: _('Notes'),
        description: _('Each note is a Markdown (.md) file in the folder below. Deleted notes go to the Trash.'),
    });
    const enabled = new Adw.SwitchRow({title: _('Show the Notes tab')});
    settings.bind('notes-enabled', enabled, 'active', Gio.SettingsBindFlags.DEFAULT);
    group.add(enabled);
    group.add(folderRow(settings));

    page.add(group);
    page.add(sizeGroup(settings));
    return page;
}

// Island size while the Notes tab is shown; applies live.
function sizeGroup(settings) {
    const reset = new Gtk.Button({
        label: _('Default size'),
        valign: Gtk.Align.CENTER,
        css_classes: ['flat'],
    });
    const group = new Adw.PreferencesGroup({
        title: _('Size'),
        description: _('Of the island while the Notes tab is shown, in logical pixels.'),
        header_suffix: reset,
    });
    group.add(spinRow(settings, 'notes-width', _('Width')));
    group.add(spinRow(settings, 'notes-height', _('Height')));

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

// Spin bounds are read from the schema's <range>, as in prefs.js.
function spinRow(settings, key, title) {
    const [, [lower, upper]] = settings.settings_schema.get_key(key)
        .get_range().recursiveUnpack();
    const row = Adw.SpinRow.new_with_range(lower, upper, 1);
    row.title = title;
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function folderRow(settings) {
    const row = new Adw.ActionRow({
        title: _('Folder'),
        subtitle_selectable: true,
        use_markup: false,
    });

    const choose = new Gtk.Button({label: _('Choose…'), valign: Gtk.Align.CENTER});
    const reset = new Gtk.Button({
        label: _('Default'),
        valign: Gtk.Align.CENTER,
        tooltip_text: defaultFolder(),
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
            title: _('Notes folder'),
            initial_folder: Gio.File.new_for_path(row.subtitle),
        });
        dialog.select_folder(row.get_root(), null, (_dialog, result) => {
            try {
                const folder = dialog.select_folder_finish(result);
                settings.set_string(FOLDER_KEY, folder.get_path());
            } catch (e) {
                if (!e.matches(Gtk.DialogError, Gtk.DialogError.DISMISSED))
                    logError(e);
            }
        });
    });
    return row;
}

// Must match NotesService.folder (ctx.dataDir is $XDG_DATA_HOME/froonty).
function defaultFolder() {
    return GLib.build_filenamev([GLib.get_user_data_dir(), 'froonty', 'notes']);
}
