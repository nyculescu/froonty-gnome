// SPDX-License-Identifier: GPL-3.0-or-later
// Bundled icons: btop's "B" for the tab, and the CPU, GPU, memory and
// thermometer icons of the System resource load and temperature panic
// buttons. Laid out as an icon theme for the settings window (prefs.js).

import Gio from 'gi://Gio';

export const BTOP_ICON_NAME = 'froonty-btop-symbolic';

const bundled = name => new Gio.FileIcon({
    file: Gio.File.new_for_uri(import.meta.url).get_parent().resolve_relative_path(
        `icons/hicolor/scalable/actions/${name}.svg`),
});

export const btopIcon = () => bundled(BTOP_ICON_NAME);
export const cpuIcon = () => bundled('froonty-cpu-symbolic');
export const gpuIcon = () => bundled('froonty-gpu-symbolic');
export const memoryIcon = () => bundled('froonty-memory-symbolic');
export const thermometerIcon = () => bundled('froonty-thermometer-symbolic');
