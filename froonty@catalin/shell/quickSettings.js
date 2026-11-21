// SPDX-License-Identifier: GPL-3.0-or-later
// Quick Settings: waiting for GNOME's own items, and adding items right
// under its brightness slider (Software brightness, the pad speed slider).

import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// GNOME makes its own items after the panel, asynchronously (panel.js
// _setupIndicators): wait for them, up to 5 s.
const RETRY_MS = 100;
const TRIES = 50;
// Both columns, as GNOME's sliders.
const FULL_WIDTH = 2;
// The order of each item added here.
const orders = new WeakMap();

/**
 * Calls `found(quickSettings)` until it returns true (GNOME's items it
 * needs are there) or 5 s have passed; the last call may find them missing.
 *
 * @param {Function} found (quickSettings or undefined, last) → whether done
 * @returns {Function} cancels the wait
 */
export function whenQuickSettings(found) {
    let tries = 0;
    let id = 0;
    const attempt = () => {
        const last = ++tries >= TRIES;
        if (!found(Main.panel.statusArea.quickSettings, last) && !last)
            return GLib.SOURCE_CONTINUE;
        id = 0;
        return GLib.SOURCE_REMOVE;
    };
    if (attempt() === GLib.SOURCE_CONTINUE)
        id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RETRY_MS, attempt);
    return () => {
        if (id)
            GLib.source_remove(id);
        id = 0;
    };
}

/**
 * GNOME's own Quick Settings item of an indicator panel.js makes, or null.
 *
 * @param {object|undefined} quickSettings Main.panel.statusArea.quickSettings
 * @param {string} indicator 'brightness' (its slider) or 'nightLight' (its tile)
 * @returns {QuickSettingsItem|null}
 */
export function gnomeItem(quickSettings, indicator) {
    // Private: the indicators panel.js keeps GNOME's items in.
    return quickSettings?.[`_${indicator}`]?.quickSettingsItems.at(-1) ?? null;
}

/**
 * Adds a full-width item under GNOME's brightness slider, after the items
 * added here with the same or a lower order, so their order does not
 * depend on which was added first. Without GNOME's slider (after 5 s), it
 * goes at the end.
 *
 * @param {QuickSettingsItem} item the item to add (destroying it removes it;
 *   its menu, which Quick Settings keeps in its overlay, needs destroying too)
 * @param {number} [order] lower ones go higher
 * @returns {Function} cancels the add while it waits
 */
export function addUnderBrightness(item, order = 0) {
    orders.set(item, order);
    return whenQuickSettings((quickSettings, last) => {
        const gnome = gnomeItem(quickSettings, 'brightness');
        if (!gnome && !last)
            return false;
        let next = gnome?.get_parent() ? gnome.get_next_sibling() : null;
        while (next && orders.get(next) <= order)
            next = next.get_next_sibling();
        if (next)
            quickSettings.menu.insertItemBefore(item, next, FULL_WIDTH);
        else
            quickSettings?.menu.addItem(item, FULL_WIDTH);
        return true;
    });
}
