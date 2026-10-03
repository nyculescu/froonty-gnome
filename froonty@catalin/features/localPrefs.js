// SPDX-License-Identifier: GPL-3.0-or-later
// Preferences kept out of public extension packages.

import {writingPage} from './writing/prefs.js';
import {addIconPath, zeroTierPage} from './zerotier/prefs.js';

/** Adds the local-only settings tabs; returns their page names. */
export function addLocalPrefs(window, settings) {
    addIconPath();
    window.add(zeroTierPage(settings));
    window.add(writingPage(settings, window));
    return ['zerotier', 'writing'];
}
