// SPDX-License-Identifier: GPL-3.0-or-later
// Notes settings tab. Runs in the preferences process (GTK 4 + libadwaita),
// so it imports nothing from the Shell side of the feature.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const FOLDER_KEY = 'notes-folder';

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
    return page;
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
