// SPDX-License-Identifier: GPL-3.0-or-later
// Every hub feature, in tab order. Adding or removing a feature is a
// one-line change here (plus its settings tab in prefs.js, which runs in a
// separate GTK process and cannot load these Shell-side modules).

import claude from './claude/index.js';
import clipboard from './clipboard/index.js';
import clock from './clock/index.js';
import notes from './notes/index.js';
import sysmon from './sysmon/index.js';
import {LOCAL_FEATURES} from './localFeatures.js';

export const FEATURES = [
    clock,
    notes,
    claude,
    sysmon,
    clipboard,
    ...LOCAL_FEATURES,
];
