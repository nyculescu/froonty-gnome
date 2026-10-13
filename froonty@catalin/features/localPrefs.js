// SPDX-License-Identifier: GPL-3.0-or-later
// The settings pages of the local features (including Fan, which is not a
// hub tab), in their navigation order, then Brightness (a part, not a tab).
// tools/pack-public replaces this file with one that adds none.

import {addIconPath as addBreakIconPath, breakPage} from './break/prefs.js';
import {brightnessPage} from './brightness/prefs.js';
import {addIconPath as addClaudeIconPath, claudePage} from './claude/prefs.js';
import {clipboardPage} from './clipboard/prefs.js';
import {fanPage} from './fan/prefs.js';
import {formulasPage} from './formulas/prefs.js';
import {killProcessPage} from './killprocess/prefs.js';
import {mediaPage} from './media/prefs.js';
import {sysmonPage} from './sysmon/prefs.js';
import {timezonesPage} from './timezonePlanner/prefs.js';
import {writingPage} from './writing/prefs.js';
import {addIconPath as addZeroTierIconPath, zeroTierPage} from './zerotier/prefs.js';

/** Their bundled icons, also used by the Panic buttons page. */
export function addLocalIconPaths() {
    addClaudeIconPath();
    addBreakIconPath();
    addZeroTierIconPath();
}

/**
 * Creates the local features' settings pages.
 *
 * @param {Adw.PreferencesWindow} window
 * @param {Gio.Settings} settings
 * @param {Gtk.Stack} pageStack settings pages, used to track the active page
 * @returns {Adw.PreferencesPage[]}
 */
export function addLocalPrefs(window, settings, pageStack) {
    const pages = [
        mediaPage(settings),
        claudePage(settings),
        sysmonPage(settings),
        fanPage(settings, pageStack, window),
        clipboardPage(settings),
        killProcessPage(settings),
        breakPage(settings),
        zeroTierPage(settings),
        writingPage(settings, window),
        formulasPage(settings),
        // Not a hub tab (localFeatures.js, LOCAL_PARTS).
        brightnessPage(settings),
        timezonesPage(settings),
    ];
    return pages;
}
