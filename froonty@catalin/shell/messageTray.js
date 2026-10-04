// SPDX-License-Identifier: GPL-3.0-or-later
// Adapter around GNOME Shell's message tray, for the Claude attention bar
// (features/claude/attentionHost.js, docs/features/claude-attention.md),
// which reads GNOME's notifications from the Claude app and browsers.
//
// PRIVATE / INTERNAL API. Verified against GNOME Shell
// 50.1:
//
//   Main.messageTray                    MessageTray (ui/main.js)
//   MessageTray.Urgency.CRITICAL        3 (ui/messageTray.js)
//   MessageTray.NotificationDestroyedReason.DISMISSED
//                                       2, what GNOME's own close button
//                                       passes (messageList.js)
//   misc/util.js fixMarkup              how GNOME's list cleans titles and
//                                       bodies before showing them
//
// Nothing is created at module load or by gnomeNotifications(); the
// enum values are read when a store is made.

import Pango from 'gi://Pango';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import {fixMarkup} from 'resource:///org/gnome/shell/misc/util.js';

import {NotificationStore} from './notificationStore.js';

/**
 * GNOME's notifications, or null when this Shell has no message tray.
 *
 * @returns {?{createStore: Function, plainText: Function}}
 */
export function gnomeNotifications() {
    const tray = Main.messageTray;
    if (!tray)
        return null;
    return {
        /**
         * @param {object} [options] {filter}: see NotificationStore
         * @returns {NotificationStore} not watching until watch()
         */
        createStore: options => new NotificationStore(tray, {
            critical: MessageTray.Urgency.CRITICAL,
            dismissed: MessageTray.NotificationDestroyedReason.DISMISSED,
        }, options),
        plainText,
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
