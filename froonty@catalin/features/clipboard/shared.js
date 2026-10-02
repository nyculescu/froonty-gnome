// SPDX-License-Identifier: GPL-3.0-or-later
// One clipboard recorder per Shell (docs/features/clipboard.md). The
// extension holds it while the Clipboard tab is enabled, so copies are
// recorded with the island collapsed and the tab never opened; the tab
// holds it too while it exists. Its GNOME parts are made here:
//
// - St.Clipboard reads and writes the clipboard;
// - Meta.Selection 'owner-changed' tells of each copy (no polling);
// - the focused window's app tells who copied (Shell.WindowTracker).

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {ClipboardRecorder} from './recorder.js';
import {ClipboardStore, defaultFolder} from './store.js';

const CLIPBOARD = St.ClipboardType.CLIPBOARD;

function stClipboard() {
    const clipboard = St.Clipboard.get_default();
    return {
        mimetypes: () => clipboard.get_mimetypes(CLIPBOARD) ?? [],
        text: () => new Promise(resolve =>
            clipboard.get_text(CLIPBOARD, (_clipboard, text) => resolve(text))),
        // St frees its bytes once the callback returns: copy them first.
        content: mime => new Promise(resolve =>
            clipboard.get_content(CLIPBOARD, mime, (_clipboard, bytes) =>
                resolve(bytes ? new GLib.Bytes(bytes.toArray()) : null))),
        setText: text => clipboard.set_text(CLIPBOARD, text),
        setContent: (mime, bytes) => clipboard.set_content(CLIPBOARD, mime, bytes),
    };
}

// Copies to the clipboard (not the primary selection or drag and drop),
// and the clipboard being emptied (no owner): callback(cleared).
function clipboardSelection() {
    const selection = global.display.get_selection();
    return {
        connect: callback => selection.connect('owner-changed', (_selection, type, source) => {
            if (type === Meta.SelectionType.SELECTION_CLIPBOARD)
                callback(!source);
        }),
        disconnect: id => selection.disconnect(id),
    };
}

// What the focused window says it is: its app's desktop id and name, its
// window classes and its Flatpak app id.
function focusedApp() {
    const window = global.display.focus_window;
    if (!window)
        return [];
    const app = Shell.WindowTracker.get_default().get_window_app(window);
    return [app?.get_id(), app?.get_name(), window.get_wm_class(),
        window.get_wm_class_instance(), window.get_sandboxed_app_id()].filter(Boolean);
}

let shared = null;
let users = 0;

export function acquireRecorder(settings) {
    if (!shared) {
        shared = new ClipboardRecorder({
            settings,
            store: new ClipboardStore(defaultFolder()),
            clipboard: stClipboard(),
            selection: clipboardSelection(),
            focusedApp,
        });
        shared.start().catch(e => console.warn(`Froonty: clipboard history: ${e.message}`));
    }
    users++;
    return shared;
}

export function releaseRecorder() {
    if (--users > 0)
        return;
    shared?.destroy();
    shared = null;
    users = 0;
}
