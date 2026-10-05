// SPDX-License-Identifier: GPL-3.0-or-later
// The clipboard switcher (docs/features/clipboard.md, "Switcher"): Super+V
// shows the newest history entry by the text cursor; with Super held, each
// further V steps to an older one and Shift+V back to a newer one;
// releasing Super inserts the shown entry where the user was typing, Escape
// cancels. Like Windows' clipboard history, driven like Alt+Tab.
//
// On while the Clipboard tab is (clipboard-enabled) and the switcher too
// (clipboard-switcher-enabled); its history is the tab's recorder. While on
// it holds:
// - the clipboard-switcher-shortcut keybinding (Main.wm.addKeybinding);
// - a hold on the shared recorder;
// - the text cursor watch (shell/inputMethod.js).
// The pop-up, its modal grab and delay exist only while the shortcut is
// held; the virtual keyboard only once something was pasted with keys.
// destroy() (disable(), every screen lock) removes all of it, and never
// touches GNOME's toggle-message-tray: that changes when the user turns
// the switcher on or off (messageTrayKey.js).
//
// Inserting, once the grab is gone and the app has the keyboard back:
// - text into a text field (Wayland's text-input: GTK, Qt, Firefox) is
//   typed through the input method; the clipboard is left alone. Not in a
//   terminal, where typed lines would run: a paste there is bracketed;
// - anything else (images, files, text elsewhere) is put on the clipboard,
//   as a click in the tab does, then pasted with Ctrl+V (Ctrl+Shift+V in a
//   terminal) from a virtual keyboard, as GNOME's on-screen keyboard sends
//   keys (ui/keyboard.js).

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {TextInput} from '../../shell/inputMethod.js';
import {MessageTrayKey, SHORTCUT_KEY} from './messageTrayKey.js';
import {acquireRecorder, focusedApp, releaseRecorder} from './shared.js';
import {isTerminal, pasteKeys} from './switching.js';
import {SwitcherPopup} from './switcherPopup.js';

export const ENABLED_KEY = 'clipboard-switcher-enabled';
const TAB_KEY = 'clipboard-enabled';
// GNOME tells nothing when a text field gets the input method's focus back
// after a modal grab: it is checked every FOCUS_CHECK_MS, at most
// FOCUS_CHECKS times, only between a release and the insertion. Without it,
// the entry goes through the clipboard instead.
const FOCUS_CHECK_MS = 20;
const FOCUS_CHECKS = 30;
// The pointer stands for the text cursor this tall (logical pixels).
const POINTER_HEIGHT = 20;

export class ClipboardSwitcher {
    constructor(settings) {
        this._settings = settings;
        this._trayKey = new MessageTrayKey(settings);
        this._on = false;
        this._action = Meta.KeyBindingAction.NONE;
        this._recorder = null;
        this._textInput = null;
        this._popup = null;
        this._keyboard = null;
        this._waitId = 0;
        this._waitDone = null;
        this._settings.connectObject(
            `changed::${TAB_KEY}`, () => this._sync(true),
            `changed::${ENABLED_KEY}`, () => this._sync(true),
            `changed::${SHORTCUT_KEY}`, () => {
                if (this._on)
                    this._trayKey.followShortcut();
            },
            this);
        // At enable(), GNOME's key follows only a change made while
        // Froonty was off (or a first start with the tab already on): with
        // the switcher still on, its record is there and nothing changes.
        this._sync(true);
    }

    destroy() {
        this._settings.disconnectObject(this);
        this._sync(false, false);
        this._keyboard = null;
    }

    /** The pop-up while it is up, for the tests. */
    get popup() {
        return this._popup;
    }

    _wanted() {
        return this._settings.get_boolean(TAB_KEY) && this._settings.get_boolean(ENABLED_KEY);
    }

    // `user`: the settings say so (also at enable()); false from destroy(),
    // which leaves GNOME's key alone.
    _sync(user, want = this._wanted()) {
        if (user) {
            if (want)
                this._trayKey.turnOn();
            else
                this._trayKey.turnOff();
        }
        if (want === this._on)
            return;
        this._on = want;
        if (want) {
            this._recorder = acquireRecorder(this._settings);
            this._textInput = new TextInput();
            this._action = Main.wm.addKeybinding(SHORTCUT_KEY, this._settings,
                Meta.KeyBindingFlags.IGNORE_AUTOREPEAT, Shell.ActionMode.NORMAL,
                (_display, _window, _event, binding) => this._onShortcut(binding));
        } else {
            this._cancelWait();
            this._popup?.destroy();
            this._popup = null;
            Main.wm.removeKeybinding(SHORTCUT_KEY);
            this._action = Meta.KeyBindingAction.NONE;
            this._textInput.destroy();
            this._textInput = null;
            releaseRecorder();
            this._recorder = null;
        }
    }

    _onShortcut(binding) {
        if (this._popup && !this._popup.finished)
            return;
        // One still fading out goes now.
        this._popup?.destroy();
        this._cancelWait();

        // What the user was typing in, before the grab takes the keyboard.
        const window = global.display.focus_window;
        const context = {
            window,
            textFocus: this._textInput.hasFocus(),
            terminal: isTerminal(focusedApp(), this._textInput.terminalPurpose()),
        };
        const recorder = this._recorder;
        const popup = new SwitcherPopup({
            entries: [...recorder.shown],
            imageFile: entry => recorder.imageFile(entry),
            action: this._action,
            anchor: this._anchor(window),
            done: entry => {
                if (entry)
                    this._insert(entry, context).catch(e =>
                        console.warn(`Froonty: clipboard switcher: ${e.message}`));
            },
        });
        popup.actor.connect('destroy', () => {
            if (this._popup === popup)
                this._popup = null;
        });
        this._popup = popup;
        popup.open(binding.get_mask());
    }

    // The text cursor; else the pointer, when it is over the focused
    // window; else that window's middle; else the pointer.
    _anchor(window) {
        const cursor = this._textInput.cursor();
        if (cursor)
            return {rect: cursor, centre: false};
        const [x, y] = global.get_pointer();
        const pointer = {x, y, width: 0, height: POINTER_HEIGHT * scaleFactor()};
        const frame = window?.get_frame_rect();
        if (!frame || (x >= frame.x && x < frame.x + frame.width && y >= frame.y && y < frame.y + frame.height))
            return {rect: pointer, centre: false};
        return {rect: {x: frame.x, y: frame.y, width: frame.width, height: frame.height}, centre: true};
    }

    async _insert(entry, {window, textFocus, terminal}) {
        const text = entry.kind === 'text' || entry.kind === 'password' ? entry.text : null;
        if (text !== null && textFocus && !terminal && await this._textFocusBack(window)) {
            this._textInput.commit(text);
            return;
        }
        // Back on the clipboard, as a click in the tab (a password stays
        // hidden and unsaved), then pasted.
        if (!this._recorder || !await this._recorder.copy(entry.id))
            return;
        if (!this._on || global.display.focus_window !== window || !window)
            return;
        this._paste(terminal);
    }

    // Resolves true once the text field of `window` has the input method's
    // focus again, false if it does not come back.
    _textFocusBack(window) {
        const back = () => global.display.focus_window === window && this._textInput?.hasFocus();
        if (back())
            return Promise.resolve(true);
        return new Promise(resolve => {
            let left = FOCUS_CHECKS;
            this._waitDone = resolve;
            this._waitId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FOCUS_CHECK_MS, () => {
                const ok = back();
                if (!ok && --left > 0)
                    return GLib.SOURCE_CONTINUE;
                this._waitId = 0;
                this._waitDone = null;
                resolve(ok);
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    _cancelWait() {
        if (this._waitId)
            GLib.source_remove(this._waitId);
        this._waitId = 0;
        this._waitDone?.(false);
        this._waitDone = null;
    }

    // Ctrl+V (or Ctrl+Shift+V): every key pressed in order, then released
    // in reverse, so none stays down.
    _paste(terminal) {
        if (!this._keyboard) {
            const seat = global.stage.context.get_backend().get_default_seat();
            this._keyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        }
        const keyvals = pasteKeys(terminal).map(name => Clutter[`KEY_${name}`]);
        const time = GLib.get_monotonic_time();
        keyvals.forEach((keyval, i) =>
            this._keyboard.notify_keyval(time + i, keyval, Clutter.KeyState.PRESSED));
        [...keyvals].reverse().forEach((keyval, i) =>
            this._keyboard.notify_keyval(time + keyvals.length + i, keyval, Clutter.KeyState.RELEASED));
    }
}

function scaleFactor() {
    return St.ThemeContext.get_for_stage(global.stage).scale_factor;
}
