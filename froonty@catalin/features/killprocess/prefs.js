// SPDX-License-Identifier: GPL-3.0-or-later
// Kill Process settings tab: show the tab, how often it reads the
// processes, what is never killed, and the tab's size
// (docs/features/kill-process.md). Runs in the preferences process.

import Adw from 'gi://Adw';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {sizeGroup, spinRow, switchRow} from '../../prefs/rows.js';
import {PROTECTED_NAMES, PROTECTED_PREFIXES} from './rules.js';

export function killProcessPage(settings) {
    const page = new Adw.PreferencesPage({
        name: 'killprocess',
        title: _('Kill Process'),
        icon_name: 'process-stop-symbolic',
    });

    const group = new Adw.PreferencesGroup({
        title: _('Kill Process'),
        description: _('All of your own processes, sorted by CPU load, memory or threads (the toggles in the tab), each with a button to kill it: a click, then a confirmation. A process is asked to quit first; “Force quit” is offered only if it is still running a few seconds later. Other users’ processes are not listed, and Froonty never asks for administrator rights. It reads the processes only while the tab is on screen.'),
    });
    group.add(switchRow(settings, 'killprocess-enabled', _('Show the Kill Process tab')));
    group.add(spinRow(settings, 'killprocess-interval', _('Refresh every (s)')));
    page.add(group);

    const protectedGroup = new Adw.PreferencesGroup({
        title: _('Never killed'),
        description: _('These have a lock instead of a kill button: ending them would end your session or break the desktop.'),
    });
    protectedGroup.add(new Adw.ActionRow({
        title: _('GNOME Shell, and whatever started it'),
        subtitle: _('Froonty runs inside GNOME Shell'),
    }));
    protectedGroup.add(new Adw.ActionRow({
        title: _('Session programs and desktop services'),
        // A prefix shows as such: gnome-session*, gsd-*.
        subtitle: PROTECTED_NAMES
            .map(name => PROTECTED_PREFIXES.includes(name) ? `${name}*` : name).join(', '),
        subtitle_selectable: true,
    }));
    page.add(protectedGroup);
    page.add(sizeGroup(settings, ['killprocess-width', 'killprocess-height'],
        _('Of the island while the Kill Process tab is shown, in logical pixels. Or drag the open island’s bottom-right corner.')));
    return page;
}
