// SPDX-License-Identifier: GPL-3.0-or-later
// Quick Settings: an item right under GNOME's own brightness slider
// (Software brightness, features/brightness/overlay.js).

import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// GNOME makes its own items after the panel, asynchronously (panel.js
// _setupIndicators): wait for its brightness slider, up to 5 s, then add
// the item at the end.
const RETRY_MS = 100;
const TRIES = 50;
// Both columns, as GNOME's sliders.
const FULL_WIDTH = 2;

/**
 * Adds a full-width item under GNOME's brightness slider.
 *
 * @param {QuickSettingsItem} item the item to add (destroying it removes it;
 *   its menu, which Quick Settings keeps in its overlay, needs destroying too)
 * @returns {Function} cancels the add while it waits
 */
export function addUnderBrightness(item) {
    let tries = 0;
    let id = 0;
    const place = () => {
        const quickSettings = Main.panel.statusArea.quickSettings;
        // Private: the indicator panel.js keeps GNOME's slider in.
        const gnome = quickSettings?._brightness?.quickSettingsItems.at(-1);
        if (!gnome && ++tries < TRIES)
            return GLib.SOURCE_CONTINUE;
        id = 0;
        const next = gnome?.get_parent() ? gnome.get_next_sibling() : null;
        if (next)
            quickSettings.menu.insertItemBefore(item, next, FULL_WIDTH);
        else
            quickSettings?.menu.addItem(item, FULL_WIDTH);
        return GLib.SOURCE_REMOVE;
    };
    if (place() === GLib.SOURCE_CONTINUE)
        id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RETRY_MS, place);
    return () => {
        if (id)
            GLib.source_remove(id);
        id = 0;
    };
}
