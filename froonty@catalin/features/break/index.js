// SPDX-License-Identifier: GPL-3.0-or-later
// Break tab: GNOME's own break reminders, shown and driven from the island,
// with exercise cards and a sit/stand tracker (docs/features/break.md).

import Gio from 'gi://Gio';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {acquireBreakService, releaseBreakService} from './shared.js';
import {BreakView} from './view.js';

// The tab's hold on the shared service; the extension holds it too while
// the tab is enabled (extension.js), so tracking does not wait for the tab
// to be opened.
class BreakHandle {
    constructor(settings) {
        this._settings = settings;
        this.service = null;
    }

    start() {
        this.service = acquireBreakService(this._settings).service;
    }

    stop() {
        releaseBreakService();
        this.service = null;
    }
}

export default {
    id: 'break',
    get title() {
        return _('Break');
    },
    // A getter: no GObject is made when the module loads.
    get icon() {
        return Gio.ThemedIcon.new_from_names(['org.gnome.Settings-wellbeing-symbolic', 'alarm-symbolic']);
    },
    // Off by default: reminders, and what they record, are the user's choice.
    enabledKey: 'break-enabled',
    // Settings → Break → Size.
    hubSizeKeys: {width: 'break-width', height: 'break-height'},
    createService: ctx => new BreakHandle(ctx.settings),
    createView: (ctx, handle) => new BreakView(ctx, handle.service),
    // The collapsed pill's cue (ui/island.js): held while the tab is enabled.
    pillCue: {
        acquire: settings => acquireBreakService(settings).cue,
        release: () => releaseBreakService(),
    },
};
