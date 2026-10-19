// SPDX-License-Identifier: GPL-3.0-or-later
// GTK 3 chooser helper for the LocalSend tab: "Send files" (no argument)
// writes the chosen local file paths as one JSON line; "folder START"
// (the received files' folder) writes the chosen folder's path, in a list
// too. [] when cancelled.

import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk?version=3.0';
import system from 'system';

const [mode, start] = system.programArgs;
const folder = mode === 'folder';
Gtk.init(null);
const dialog = new Gtk.FileChooserDialog({
    title: folder ? 'Save received files in' : 'Send files with LocalSend',
    action: folder ? Gtk.FileChooserAction.SELECT_FOLDER : Gtk.FileChooserAction.OPEN,
    modal: true,
});
dialog.add_button('Cancel', Gtk.ResponseType.CANCEL);
dialog.add_button(folder ? 'Select' : 'Send', Gtk.ResponseType.ACCEPT);
dialog.set_default_response(Gtk.ResponseType.ACCEPT);
dialog.set_select_multiple(!folder);
dialog.set_local_only(true);
dialog.set_create_folders(folder);
// The folder may not exist yet (the default, before the first file): its
// parent then.
if (folder && start) {
    const file = Gio.File.new_for_path(start);
    dialog.set_current_folder(file.query_exists(null) ? start : file.get_parent()?.get_path() ?? start);
}
dialog.connect('response', (_dialog, response) => {
    print(JSON.stringify(response === Gtk.ResponseType.ACCEPT ? dialog.get_filenames() : []));
    dialog.destroy();
    Gtk.main_quit();
});
dialog.show();
Gtk.main();
