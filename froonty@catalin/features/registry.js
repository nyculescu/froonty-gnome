// SPDX-License-Identifier: GPL-3.0-or-later
// Every hub feature, in tab order. Adding or removing a feature is a
// one-line change here (plus its settings tab in prefs.js, which runs in a
// separate GTK process and cannot load these Shell-side modules).

import clock from './clock/index.js';

export const FEATURES = [
    clock,
];
