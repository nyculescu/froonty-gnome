// SPDX-License-Identifier: GPL-3.0-or-later
// Every hub feature, in tab order. Adding or removing a feature is a
// one-line change here (plus its settings tab in prefs.js, which runs in a
// separate GTK process and cannot load these Shell-side modules).

// `break` is a reserved word.
import breakFeature from './break/index.js';
import calendar from './calendar/index.js';
import claude from './claude/index.js';
import clipboard from './clipboard/index.js';
import clock from './clock/index.js';
import killprocess from './killprocess/index.js';
import media from './media/index.js';
import notes from './notes/index.js';
import notifications from './notifications/index.js';
import sysmon from './sysmon/index.js';
import {LOCAL_FEATURES} from './localFeatures.js';

export const FEATURES = [
    clock,
    calendar,
    notifications,
    media,
    notes,
    claude,
    sysmon,
    clipboard,
    killprocess,
    breakFeature,
    ...LOCAL_FEATURES,
];
