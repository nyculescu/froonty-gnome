// SPDX-License-Identifier: GPL-3.0-or-later
// Preferences kept out of public extension packages.

import {addIconPath, zeroTierPage} from './zerotier/prefs.js';

export function addLocalPrefs(window, settings) {
    addIconPath();
    window.add(zeroTierPage(settings));
}