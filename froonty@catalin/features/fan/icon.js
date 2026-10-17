// SPDX-License-Identifier: GPL-3.0-or-later
// A three-bladed fan, bundled for the Quick Settings slider and Fan page,
// and the same fan crossed out, for the Fan lock panic button while locked.

import Gio from 'gi://Gio';

export const FAN_ICON_NAME = 'froonty-fan-symbolic';

const bundled = name => new Gio.FileIcon({
    file: Gio.File.new_for_uri(import.meta.url).get_parent().resolve_relative_path(
        `icons/hicolor/scalable/actions/${name}.svg`),
});

export const fanIcon = () => bundled(FAN_ICON_NAME);
export const fanOffIcon = () => bundled('froonty-fan-off-symbolic');
