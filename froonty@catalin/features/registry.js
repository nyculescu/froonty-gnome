// SPDX-License-Identifier: GPL-3.0-or-later
// Every hub feature, in tab order. Adding or removing a feature is a
// one-line change here (plus its settings tab in prefs.js, which runs in a
// separate GTK process and cannot load these Shell-side modules). Each one
// can be turned off (enabledKey); the date and time are in the island
// itself (the collapsed pill, the hub header's date pill).

import calendar from './calendar/index.js';
import notes from './notes/index.js';
import notifications from './notifications/index.js';
// local:begin local-features (working-tree only; tools/pack-public strips it)
import {LOCAL_FEATURES} from './localFeatures.js';
// local:end local-features

export const FEATURES = [
    calendar,
    notifications,
    notes,
    // local:begin local-features
    ...LOCAL_FEATURES,
    // local:end local-features
];
