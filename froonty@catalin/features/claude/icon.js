// SPDX-License-Identifier: GPL-3.0-or-later
// Claude's Spark, bundled, for the Shell side (the tab and the panic
// button). Laid out as an icon theme for the settings window (prefs.js).

import Gio from 'gi://Gio';

export const SPARK_ICON_NAME = 'froonty-claude-symbolic';

export const sparkIcon = () => new Gio.FileIcon({
    file: Gio.File.new_for_uri(import.meta.url).get_parent().resolve_relative_path(
        `icons/hicolor/scalable/actions/${SPARK_ICON_NAME}.svg`),
});
