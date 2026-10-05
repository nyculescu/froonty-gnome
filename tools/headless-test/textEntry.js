// SPDX-License-Identifier: GPL-3.0-or-later
// A window with one text field, for the clipboard switcher's checks
// (checks.js testClipboardSwitcher): GTK 4, so the field uses Wayland's
// text-input protocol and GNOME Shell's input method knows where its
// cursor is. Its text is written to <dir>/text after every change, and
// every key press that reaches the window to <dir>/keys ("ctrl v", ...),
// so the checks can tell text typed through the input method from a
// paste with Ctrl+V.
//
//   gjs -m textEntry.js <dir>

import GLib from 'gi://GLib';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk?version=4.0';
import System from 'system';

const [dir] = System.programArgs;
const write = (name, text) => GLib.file_set_contents(GLib.build_filenamev([dir, name]), text);
const keys = [];
write('text', '');
write('keys', '');

const app = new Gtk.Application({
    application_id: 'org.froonty.TestEntry',
    flags: Gio.ApplicationFlags.NON_UNIQUE,
});
app.connect('activate', () => {
    const window = new Gtk.ApplicationWindow({
        application: app,
        title: 'Froonty test entry',
        default_width: 420,
        default_height: 160,
    });
    const entry = new Gtk.Entry({margin_top: 40, margin_start: 30, margin_end: 30, valign: Gtk.Align.START});
    entry.connect('changed', () => write('text', entry.text));
    const controller = new Gtk.EventControllerKey({propagation_phase: Gtk.PropagationPhase.CAPTURE});
    controller.connect('key-pressed', (_c, keyval, _code, state) => {
        const mods = [[Gdk.ModifierType.CONTROL_MASK, 'ctrl'], [Gdk.ModifierType.SHIFT_MASK, 'shift']]
            .filter(([mask]) => state & mask).map(([, name]) => name);
        keys.push([...mods, Gdk.keyval_name(Gdk.keyval_to_lower(keyval))].join(' '));
        write('keys', keys.join('\n'));
        return false;
    });
    window.add_controller(controller);
    window.set_child(entry);
    window.present();
    entry.grab_focus();
});
app.run([System.programInvocationName]);
