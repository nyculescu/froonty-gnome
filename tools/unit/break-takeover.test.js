// SPDX-License-Identifier: GPL-3.0-or-later
// "Remind me in the island" (features/break/takeover.js): GNOME's
// Wellbeing notifications off while Froonty reminds, and exactly what it
// changed given back. Never the real settings: GNOME's and Froonty's are on
// in-memory backends (asserted), or fakes.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {done, eq, ok, test} from './test.js';
import {froontySchemaSource, froontySettings, isMemory} from './breakWorld.js';
import {
    GnomeBreakSettings, WELLBEING_PATH, WELLBEING_SCHEMA, parseSaved, takeoverStatus,
} from '../../froonty@catalin/features/break/gnomeSettings.js';
import {NotificationTakeover, desired} from '../../froonty@catalin/features/break/takeover.js';

const flush = () => {
    while (GLib.MainContext.default().iteration(false))
        ;
};

function world({selected = ['eyesight', 'movement']} = {}) {
    const backend = Gio.memory_settings_backend_new();
    const gnome = new GnomeBreakSettings({backend});
    for (const s of [gnome.breaks, gnome.wellbeing, gnome.limits, gnome.typeSettings('eyesight')])
        ok(isMemory(s), 'GNOME test settings must be in memory');
    gnome.breaks.set_strv('selected-breaks', selected);
    const settings = froontySettings();
    settings.set_boolean('break-enabled', true);
    return {gnome, settings, backend};
}

const userValue = (s, key) => s.get_user_value(key)?.print(true) ?? null;
const saved = settings => parseSaved(settings.get_string('break-gnome-saved'));

test('desired: only with the tab, the reminders, a cue, the island and GNOME\'s breaks on', () => {
    const all = {enabled: true, pillReminders: true, cue: 'icon', pillShown: true, selected: ['eyesight']};
    eq(desired(all), true);
    for (const [key, value] of Object.entries({enabled: false, pillReminders: false, cue: 'off',
        pillShown: false, selected: []}))
        eq(desired({...all, [key]: value}), false, key);
});

test('apply turns the Wellbeing notifications off and saves "no value of yours"', () => {
    const {gnome, settings} = world();
    const takeover = new NotificationTakeover(settings, gnome);
    takeover.sync({pillShown: true});
    eq(gnome.wellbeing.get_boolean('enable'), false);
    eq(saved(settings)['wellbeing/enable'], {user: null, set: 'false'});
    eq(takeover.status.state, 'froonty');
    takeover.destroy({restore: true});
});

test('restore resets a key that had no value of the user\'s, and writes back one that had', () => {
    let {gnome, settings} = world();
    let takeover = new NotificationTakeover(settings, gnome);
    takeover.sync({pillShown: true});
    takeover.destroy({restore: true});
    eq(userValue(gnome.wellbeing, 'enable'), null);
    eq(settings.get_string('break-gnome-saved'), '');

    ({gnome, settings} = world());
    gnome.wellbeing.set_boolean('enable', true); // the user's own "on"
    takeover = new NotificationTakeover(settings, gnome);
    takeover.sync({pillShown: true});
    eq(saved(settings)['wellbeing/enable'].user, 'true');
    takeover.destroy({restore: true});
    eq(userValue(gnome.wellbeing, 'enable'), 'true');
});

test('a key the user changed since is theirs: left alone, the record dropped', () => {
    const {gnome, settings} = world();
    const takeover = new NotificationTakeover(settings, gnome);
    takeover.sync({pillShown: true});
    gnome.typeSettings('eyesight'); // untouched
    gnome.wellbeing.set_boolean('enable', true);
    flush();
    takeover.destroy({restore: true});
    eq(userValue(gnome.wellbeing, 'enable'), 'true');
    eq(settings.get_string('break-gnome-saved'), '');
});

test('nothing written when the value already is the target; countdown only when on', () => {
    const {gnome, settings} = world();
    gnome.wellbeing.set_boolean('enable', false);
    const eyes = gnome.typeSettings('eyesight');
    eyes.set_boolean('countdown', true);
    const takeover = new NotificationTakeover(settings, gnome);
    takeover.sync({pillShown: true});
    const record = saved(settings);
    eq(record['wellbeing/enable'], undefined, 'already off: not recorded');
    eq(record['eyesight/countdown'], {user: 'true', set: 'false'});
    eq(record['movement/countdown'], undefined, 'off by default: untouched');
    eq(eyes.get_boolean('countdown'), false);
    takeover.destroy({restore: true});
    eq(eyes.get_boolean('countdown'), true);
    eq(gnome.wellbeing.get_boolean('enable'), false, 'the user\'s own "off" stays');
});

test('follows the settings: reminders off, GNOME\'s breaks off, the island gone', () => {
    const {gnome, settings} = world();
    const takeover = new NotificationTakeover(settings, gnome);
    takeover.sync({pillShown: true});
    eq(gnome.wellbeing.get_boolean('enable'), false);
    settings.set_boolean('break-pill-reminders', false);
    flush();
    eq(gnome.wellbeing.get_boolean('enable'), true);
    settings.set_boolean('break-pill-reminders', true);
    flush();
    eq(gnome.wellbeing.get_boolean('enable'), false);
    gnome.breaks.set_strv('selected-breaks', []);
    flush();
    eq(gnome.wellbeing.get_boolean('enable'), true);
    gnome.breaks.set_strv('selected-breaks', ['movement']);
    flush();
    takeover.sync({pillShown: false});
    eq(gnome.wellbeing.get_boolean('enable'), true);
    takeover.destroy({restore: true});
});

test('locked by an administrator: "unavailable", nothing written', () => {
    const writes = [];
    const locked = {
        is_writable: () => false,
        get_boolean: () => true,
        set_boolean: (...args) => writes.push(args),
        get_user_value: () => null,
    };
    const gnome = {
        breaks: {connect: () => 1, disconnect: () => {}},
        wellbeing: locked,
        typeSettings: () => null,
        selected: () => ['eyesight'],
        dailyLimit: () => false,
    };
    const settings = froontySettings();
    settings.set_boolean('break-enabled', true);
    const takeover = new NotificationTakeover(settings, gnome);
    takeover.sync({pillShown: true});
    eq(writes, []);
    eq(settings.get_string('break-gnome-saved'), '');
    eq(takeover.status.state, 'unavailable');
    takeover.destroy({restore: true});
});

test('a missing schema makes no Settings object', () => {
    const gnome = new GnomeBreakSettings({source: froontySchemaSource()});
    eq([gnome.breaks, gnome.wellbeing, gnome.limits, gnome.typeSettings('eyesight')], [null, null, null, null]);
    eq(gnome.available, false);
    eq(gnome.selected(), []);
    eq(takeoverStatus({}, gnome).state, 'unavailable');
});

test('destroy without restoring (the lock screen) keeps it; with restoring gives it back', () => {
    const {gnome, settings} = world();
    let takeover = new NotificationTakeover(settings, gnome);
    takeover.sync({pillShown: true});
    takeover.destroy({restore: false});
    eq(gnome.wellbeing.get_boolean('enable'), false);
    // Unlock: a new takeover finds it applied and writes nothing.
    takeover = new NotificationTakeover(settings, gnome);
    takeover.sync({pillShown: true});
    eq(saved(settings)['wellbeing/enable'], {user: null, set: 'false'});
    takeover.destroy({restore: true});
    eq(userValue(gnome.wellbeing, 'enable'), null);
});

test('dailyLimitHidden: applied while GNOME\'s daily screen-time limit is on', () => {
    const {gnome, settings} = world();
    gnome.limits.set_boolean('daily-limit-enabled', true);
    const takeover = new NotificationTakeover(settings, gnome);
    eq(takeover.status.dailyLimitHidden, false);
    takeover.sync({pillShown: true});
    eq(takeover.status, {state: 'froonty', dailyLimitHidden: true});
    takeover.destroy({restore: true});
});

test('the Wellbeing switch is GNOME\'s per-app notification setting for the Wellbeing panel', () => {
    eq(WELLBEING_SCHEMA, 'org.gnome.desktop.notifications.application');
    eq(WELLBEING_PATH, '/org/gnome/desktop/notifications/application/gnome-wellbeing-panel/');
});

await done();
