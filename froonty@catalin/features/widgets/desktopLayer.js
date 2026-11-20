// SPDX-License-Identifier: GPL-3.0-or-later
// Optional desktop surface for a pinned widget. It lives on GNOME's
// background actor group, above the wallpaper and behind normal windows.

import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export class DesktopWidgetContainer {
    constructor() {
        this.actor = new St.BoxLayout({
            style_class: 'froonty-desktop-widget-layer',
            vertical: true,
            reactive: true,
            track_hover: true,
            x: 40,
            y: 80,
        });
        Main.layoutManager._backgroundGroup.add_child(this.actor);
    }

    addWidget(widgetActor) {
        if (!widgetActor || !this.actor)
            return;
        if (widgetActor.get_parent() === this.actor)
            return;
        this.actor.add_child(widgetActor);
    }

    destroy() {
        if (this.actor) {
            this.actor.destroy();
            this.actor = null;
        }
    }
}
