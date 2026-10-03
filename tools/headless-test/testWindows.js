// SPDX-License-Identifier: GPL-3.0-or-later
// A stand-in for a terminal or VS Code with several windows, for the
// Claude attention bar's checks (checks.js testClaudeAttentionWindows):
// one GTK 4 process, application id org.froonty.TestWindows (run.sh
// installs a desktop file of that name, so GNOME Shell counts every window
// as one app's), one window per title given on the command line.
//
//   gjs -m testWindows.js "main.js - Alpha - Test Windows" "✳ Claude Code"

import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk?version=4.0';
import System from 'system';

const titles = System.programArgs.length > 0 ? System.programArgs : ['Test Windows'];
const app = new Gtk.Application({
    application_id: 'org.froonty.TestWindows',
    flags: Gio.ApplicationFlags.NON_UNIQUE,
});
app.connect('activate', () => {
    for (const title of titles) {
        new Gtk.ApplicationWindow({
            application: app,
            title,
            default_width: 360,
            default_height: 120,
        }).present();
    }
});
app.run([System.programInvocationName]);
