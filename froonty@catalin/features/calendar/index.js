// SPDX-License-Identifier: GPL-3.0-or-later
// Calendar tab: the events of the user's calendars, from Evolution Data
// Server (docs/features/calendar.md §B).

import Gio from 'gi://Gio';
import Shell from 'gi://Shell';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {edsInstalled} from './eds.js';
import {calendarIcon} from './icon.js';
import {CalendarService} from './service.js';
import {CalendarView} from './view.js';

const ONLINE_ACCOUNTS_APPS = ['gnome-online-accounts-panel.desktop', 'org.gnome.Settings.desktop'];

// What the service needs from the Shell, so service.js stays plain gjs.
function shellDeps(ctx) {
    return {
        clock: ctx.clock,
        localeWeekStart: () => Shell.util_get_week_start(),
        translate: text => Shell.util_translate_time_string(text),
        desktopCalendar: () => new Gio.Settings({schema_id: 'org.gnome.desktop.calendar'}),
        // The island lets go of its grab first, so the browser or Settings
        // can take the focus.
        collapse: () => ctx.collapse(),
        openUri: url => {
            const context = global.create_app_launch_context(global.get_current_time(), -1);
            Gio.AppInfo.launch_default_for_uri_async(url, context, null, (_source, result) => {
                try {
                    Gio.AppInfo.launch_default_for_uri_finish(result);
                } catch (e) {
                    console.warn(`Froonty: could not open ${url}: ${e.message}`);
                }
            });
        },
        openOnlineAccounts: () => {
            const apps = Shell.AppSystem.get_default();
            const app = ONLINE_ACCOUNTS_APPS.map(id => apps.lookup_app(id)).find(Boolean);
            app?.activate();
        },
    };
}

export default {
    id: 'calendar',
    get title() {
        return _('Calendar');
    },
    // A getter: no GObject is created when the module loads, before
    // enable().
    get icon() {
        return calendarIcon();
    },
    enabledKey: 'calendar-enabled',
    // Once, on Froonty's first start: without the EDS bindings
    // (gir1.2-ecal-2.0), the tab starts off. Only a probe; nothing is
    // loaded. If the probe itself is not possible, the tab stays on and
    // explains what to install when opened.
    async setup(settings) {
        if (settings.get_boolean('calendar-eds-checked'))
            return;
        let installed = true;
        try {
            installed = await edsInstalled();
        } catch {
            installed = true;
        }
        settings.set_boolean('calendar-eds-checked', true);
        if (!installed)
            settings.set_boolean('calendar-enabled', false);
    },
    // Settings → Calendar → Size.
    hubSizeKeys: {width: 'calendar-width', height: 'calendar-height'},
    createService: ctx => new CalendarService(ctx.settings, shellDeps(ctx)),
    createView: (ctx, service) => new CalendarView(ctx, service),
};
