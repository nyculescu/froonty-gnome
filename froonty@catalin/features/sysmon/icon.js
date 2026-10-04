// SPDX-License-Identifier: GPL-3.0-or-later
// btop's "B", bundled, for the tab, and a processor chip for the CPU load
// panic button. Laid out as an icon theme for the settings window
// (prefs.js).

import Gio from 'gi://Gio';

export const BTOP_ICON_NAME = 'froonty-btop-symbolic';

export const btopIcon = () => new Gio.FileIcon({
    file: Gio.File.new_for_uri(import.meta.url).get_parent().resolve_relative_path(
        `icons/hicolor/scalable/actions/${BTOP_ICON_NAME}.svg`),
});

// A processor chip, for the "CPU load" panic button (panic/cpuLoad.js).
export const CPU_ICON_NAME = 'froonty-cpu-symbolic';

export const cpuIcon = () => new Gio.FileIcon({
    file: Gio.File.new_for_uri(import.meta.url).get_parent().resolve_relative_path(
        `icons/hicolor/scalable/actions/${CPU_ICON_NAME}.svg`),
});
