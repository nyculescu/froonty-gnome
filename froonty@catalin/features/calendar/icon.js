// SPDX-License-Identifier: GPL-3.0-or-later
// The Calendar tab's icon, bundled: Adwaita's only calendar icon,
// x-office-calendar-symbolic, stands for GNOME's own calendar menu
// elsewhere. Laid out as an icon theme for the settings window (prefs.js).

import Gio from 'gi://Gio';

export const CALENDAR_ICON_NAME = 'froonty-calendar-symbolic';

export const calendarIcon = () => new Gio.FileIcon({
    file: Gio.File.new_for_uri(import.meta.url).get_parent().resolve_relative_path(
        `icons/hicolor/scalable/actions/${CALENDAR_ICON_NAME}.svg`),
});
