// SPDX-License-Identifier: GPL-3.0-or-later
// The Ubuntu dock (ubuntu-dock@ubuntu.com, from Dash to Dock), as shown:
// its container in the Shell's UI group carries its own name
// (`dashtodockContainer`, its docking.js).

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

/** The dock's container actor, or null when it is not running. */
export function dockActor() {
    return Main.uiGroup.get_children().find(actor => actor.name === 'dashtodockContainer') ?? null;
}

/** Where the dock is on the stage, or null when it is not running or hidden. */
export function dockRect(actor = dockActor()) {
    if (!actor?.visible)
        return null;
    const [x, y] = actor.get_transformed_position();
    const [width, height] = actor.get_transformed_size();
    return {x, y, width, height};
}
