// SPDX-License-Identifier: GPL-3.0-or-later
// Settings → Break (docs/features/break.md). Runs in the preferences process
// (GTK 4 + libadwaita), so it imports nothing Shell-side. GNOME's own break
// settings are shown with GNOME's keys (shared with Settings → Wellbeing);
// they are written only when a row here is changed.

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {GnomeBreakSettings, parseSaved, takeoverStatus, WELLBEING_PATH} from './gnomeSettings.js';

const SIZE_KEYS = ['break-width', 'break-height'];
const CUE_MODES = ['off', 'icon', 'icon-and-time'];
const RESET_COMMAND = `gsettings reset org.gnome.desktop.notifications.application:${WELLBEING_PATH} enable`;

/** The tab's pictograms (the sit/stand panic button shows one in Settings). */
export function addIconPath() {
    const display = Gdk.Display.get_default();
    const icons = Gio.File.new_for_uri(import.meta.url).get_parent().get_child('icons');
    if (display)
        Gtk.IconTheme.get_for_display(display).add_search_path(icons.get_path());
}

export function breakPage(settings) {
    const page = new Adw.PreferencesPage({
        name: 'break',
        title: _('Break'),
        icon_name: 'org.gnome.Settings-wellbeing-symbolic',
    });
    const gnome = new GnomeBreakSettings();
    // Kept with the page (the window holds the page).
    page._gnome = gnome;
    page.add(breaksGroup(settings, gnome));
    page.add(gnomeGroup(gnome));
    page.add(urgencyGroup(settings));
    page.add(exercisesGroup(settings));
    page.add(postureGroup(settings));
    page.add(historyGroup(settings));
    page.add(sizeGroup(settings));
    return page;
}

function breaksGroup(settings, gnome) {
    const group = new Adw.PreferencesGroup({
        title: _('Breaks'),
        description: _('Froonty shows and drives GNOME’s own break reminders (Settings → Wellbeing). Not medical advice.'),
    });
    group.add(switchRow(settings, 'break-enabled', _('Show the Break tab')));
    const reminders = switchRow(settings, 'break-pill-reminders',
        _('Remind me in the island instead of GNOME’s notifications'),
        _('Turns off GNOME’s Wellbeing notifications while the island is shown; GNOME’s daily screen-time limit alerts use the same switch. Turned back on when this, the Break tab, the island or Froonty is turned off. Should Froonty be removed while it is not running: %s')
            .format(RESET_COMMAND));
    group.add(reminders);

    const status = new Adw.ActionRow({title: _('Who reminds you now'), use_markup: false});
    const syncStatus = () => {
        const {state, dailyLimitHidden} = takeoverStatus(parseSaved(settings.get_string('break-gnome-saved')), gnome);
        status.subtitle = {
            froonty: dailyLimitHidden
                ? _('The island; GNOME’s break notifications and daily limit alerts are off')
                : _('The island; GNOME’s break notifications are off'),
            gnome: _('GNOME’s notifications'),
            unavailable: _('GNOME’s notifications (their switch is locked by the administrator)'),
        }[state];
    };
    syncStatus();
    settings.connect('changed::break-gnome-saved', syncStatus);
    gnome.wellbeing?.connect('changed::enable', syncStatus);
    group.add(status);

    const cue = new Adw.ComboRow({
        title: _('Cue on the collapsed island'),
        subtitle: _('Never colour alone: each level has its own shape'),
        model: Gtk.StringList.new([_('Off'), _('Icon'), _('Icon and minutes')]),
    });
    const syncCue = () => {
        cue.selected = Math.max(0, CUE_MODES.indexOf(settings.get_string('break-pill-cue')));
    };
    syncCue();
    cue.connect('notify::selected', () => {
        const mode = CUE_MODES[cue.selected];
        if (settings.get_string('break-pill-cue') !== mode)
            settings.set_string('break-pill-cue', mode);
    });
    settings.connect('changed::break-pill-cue', syncCue);
    group.add(cue);
    return group;
}

// GNOME's eye and movement breaks, one fold-out each: its switch is the
// type in GNOME's selected-breaks.
function gnomeGroup(gnome) {
    const group = new Adw.PreferencesGroup({
        title: _('GNOME’s break reminders'),
        description: _('GNOME’s own settings, shared with Settings → Wellbeing, which shows only some of them.'),
    });
    if (!gnome.available) {
        group.add(new Adw.ActionRow({title: _('Not available on this system')}));
        return group;
    }
    const titles = {eyesight: _('Eye breaks'), movement: _('Movement breaks')};
    for (const type of ['eyesight', 'movement']) {
        const s = gnome.typeSettings(type);
        const expander = new Adw.ExpanderRow({title: titles[type], show_enable_switch: true});
        let syncing = false;
        const syncOn = () => {
            syncing = true;
            expander.enable_expansion = gnome.selected().includes(type);
            syncing = false;
        };
        syncOn();
        expander.connect('notify::enable-expansion', () => {
            if (!syncing)
                gnome.setSelected(type, expander.enable_expansion);
        });
        gnome.breaks.connect('changed::selected-breaks', syncOn);
        expander.sensitive = gnome.selectedWritable();

        expander.add_row(uintRow(s, 'interval-seconds', _('Every (min)'), 1, 240, 60));
        expander.add_row(type === 'eyesight'
            ? uintRow(s, 'duration-seconds', _('Length (s)'), 10, 600, 1)
            : uintRow(s, 'duration-seconds', _('Length (min)'), 1, 60, 60));
        expander.add_row(uintRow(s, 'delay-seconds', _('Delay by (min)'), 1, 30, 60));
        expander.add_row(gnomeSwitch(s, 'fade-screen', _('Dim the screen'),
            _('Also dims the island; after an interrupted break it stays dim while you type until you pause 10 s')));
        expander.add_row(gnomeSwitch(s, 'lock-screen', _('Lock the screen')));
        expander.add_row(gnomeSwitch(s, 'play-sound', _('Sound when a break ends'),
            _('Also after skipped or interrupted breaks')));
        group.add(expander);
    }

    const open = new Adw.ActionRow({title: _('Open Settings → Wellbeing'), activatable: true});
    open.add_suffix(new Gtk.Image({icon_name: 'go-next-symbolic'}));
    open.connect('activated', () => {
        try {
            Gio.DesktopAppInfo.new('gnome-wellbeing-panel.desktop')?.launch([], null);
        } catch (e) {
            console.warn(`Froonty: could not open Wellbeing: ${e.message}`);
        }
    });
    group.add(open);
    return group;
}

function urgencyGroup(settings) {
    const group = new Adw.PreferencesGroup({
        title: _('Urgency (Froonty’s conventions, not guidelines)'),
        description: _('No guideline defines when a break is "urgent"; these are Froonty’s rules.'),
    });
    const skips = spinRow(settings, 'break-escalate-after-skips', _('Overdue after skips or delays in a row'));
    skips.subtitle = _('0: never');
    group.add(skips);
    const delays = spinRow(settings, 'break-max-delays', _('Delays in a row, at most'));
    delays.subtitle = _('0: no limit. GNOME’s own notification keeps its Delay button.');
    group.add(delays);
    group.add(switchRow(settings, 'break-long-rest', _('Suggest a long rest'),
        _('After the AOA’s "15 minutes after two hours" at the screen (expert opinion)')));
    group.add(spinRow(settings, 'break-long-rest-after-minutes', _('Long rest after (min) at the screen')));
    group.add(spinRow(settings, 'break-long-rest-minutes', _('Long rest length (min)')));
    group.add(switchRow(settings, 'break-make-up-time', _('Make up skipped movement time'),
        _('Suggests a longer movement break after a skipped one, at most twice GNOME’s length')));
    return group;
}

function exercisesGroup(settings) {
    const group = new Adw.PreferencesGroup({title: _('Exercises')});
    group.add(switchRow(settings, 'break-exercises', _('Show exercise cards'),
        _('A stretch when a movement break is near, eye exercises when an eye break is due')));
    group.add(linkRow(_('Pictures and texts: Workrave'), _('GPL-3.0-or-later; see the README next to them'),
        'https://github.com/rcaelers/workrave'));
    group.add(linkRow(_('Office stretches (CCOHS)'), _('How to stretch safely, from a public health body'),
        'https://www.ccohs.ca/oshanswers/ergonomics/office/stretching.html'));
    group.add(linkRow(_('Sitting exercises (NHS)'), _('A routine for people who have not exercised for a while'),
        'https://www.nhs.uk/live-well/exercise/strength-and-flexibility-exercises/sitting-exercises/'));
    return group;
}

function postureGroup(settings) {
    const group = new Adw.PreferencesGroup({
        title: _('Sit/stand desk'),
        description: _('2 h is a starting minimum from an expert statement (Buckley et al. 2015; one author had undeclared links to a desk seller). Light walking counts. Studies of people who stand a lot (not sit-stand desk users) link more than about 2 h of standing a day with circulation problems and more than 4 h at work with low-back symptoms; observational and uncertain. New to standing: some discomfort is common; sit if it doesn’t ease.'),
    });
    group.add(switchRow(settings, 'posture-enabled', _('Track sitting and standing'),
        _('A Sitting/Standing switch in the Break tab (and an optional panic button); standing counts only while you use the computer')));
    const target = spinRow(settings, 'posture-target-minutes', _('Daily standing target (min)'), 15);
    target.subtitle = _('The minimum (“bare minimum”)');
    group.add(target);
    group.add(switchRow(settings, 'posture-buildup', _('Build up'),
        _('Adds a step after you meet the target on 4 of 5 working days, at most once a week; never steps down by itself')));
    group.add(spinRow(settings, 'posture-buildup-step-minutes', _('Build-up step (min)'), 5));
    group.add(spinRow(settings, 'posture-buildup-ceiling-minutes', _('Build up to (min)'), 15));

    const reset = new Gtk.Button({label: _('Reset build-up'), valign: Gtk.Align.CENTER});
    const built = new Adw.ActionRow({title: _('Built-up target'), use_markup: false});
    built.add_suffix(reset);
    const syncBuilt = () => {
        const minutes = settings.get_int('posture-buildup-target');
        built.subtitle = minutes > settings.get_int('posture-target-minutes')
            ? _('Now %d min').format(minutes) : _('Not built up yet: the daily target');
        reset.sensitive = settings.get_user_value('posture-buildup-target') !== null;
    };
    syncBuilt();
    settings.connect('changed::posture-buildup-target', syncBuilt);
    settings.connect('changed::posture-target-minutes', syncBuilt);
    reset.connect('clicked', () => settings.reset('posture-buildup-target'));
    group.add(built);

    group.add(switchRow(settings, 'posture-reminders', _('Switch reminders'),
        _('A cue on the island; none to stand once today’s target is met')));
    group.add(spinRow(settings, 'posture-sit-minutes', _('Stand up after sitting (min)')));
    group.add(spinRow(settings, 'posture-stand-minutes', _('Sit down after standing (min)')));
    return group;
}

function historyGroup(settings) {
    const group = new Adw.PreferencesGroup({
        title: _('History'),
        description: _('Only when you were at the computer or away, and daily totals, on this computer (~/.local/share/froonty/break). The tab’s "Forget history…" deletes it.'),
    });
    group.add(spinRow(settings, 'break-history-days', _('Keep (days)')));
    return group;
}

// Island size while the Break tab is shown; applies live. As Btop's.
function sizeGroup(settings) {
    const reset = new Gtk.Button({label: _('Default size'), valign: Gtk.Align.CENTER, css_classes: ['flat']});
    const group = new Adw.PreferencesGroup({
        title: _('Size'),
        description: _('Of the island while the Break tab is shown, in logical pixels. Or drag the open island’s bottom-right corner.'),
        header_suffix: reset,
    });
    group.add(spinRow(settings, 'break-width', _('Width')));
    group.add(spinRow(settings, 'break-height', _('Height')));
    const sync = () => {
        reset.tooltip_text = SIZE_KEYS.map(key => settings.get_default_value(key).unpack()).join(' × ');
        reset.sensitive = SIZE_KEYS.some(key => settings.get_user_value(key) !== null);
    };
    sync();
    for (const key of SIZE_KEYS)
        settings.connect(`changed::${key}`, sync);
    reset.connect('clicked', () => SIZE_KEYS.forEach(key => settings.reset(key)));
    return group;
}

function switchRow(settings, key, title, subtitle = '') {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

// Spin bounds are read from the schema's <range>, as in prefs.js.
function spinRow(settings, key, title, step = 1) {
    const [, [lower, upper]] = settings.settings_schema.get_key(key).get_range().recursiveUnpack();
    const row = Adw.SpinRow.new_with_range(lower, upper, step);
    row.title = title;
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

// One of GNOME's second counts, shown in `unit` seconds. Written only when
// the user changes the row (not when it shows the current value).
function uintRow(s, key, title, min, max, unit) {
    const row = Adw.SpinRow.new_with_range(min, max, 1);
    row.title = title;
    let syncing = false;
    const sync = () => {
        syncing = true;
        row.value = Math.round(s.get_uint(key) / unit);
        syncing = false;
    };
    sync();
    row.connect('notify::value', () => {
        const value = Math.round(row.value) * unit;
        if (!syncing && s.is_writable(key) && s.get_uint(key) !== value)
            s.set_uint(key, value);
    });
    s.connect(`changed::${key}`, sync);
    row.sensitive = s.is_writable(key);
    return row;
}

function gnomeSwitch(s, key, title, subtitle = '') {
    const row = new Adw.SwitchRow({title, subtitle});
    let syncing = false;
    const sync = () => {
        syncing = true;
        row.active = s.get_boolean(key);
        syncing = false;
    };
    sync();
    row.connect('notify::active', () => {
        if (!syncing && s.is_writable(key) && s.get_boolean(key) !== row.active)
            s.set_boolean(key, row.active);
    });
    s.connect(`changed::${key}`, sync);
    row.sensitive = s.is_writable(key);
    return row;
}

function linkRow(title, subtitle, uri) {
    const row = new Adw.ActionRow({title, subtitle, use_markup: false});
    row.add_suffix(new Gtk.LinkButton({label: _('Open'), uri, valign: Gtk.Align.CENTER}));
    return row;
}
