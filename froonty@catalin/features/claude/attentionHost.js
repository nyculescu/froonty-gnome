// SPDX-License-Identifier: GPL-3.0-or-later
// "When Claude needs you" (docs/features/claude-attention.md): the bar
// under the collapsed pill, made by the island for this feature
// (pillBar in index.js) and living as long as the island.
//
// It runs while claude-attention-enabled is on: the service following
// the hooks' state files and the Claude app's notifications, the desktop
// adapter (windows, focus, banners) and the bar itself.

import Gio from 'gi://Gio';

import {AttentionBar} from './attentionBar.js';
import {AttentionService, removeStateDir} from './attentionService.js';
import {ClaudeDesktop, screenLocked} from '../../shell/claudeAttention.js';
import {gnomeNotifications} from '../../shell/messageTray.js';

const ENABLED_KEY = 'claude-attention-enabled';

export class AttentionHost {
    /**
     * @param {object} island {settings, column (the bar goes there),
     *   canShow() (collapsed, and not resizing)}
     */
    constructor({settings, column, canShow}) {
        this._settings = settings;
        this._column = column;
        this._canShow = canShow;
        /** {desktop, service, bar} while on (the headless checks use it). */
        this.attention = null;
        this._settings.connectObject(`changed::${ENABLED_KEY}`, () => this._syncEnabled(), this);
        this._syncEnabled();
    }

    /**
     * At a screen lock its files stay, so what waits survives it.
     * Otherwise (Froonty or the island turned off) the folder goes, and
     * with it Claude Code's hooks stop recording.
     */
    destroy() {
        this._settings.disconnectObject(this);
        this._stop({removeState: !screenLocked()});
    }

    /** The island grows over the bar's place: out of the way at once. */
    hide() {
        this.attention?.bar.hide();
    }

    /** The island is done collapsing: a crashed Claude Code leaves its file. */
    collapsed() {
        this.attention?.service.revalidate();
    }

    /**
     * Shown while something waits, the island is collapsed (and done
     * collapsing), no banner or overview is on screen and Do Not Disturb
     * is off. Fullscreen hides the whole strip.
     */
    sync({animate = false} = {}) {
        const attention = this.attention;
        if (!attention)
            return;
        const [first, ...rest] = attention.service.entries;
        const show = first !== undefined && this._canShow() && !attention.desktop.busy &&
            attention.notifications.get_boolean('show-banners');
        if (show)
            attention.bar.show(first, rest.length);
        else
            attention.bar.hide({animate});
    }

    _syncEnabled() {
        if (this._settings.get_boolean(ENABLED_KEY))
            this._start();
        else if (this.attention)
            this._stop({removeState: true});
        else
            // Off already, e.g. since a previous session: a folder left
            // behind goes, so the hooks record nothing.
            removeStateDir();
    }

    _start() {
        if (this.attention)
            return;
        const desktop = new ClaudeDesktop();
        const service = new AttentionService({
            settings: this._settings,
            desktop,
            // GNOME's notifications, through the Notifications tab's
            // store (shell/messageTray.js), filtered to the Claude app and
            // web browsers.
            notifications: gnomeNotifications(),
        });
        const bar = new AttentionBar({
            onActivate: id => service.activate(id),
            onDismiss: id => service.dismiss(id),
            animationTime: () => this._settings.get_int('animation-duration'),
        });
        this._column.add_child(bar.actor);
        // Do Not Disturb hides the bar, as it hides banners.
        const notifications = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
        this.attention = {desktop, service, bar, notifications};

        // A plain GJS emitter (core/emitter.js): no connectObject().
        this.attention.serviceId = service.connect('changed', () => this.sync({animate: true}));
        desktop.connectObject('busy-changed', () => this.sync(), this);
        notifications.connectObject('changed::show-banners', () => this.sync(), this);
        service.start();
        this.sync();
    }

    _stop({removeState}) {
        const attention = this.attention;
        if (!attention)
            return;
        this.attention = null;
        attention.service.disconnect(attention.serviceId);
        attention.service.stop();
        if (removeState)
            attention.service.removeState();
        attention.desktop.disconnectObject(this);
        attention.desktop.destroy();
        attention.notifications.disconnectObject(this);
        attention.bar.destroy();
    }
}
