// SPDX-License-Identifier: GPL-3.0-or-later
// Notifications tab: GNOME's own notifications, newest first
// (docs/features/notifications.md). GNOME's list comes in as
// ctx.notifications (shell/messageTray.js); Froonty keeps no copy.

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {NotificationsService} from './service.js';
import {NotificationsView} from './view.js';

export default {
    id: 'notifications',
    get title() {
        return _('Notifications');
    },
    icon: 'preferences-system-notifications-symbolic',
    // On by default: a read-only view of GNOME's own list, which watches
    // nothing until it is on screen (docs/features/notifications.md §3).
    enabledKey: 'notifications-enabled',
    // Settings → Notifications → Size.
    hubSizeKeys: {width: 'notifications-width', height: 'notifications-height'},
    // The tab carries GNOME's unread dot, as the pill and 📅 do.
    unreadDot: true,
    createService: ctx => new NotificationsService(ctx.notifications),
    createView: (ctx, service) => new NotificationsView(ctx, service),
};
