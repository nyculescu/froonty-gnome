// SPDX-License-Identifier: GPL-3.0-or-later
// Shell adapter for the Media service: which app a player belongs to, and
// opening it. MPRIS names an app by its DesktopEntry; browsers (Brave,
// Chromium) give none, so the player's process id is matched to an app's
// windows instead (Shell.WindowTracker), as for "Open player".
//
// SHELL API (exported GI, GNOME Shell 50): Shell.AppSystem.lookup_app,
// Shell.WindowTracker.get_app_from_pid, Shell.App.activate / get_name /
// get_icon / get_app_info.

import Shell from 'gi://Shell';

export const shellApps = {
    /** @returns {?Shell.App} */
    lookup({desktopEntry, pid}) {
        let app = null;
        if (desktopEntry)
            app = Shell.AppSystem.get_default().lookup_app(`${desktopEntry}.desktop`);
        if (!app && Number.isInteger(pid) && pid > 0)
            app = Shell.WindowTracker.get_default().get_app_from_pid(pid);
        return app ?? null;
    },
    name: app => app.get_name() ?? null,
    icon: app => app.get_icon() ?? null,
    categories: app => (app.get_app_info()?.get_categories() ?? '').split(';').filter(Boolean),
    // GNOME's own media card prefers this to the player's Raise, which
    // focus-stealing prevention may refuse.
    activate: app => app.activate(),
};
