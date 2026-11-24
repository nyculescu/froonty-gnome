// SPDX-License-Identifier: GPL-3.0-or-later
// Desktop Icons NG (ding@rastersoft.com, on in Ubuntu's session) covers
// each monitor with a transparent window that takes the pointer over the
// desktop. Its extension marks those windows with a `customJS_ding` object
// whose keepAtBottom is set (its emulateX11WindowType.js), whichever title
// they have ("Desktop Icons 1", or "@!x,y;BDHF" in older versions).

import Meta from 'gi://Meta';

/** The topmost Desktop Icons window actor, or null when it is not running. */
export function desktopIconsActor() {
    // Not global.get_window_actors(): on Wayland Desktop Icons replaces it
    // to leave its own window out. The window group is in stacking order.
    return global.window_group.get_children()
        .filter(actor => actor instanceof Meta.WindowActor &&
            actor.meta_window?.customJS_ding?.keepAtBottom)
        .at(-1) ?? null;
}
