// SPDX-License-Identifier: GPL-3.0-or-later
// The settings tabs of localFeatures.js's features, in the same order.
// tools/pack-public replaces this file with one that adds none.

import {addIconPath as addBreakIconPath, breakPage} from './break/prefs.js';
import {addIconPath as addClaudeIconPath, claudePage} from './claude/prefs.js';
import {clipboardPage} from './clipboard/prefs.js';
import {formulasPage} from './formulas/prefs.js';
import {killProcessPage} from './killprocess/prefs.js';
import {mediaPage} from './media/prefs.js';
import {sysmonPage} from './sysmon/prefs.js';
import {writingPage} from './writing/prefs.js';
import {addIconPath as addZeroTierIconPath, zeroTierPage} from './zerotier/prefs.js';

/** Their bundled icons, also used by the Panic buttons page. */
export function addLocalIconPaths() {
    addClaudeIconPath();
    addBreakIconPath();
    addZeroTierIconPath();
}

/**
 * Adds the local features' settings tabs.
 *
 * @returns {string[]} their page names
 */
export function addLocalPrefs(window, settings) {
    const pages = [
        mediaPage(settings),
        claudePage(settings),
        sysmonPage(settings),
        clipboardPage(settings),
        killProcessPage(settings),
        breakPage(settings),
        zeroTierPage(settings),
        writingPage(settings, window),
        formulasPage(settings),
    ];
    for (const page of pages)
        window.add(page);
    return pages.map(page => page.name);
}
