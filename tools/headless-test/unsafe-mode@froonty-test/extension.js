// SPDX-License-Identifier: GPL-3.0-or-later
// TEST ONLY: see metadata.json. Unsafe mode lets org.gnome.Shell.Eval run
// arbitrary code, which is what the headless test runner needs and exactly
// why this must never be installed in a real session.

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

export default class UnsafeModeHelper extends Extension {
    enable() {
        global.context.unsafe_mode = true;
    }

    disable() {
        global.context.unsafe_mode = false;
    }
}
