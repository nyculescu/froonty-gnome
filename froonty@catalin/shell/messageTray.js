// SPDX-License-Identifier: GPL-3.0-or-later
// Adapter around GNOME Shell's message tray, for the Notifications tab
// (docs/features/notifications.md). The feature reaches it as
// ctx.notifications and never imports this file.
//
// PRIVATE / INTERNAL API (DESIGN.md §6.3). Verified against GNOME Shell
// 50.1:
//
//   Main.messageTray                    MessageTray (ui/main.js)
//   Main.messageTray._notificationQueue the notifications waiting for their
//                                       banner (private field; read only,
//                                       never changed). Without it, every
//                                       listed one can be marked seen
//   MessageTray.Urgency.CRITICAL        3 (ui/messageTray.js)
//   MessageTray.NotificationDestroyedReason.DISMISSED
//                                       2, what GNOME's own close button
//                                       passes (messageList.js)
//   misc/util.js fixMarkup              how GNOME's list cleans titles and
//                                       bodies before showing them
//   misc/dateUtils.js formatTimeSpan    GNOME's own "10 minutes ago"
//
// Nothing is created at module load or by gnomeNotifications(); the
// enum values are read when a store is made.

import Pango from 'gi://Pango';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import {formatTimeSpan} from 'resource:///org/gnome/shell/misc/dateUtils.js';
import {fixMarkup} from 'resource:///org/gnome/shell/misc/util.js';

import {NotificationStore} from './notificationStore.js';

/**
 * GNOME's notifications, or null when this Shell has no message tray.
 *
 * @returns {?{createStore: Function, plainText: Function, timeAgo: Function}}
 */
export function gnomeNotifications() {
    const tray = Main.messageTray;
    if (!tray)
        return null;
    return {
        /** @returns {NotificationStore} not watching until watch() */
        createStore: () => new NotificationStore(tray, {
            critical: MessageTray.Urgency.CRITICAL,
            dismissed: MessageTray.NotificationDestroyedReason.DISMISSED,
            // Its banner will mark it seen (messageTray.js
            // _onNotificationRequestBanner, _updateState).
            waitingForBanner: notification => {
                const queue = tray._notificationQueue;
                return Array.isArray(queue) && queue.includes(notification);
            },
        }),
        plainText,
        /** @param {?GLib.DateTime} datetime */
        timeAgo: datetime => datetime ? formatTimeSpan(datetime) : '',
    };
}

/**
 * The text GNOME's list shows for a title or body, without its markup:
 * newlines become spaces, then GNOME's fixMarkup (only <b>, <i>, <u> and
 * the five entities are markup; invalid markup is shown escaped).
 *
 * @param {?string} text
 * @param {boolean} useMarkup the notification's use-body-markup (false for titles)
 * @returns {string}
 */
function plainText(text, useMarkup) {
    if (!text)
        return '';
    const oneLine = text.replace(/\n/g, ' ');
    try {
        return Pango.parse_markup(fixMarkup(oneLine, useMarkup), -1, '')[2];
    } catch {
        return oneLine;
    }
}
