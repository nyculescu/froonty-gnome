// SPDX-License-Identifier: GPL-3.0-or-later
// Fan settings shortcut. The page is in Froonty's preferences, not the hub.

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {fanIcon} from './icon.js';
export default {
    id: 'fan',
    settingsPage: true,
    get title() {
        return _('Fan settings');
    },
    get icon() {
        return fanIcon();
    },
};
