// SPDX-License-Identifier: GPL-3.0-or-later
// Every hub feature, in tab order. Adding or removing a feature is a
// one-line change here (plus its settings tab in prefs.js, which runs in a
// separate GTK process and cannot load these Shell-side modules).

import calendar from './calendar/index.js';
import clock from './clock/index.js';
import notes from './notes/index.js';
import notifications from './notifications/index.js';
// local:begin local-features (working-tree only; tools/pack-public strips it)
import {LOCAL_FEATURES} from './localFeatures.js';
// local:end local-features

export const FEATURES = [
    clock,
    calendar,
    notifications,
    notes,
    // local:begin local-features
    ...LOCAL_FEATURES,
    // local:end local-features
];
