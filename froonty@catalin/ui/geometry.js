// SPDX-License-Identifier: GPL-3.0-or-later
// Island geometry: sizes in stage pixels and the offset from the monitor
// top. Pure calculations over settings, the concealed panel clock and the
// monitor; no actors are touched here.
//
// Settings and feature sizes are in logical pixels; actor sizes are in stage
// pixels. (On Wayland the scale factor is 1 and stage pixels are logical.)

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export class IslandGeometry {
    /**
     * @param {Gio.Settings} settings
     * @param {PanelClock} panelClock
     * @param {St.ThemeContext} themeContext
     */
    constructor(settings, panelClock, themeContext) {
        this._settings = settings;
        this._panelClock = panelClock;
        this._themeContext = themeContext;
    }

    // The concealed top bar clock is transparent but still clickable, so the
    // collapsed pill always covers it completely: collapsed-width and
    // collapsed-height are minimums.
    /**
     * @param {number} [contentWidth] stage px the collapsed content needs
     *   (a feature's accessory beside the time); the pill only ever grows
     *   for it
     */
    collapsedSize(contentWidth = 0) {
        const scale = this._themeContext.scale_factor;
        const cover = this._coverSize();
        let width = Math.max(this._settings.get_int('collapsed-width') * scale, cover.width,
            Math.ceil(contentWidth));
        // Same parity as the cover keeps the pill on whole pixels.
        if (width > cover.width && cover.width > 0 && (width - cover.width) % 2 !== 0)
            width += 1;
        return {
            width,
            height: Math.max(this._settings.get_int('collapsed-height') * scale, cover.height),
        };
    }

    /**
     * @param {?object} feature active hub feature; its hubSizeKeys (settings
     *   the user can change) or hubSize win
     * @param {number} [extraHeight] logical px a feature adds for now
     *   (view.extraHeight); the island then stays on the monitor
     * @param {?object} [live] {width, height} in logical px in place of
     *   the hubSizeKeys' values (the resize grip, while dragged)
     */
    expandedSize(feature, extraHeight = 0, live = null) {
        const scale = this._themeContext.scale_factor;
        const keys = feature?.hubSizeKeys;
        const size = keys && live ? live : keys
            ? {width: this._settings.get_int(keys.width), height: this._settings.get_int(keys.height)}
            : feature?.hubSize;
        let height = (size?.height ?? this._settings.get_int('expanded-height')) * scale;
        if (extraHeight > 0) {
            height += extraHeight * scale;
            const monitor = Main.layoutManager.primaryMonitor;
            if (monitor)
                height = Math.min(height, monitor.height - this.topOffset(monitor) - 16 * scale);
        }
        return {
            width: (size?.width ?? this._settings.get_int('expanded-width')) * scale,
            height,
        };
    }

    // Offset of the pill's top edge from the monitor top. The collapsed pill
    // is vertically centered on the concealed clock button, or on the top
    // bar when the clock is visible; the expanded island grows downward from
    // the same top edge.
    topOffset(monitor) {
        const bounds = this._panelClock.coverBounds;
        const centerY = bounds
            ? (bounds.y1 + bounds.y2) / 2 - monitor.y
            : Main.layoutManager.panelBox.height / 2;
        const {height} = this.collapsedSize();
        return Math.max(0, Math.floor(centerY - height / 2));
    }

    // The pill is centered on the monitor, but the panel centers the clock
    // with its own rounding and shifts it when the left box is crowded. So
    // the pill must reach the clock's farther edge on both sides of the
    // monitor center. Vertically the pill is centered on the clock itself.
    _coverSize() {
        const bounds = this._panelClock.coverBounds;
        const monitor = Main.layoutManager.primaryMonitor;
        if (!bounds || !monitor)
            return {width: 0, height: 0};

        const centerX = monitor.x + monitor.width / 2;
        let width = Math.ceil(2 * Math.max(centerX - bounds.x1, bounds.x2 - centerX));
        // Same parity as the monitor width keeps the centered pill on whole
        // pixels, so rounding cannot expose a 1px sliver of the clock.
        if ((monitor.width - width) % 2 !== 0)
            width += 1;

        return {width, height: Math.ceil(bounds.y2 - bounds.y1)};
    }
}
