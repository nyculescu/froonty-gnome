// SPDX-License-Identifier: GPL-3.0-or-later
// Settings → Break (docs/features/break.md). Runs in the preferences process
// (GTK 4 + libadwaita), so it imports nothing Shell-side. GNOME's own break
// settings are shown with GNOME's keys (shared with Settings → Wellbeing);
// they are written only when a row here is changed.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {addIconPath as addIconFolder, choiceRow, sizeGroup, spinRow, switchRow} from '../../prefs/rows.js';
import {garminGroup} from './garminPrefs.js';
import {GnomeBreakSettings, parseSaved, takeoverStatus, WELLBEING_PATH} from './gnomeSettings.js';
import {WEEKDAYS} from './pause.js';

const CUE_MODES = ['off', 'icon', 'icon-and-time'];
const RESET_COMMAND = `gsettings reset org.gnome.desktop.notifications.application:${WELLBEING_PATH} enable`;

/** The tab's pictograms (the sit/stand panic button shows one in Settings). */
export const addIconPath = () => addIconFolder(import.meta.url);

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
    page.add(busyGroup(settings));
    page.add(pauseGroup(settings));
    page.add(urgencyGroup(settings));
    page.add(moveGroup(settings));
    page.add(garminGroup(settings));
    page.add(exercisesGroup(settings));
    page.add(postureGroup(settings));
    page.add(historyGroup(settings));
    page.add(sizeGroup(settings, ['break-width', 'break-height'],
        _('Of the island while the Break tab is shown, in logical pixels. Or drag the open island’s bottom-right corner.')));
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
    group.add(switchRow(settings, 'break-pause-media', _('Pause media on “Take now”'),
        _('Pauses what is playing, and plays again only that when you come back')));
    return group;
}

// Rows greyed out while `key` is off.
function under(settings, key, ...rows) {
    for (const row of rows)
        settings.bind(key, row, 'sensitive', Gio.SettingsBindFlags.GET);
    return rows;
}

function busyGroup(settings) {
    const group = new Adw.PreferencesGroup({
        title: _('Busy'),
        description: _('GNOME counts a call or a video without typing as a break. Froonty can tell.'),
    });
    group.add(switchRow(settings, 'break-busy', _('Notice when you are busy'),
        _('Time in a call, a video or a presentation counts as time at the computer; break cues wait until it ends')));
    const signals = [
        ['fullscreen', _('A full-screen window'), _('Holds the cue; counts as time at the computer')],
        ['screen-share', _('Screen sharing or recording'), _('Holds the cue; counts as time at the computer. Only sharing that starts while Froonty runs is seen')],
        ['microphone', _('Microphone in use (a call)'), _('As GNOME’s microphone indicator shows it. Holds the cue; counts as time at the computer')],
        ['dnd', _('Do Not Disturb'), _('Holds the cue only (you may have left with it on). Off by default: with it on all day, no cue would show')],
        ['watching', _('An app keeps the screen awake (a video)'), _('Counts as time at the computer only; the tab names the app')],
    ];
    const rows = signals.map(([signal, title, subtitle]) => strvSwitch(settings, 'break-busy-signals', signal, title, subtitle));
    const grace = spinRow(settings, 'break-busy-grace-minutes', _('Show held cues again after (min)'));
    const hold = switchRow(settings, 'break-busy-hold-gnome', _('Hold GNOME’s dimming and locking while busy'),
        _('In a call, while sharing the screen, or watching full screen: GNOME’s “Dim the screen” and “Lock the screen” are off meanwhile, then back as they were'));
    for (const row of under(settings, 'break-busy', ...rows, grace, hold))
        group.add(row);
    return group;
}

// A switch for one value in a string-list key.
function strvSwitch(settings, key, value, title, subtitle) {
    const row = new Adw.SwitchRow({title, subtitle});
    let syncing = false;
    const sync = () => {
        syncing = true;
        row.active = settings.get_strv(key).includes(value);
        syncing = false;
    };
    sync();
    row.connect('notify::active', () => {
        if (syncing)
            return;
        const list = settings.get_strv(key).filter(v => v !== value);
        if (row.active)
            list.push(value);
        settings.set_strv(key, list);
    });
    settings.connect(`changed::${key}`, sync);
    return row;
}

function pauseGroup(settings) {
    const group = new Adw.PreferencesGroup({
        title: _('Pause and working hours'),
        description: _('While paused, GNOME’s breaks are off and Froonty turns them back on at the end, as they were. Turning Froonty or the Break tab off ends a pause.'),
    });
    group.add(switchRow(settings, 'break-pause-button', _('Pause in the Break tab'),
        _('30 minutes, 1 hour, 2 hours or until tomorrow')));
    group.add(switchRow(settings, 'break-work-hours', _('Working hours'),
        _('Outside them, breaks are paused and the island shows no break, posture or move cue. “Remind me anyway” in the tab lifts it until they start again')));
    const days = new Adw.ActionRow({title: _('Working days')});
    const box = new Gtk.Box({spacing: 4, valign: Gtk.Align.CENTER, css_classes: ['linked']});
    // Monday 2024-01-01: the week's short names in this locale.
    const monday = GLib.DateTime.new_local(2024, 1, 1, 12, 0, 0);
    const toggles = WEEKDAYS.map((day, i) => {
        const toggle = new Gtk.ToggleButton({label: monday.add_days(i).format('%a')});
        toggle.connect('toggled', () => {
            const list = settings.get_strv('break-work-days').filter(d => d !== day);
            if (toggle.active)
                list.push(day);
            const sorted = WEEKDAYS.filter(d => list.includes(d));
            if (sorted.join() !== settings.get_strv('break-work-days').join())
                settings.set_strv('break-work-days', sorted);
        });
        box.append(toggle);
        return [day, toggle];
    });
    const syncDays = () => {
        const on = settings.get_strv('break-work-days');
        for (const [day, toggle] of toggles)
            toggle.active = on.includes(day);
    };
    syncDays();
    settings.connect('changed::break-work-days', syncDays);
    days.add_suffix(box);
    const start = timeRow(settings, 'break-work-start', _('From'));
    const end = timeRow(settings, 'break-work-end', _('To'));
    for (const row of under(settings, 'break-work-hours', days, start, end))
        group.add(row);
    return group;
}

// A time of day (minutes after midnight) as hours and minutes.
function timeRow(settings, key, title) {
    const row = new Adw.ActionRow({title});
    const hours = Gtk.SpinButton.new_with_range(0, 24, 1);
    const minutes = Gtk.SpinButton.new_with_range(0, 55, 5);
    for (const spin of [hours, minutes]) {
        spin.valign = Gtk.Align.CENTER;
        spin.numeric = true;
    }
    minutes.connect('output', () => {
        minutes.text = String(minutes.value).padStart(2, '0');
        return true;
    });
    let syncing = false;
    const sync = () => {
        syncing = true;
        const value = settings.get_int(key);
        hours.value = Math.floor(value / 60);
        minutes.value = value % 60;
        syncing = false;
    };
    const write = () => {
        if (syncing)
            return;
        const [, [lower, upper]] = settings.settings_schema.get_key(key).get_range().recursiveUnpack();
        const value = Math.max(lower, Math.min(upper, hours.value * 60 + minutes.value));
        if (settings.get_int(key) !== value)
            settings.set_int(key, value);
    };
    sync();
    hours.connect('value-changed', write);
    minutes.connect('value-changed', write);
    settings.connect(`changed::${key}`, sync);
    row.add_suffix(hours);
    row.add_suffix(new Gtk.Label({label: ':', valign: Gtk.Align.CENTER}));
    row.add_suffix(minutes);
    return row;
}

function moveGroup(settings) {
    const group = new Adw.PreferencesGroup({
        title: _('Move bar and workouts'),
        description: _('Like a fitness watch’s move bar (Garmin’s: after an hour, then a segment every 15 minutes). An away of 2 minutes or more clears it. A heuristic, not medical advice.'),
    });
    group.add(switchRow(settings, 'break-move-goal', _('Move bar'),
        _('A cue after this long at the computer without moving; the Today section counts the hours you moved in')));
    for (const row of under(settings, 'break-move-goal',
        spinRow(settings, 'break-move-after-minutes', _('Move bar after (min)'), 5),
        spinRow(settings, 'break-move-step-minutes', _('One segment more every (min)'), 5)))
        group.add(row);
    group.add(switchRow(settings, 'break-workout', _('Workout days'),
        _('“I worked out” in the tab (it also asks after an away of 45 min or more). That day the standing target stays at the minimum and the workout counts toward it (up to 1 h); after it the move bar waits longer and movement breaks suggest a short walk. Eye breaks and the long rest stay as they are; nothing is eased after 10 h at the computer. Exercise lowers the long-term risk of sitting but does not undo it (Ekelund et al. 2016, 2020; WHO 2020)')));
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
    const skipsMax = spinRow(settings, 'break-max-skips', _('Skips in a row, at most'));
    skipsMax.subtitle = _('0: no limit. The tab hides Skip after this many skips in a row.');
    group.add(skipsMax);
    group.add(switchRow(settings, 'break-skip-reasons', _('Ask why after a skip or delay'),
        _('One tap: a meeting, a deadline, in the flow, or other; counted per day')));
    group.add(switchRow(settings, 'break-natural-pause', _('Show “due” at a pause in typing'),
        _('A break that falls due while you type shows at your first pause of 2 seconds')));
    for (const row of under(settings, 'break-natural-pause',
        spinRow(settings, 'break-natural-pause-max-seconds', _('Wait for a pause at most (s)'), 5)))
        group.add(row);
    return group;
}

function exercisesGroup(settings) {
    const group = new Adw.PreferencesGroup({title: _('Exercises')});
    group.add(switchRow(settings, 'break-exercises', _('Show exercise cards'),
        _('A stretch when a movement break is near, eye exercises when an eye break is due')));
    const rows = [
        switchRow(settings, 'break-animate', _('Moving pictures'),
            _('Only while the card is on screen and GNOME’s Animations switch is on')),
        switchRow(settings, 'break-routines', _('Guided routines'),
            _('A few moves one after another during a movement break or a long rest: standing ones when you stand, quiet ones during a call')),
        switchRow(settings, 'break-eye-exercises', _('Eye exercises drawn by Froonty'),
            _('Look far away; follow the dot, near and far, blinking, palming (comfort only)')),
        switchRow(settings, 'break-breathing', _('Breathing exercise'),
            _('A circle that grows as you breathe in and shrinks as you breathe out')),
        choiceRow(settings, 'break-breathing-pattern', _('Breathing pattern'), ['box', 'slow'],
            [_('Box: in 4 s, hold 4, out 4, hold 4'), _('Slow: in 5 s, out 5')]),
        switchRow(settings, 'break-ideas', _('Break ideas'),
            _('A one-line idea from Stretchly (BSD-2-Clause) and Safe Eyes (GPL-3.0-or-later)')),
    ];
    for (const row of under(settings, 'break-exercises', ...rows))
        group.add(row);
    group.add(artRow());
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
    group.add(switchRow(settings, 'break-chart', _('14-week chart'),
        _('In the Today section: breaks taken, time at the computer, longest stretch, standing, or hours you moved in')));
    return group;
}

// Whether the better pictures are fetched (tools/fetch-break-art.py).
function artRow() {
    const row = new Adw.ActionRow({title: _('Pictures: WorkoutLabs'), use_markup: false});
    const file = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent().get_parent()
        .get_child('third_party').get_child('break-art').get_child('index.json');
    try {
        const [, bytes] = file.load_contents(null);
        const index = JSON.parse(new TextDecoder().decode(bytes));
        const count = Object.keys(index.moves ?? {}).length;
        row.subtitle = _('%d moves fetched to this computer on %s (all rights reserved by WorkoutLabs; not part of Froonty)')
            .format(count, index.source?.fetched ?? '?');
    } catch {
        row.subtitle = _('Not fetched: run “make break-art” in Froonty’s folder, then “make install”. Until then: Workrave’s pictures');
    }
    row.add_suffix(new Gtk.LinkButton({label: _('Open'), uri: 'https://workoutlabs.com/exercise-guide/',
        valign: Gtk.Align.CENTER}));
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
