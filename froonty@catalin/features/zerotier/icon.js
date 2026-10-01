// SPDX-License-Identifier: GPL-3.0-or-later

import Gio from 'gi://Gio';

export const ZEROTIER_ICON_NAME = 'froonty-zerotier-symbolic';

export const zeroTierIcon = () => new Gio.FileIcon({
    file: Gio.File.new_for_uri(import.meta.url).get_parent()
        .get_child('icons').get_child('hicolor').get_child('scalable')
        .get_child('actions').get_child(`${ZEROTIER_ICON_NAME}.svg`),
});