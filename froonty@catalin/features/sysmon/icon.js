// SPDX-License-Identifier: GPL-3.0-or-later
// btop's "B", bundled, for the tab. Laid out as an icon theme for the
// settings window (prefs.js).

import Gio from 'gi://Gio';

export const BTOP_ICON_NAME = 'froonty-btop-symbolic';

export const btopIcon = () => new Gio.FileIcon({
    file: Gio.File.new_for_uri(import.meta.url).get_parent().resolve_relative_path(
        `icons/hicolor/scalable/actions/${BTOP_ICON_NAME}.svg`),
});
