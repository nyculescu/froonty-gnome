// SPDX-License-Identifier: GPL-3.0-or-later
// A three-bladed fan, bundled, for the Fan tab. Laid out as an icon theme
// for the settings window (prefs.js).

import Gio from 'gi://Gio';

export const FAN_ICON_NAME = 'froonty-fan-symbolic';

export const fanIcon = () => new Gio.FileIcon({
    file: Gio.File.new_for_uri(import.meta.url).get_parent().resolve_relative_path(
        `icons/hicolor/scalable/actions/${FAN_ICON_NAME}.svg`),
});

// The same fan crossed out, for the Fan lock panic button while locked.
export const FAN_OFF_ICON_NAME = 'froonty-fan-off-symbolic';

export const fanOffIcon = () => new Gio.FileIcon({
    file: Gio.File.new_for_uri(import.meta.url).get_parent().resolve_relative_path(
        `icons/hicolor/scalable/actions/${FAN_OFF_ICON_NAME}.svg`),
});
