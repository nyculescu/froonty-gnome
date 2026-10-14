// SPDX-License-Identifier: GPL-3.0-or-later
// GTK 3 chooser helper; writes the selected local file path as one JSON line.

import Gtk from 'gi://Gtk?version=3.0';

Gtk.init(null);
const dialog = new Gtk.FileChooserDialog({
    title: 'Choose an image',
    action: Gtk.FileChooserAction.OPEN,
    modal: true,
});
dialog.add_button('Cancel', Gtk.ResponseType.CANCEL);
dialog.add_button('Open', Gtk.ResponseType.ACCEPT);
dialog.set_default_response(Gtk.ResponseType.ACCEPT);
dialog.set_select_multiple(false);
const filter = new Gtk.FileFilter();
filter.set_name('Images');
filter.add_pixbuf_formats();
dialog.add_filter(filter);
dialog.connect('response', (_dialog, response) => {
    print(JSON.stringify(response === Gtk.ResponseType.ACCEPT ? dialog.get_filename() : null));
    dialog.destroy();
    Gtk.main_quit();
});
dialog.show();
Gtk.main();
