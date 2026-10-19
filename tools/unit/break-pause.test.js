// SPDX-License-Identifier: GPL-3.0-or-later
// Pausing breaks and working hours (features/break/pause.js): the rules,
// and GNOME's selected breaks turned off and given back exactly. GNOME's
// and Froonty's settings are on in-memory backends (asserted).

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {done, eq, ok, test} from './test.js';
import {froontySettings, isMemory, setup} from './breakWorld.js';
import {GnomeBreakSettings} from '../../froonty@catalin/features/break/gnomeSettings.js';
import {
    PauseKeeper, allowPauses, applyHold, applyPause, holdApplied, pauseApplied, pauseState, restoreHold,
    restorePause, untilTomorrow, workHours,
} from '../../froonty@catalin/features/break/pause.js';

String.prototype.format ??= imports.format.format;

// GSettings tells other objects on the same backend from the main loop.
const flush = () => {
    while (GLib.MainContext.default().iteration(false))
        ;
};

// Local times (the rules use the local time zone).
const at = (y, mo, d, h, mi = 0) => new Date(y, mo - 1, d, h, mi, 0).getTime();
const s = ms => ms / 1000;
// Friday 16 Oct 2026.
const HOURS = {enabled: true, days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: 9 * 60, end: 18 * 60};

test('working hours: inside, before, after, at the weekend', () => {
    const inside = workHours(HOURS, at(2026, 10, 16, 11));
    eq([inside.inside, inside.nextEnd], [true, s(at(2026, 10, 16, 18))]);
    const before = workHours(HOURS, at(2026, 10, 16, 8));
    eq([before.inside, before.nextStart], [false, s(at(2026, 10, 16, 9))]);
    const evening = workHours(HOURS, at(2026, 10, 16, 20));
    eq([evening.inside, evening.nextStart], [false, s(at(2026, 10, 19, 9))], 'Friday evening: Monday');
    const saturday = workHours(HOURS, at(2026, 10, 17, 12));
    eq([saturday.inside, saturday.nextStart], [false, s(at(2026, 10, 19, 9))]);
});

test('working hours off, no days, or an empty range: always inside', () => {
    eq(workHours({...HOURS, enabled: false}, at(2026, 10, 17, 3)).inside, true);
    eq(workHours({...HOURS, days: []}, at(2026, 10, 17, 3)).inside, true);
    eq(workHours({...HOURS, end: 9 * 60}, at(2026, 10, 17, 3)).inside, true);
});

test('pause state: a manual pause first, then working hours, unless reminded anyway', () => {
    const now = at(2026, 10, 16, 20);
    const manual = pauseState({pausedUntil: s(now) + 600, hours: HOURS, overrideUntil: 0}, now);
    eq([manual.paused, manual.reason, manual.until], [true, 'manual', s(now) + 600]);
    const hours = pauseState({pausedUntil: 0, hours: HOURS, overrideUntil: 0}, now);
    eq([hours.paused, hours.reason, hours.until], [true, 'hours', s(at(2026, 10, 19, 9))]);
    const anyway = pauseState({pausedUntil: 0, hours: HOURS, overrideUntil: s(at(2026, 10, 19, 9))}, now);
    eq(anyway.paused, false);
    const expired = pauseState({pausedUntil: s(now) - 1, hours: {...HOURS, enabled: false}, overrideUntil: 0}, now);
    eq(expired.paused, false);
});

test('until tomorrow: the next working day\'s start, or 06:00 without working hours', () => {
    eq(untilTomorrow(HOURS, at(2026, 10, 15, 14)), s(at(2026, 10, 16, 9)), 'Thursday → Friday');
    eq(untilTomorrow(HOURS, at(2026, 10, 16, 14)), s(at(2026, 10, 19, 9)), 'Friday → Monday');
    eq(untilTomorrow({...HOURS, enabled: false}, at(2026, 10, 16, 14)), s(at(2026, 10, 17, 6)));
});

function world(selected = ['eyesight', 'movement']) {
    // A keeper earlier in the file may have suspended pauses.
    allowPauses();
    const gnome = new GnomeBreakSettings({backend: Gio.memory_settings_backend_new()});
    ok(isMemory(gnome.breaks), 'GNOME test settings must be in memory');
    gnome.breaks.set_strv('selected-breaks', selected);
    return {gnome, settings: froontySettings()};
}

test('a pause turns GNOME\'s breaks off once and gives back exactly what was there', () => {
    const {gnome, settings} = world();
    applyPause(settings, gnome);
    eq(gnome.selected(), []);
    ok(pauseApplied(settings));
    applyPause(settings, gnome);
    eq(restorePause(settings, gnome), false);
    eq(gnome.selected(), ['eyesight', 'movement']);
    eq(pauseApplied(settings), false);
    eq(settings.get_string('break-gnome-saved'), '');
});

test('nothing to pause with GNOME\'s breaks off: nothing written', () => {
    const {gnome, settings} = world([]);
    gnome.breaks.reset('selected-breaks');
    applyPause(settings, gnome);
    eq(pauseApplied(settings), false);
});

test('breaks turned on in GNOME\'s Settings during a pause stay as the user set them', () => {
    const {gnome, settings} = world();
    applyPause(settings, gnome);
    gnome.breaks.set_strv('selected-breaks', ['eyesight']);
    eq(restorePause(settings, gnome), true);
    eq(gnome.selected(), ['eyesight']);
    eq(pauseApplied(settings), false);
});

test('the takeover\'s own record survives a pause and its end', () => {
    const {gnome, settings} = world();
    settings.set_string('break-gnome-saved', JSON.stringify({'wellbeing/enable': {user: null, set: 'false'}}));
    applyPause(settings, gnome);
    restorePause(settings, gnome);
    eq(JSON.parse(settings.get_string('break-gnome-saved')), {'wellbeing/enable': {user: null, set: 'false'}});
});

test('the keeper ends a pause when the tab or Froonty is turned off, not under the lock screen', () => {
    let {gnome, settings} = world();
    settings.set_boolean('break-enabled', true);
    let keeper = new PauseKeeper(settings, gnome);
    applyPause(settings, gnome);
    keeper.destroy({restore: false});
    eq(gnome.selected(), [], 'locked: still paused');
    keeper = new PauseKeeper(settings, gnome);
    settings.set_boolean('break-enabled', false);
    eq(gnome.selected(), ['eyesight', 'movement'], 'tab off');
    keeper.destroy({restore: true});

    ({gnome, settings} = world());
    keeper = new PauseKeeper(settings, gnome);
    applyPause(settings, gnome);
    keeper.destroy({restore: true});
    eq(gnome.selected(), ['eyesight', 'movement'], 'Froonty off');
});

test('busy: GNOME\'s dimming and locking off, exactly back; a key changed meanwhile stays', () => {
    const {gnome, settings} = world();
    const eyes = gnome.typeSettings('eyesight');
    const move = gnome.typeSettings('movement');
    eyes.set_boolean('lock-screen', true);
    applyHold(settings, gnome);
    eq([eyes.get_boolean('fade-screen'), eyes.get_boolean('lock-screen'), move.get_boolean('fade-screen')],
        [false, false, false]);
    ok(holdApplied(settings));
    move.set_boolean('fade-screen', true);
    restoreHold(settings, gnome);
    eq(eyes.get_user_value('fade-screen'), null, 'no value of the user\'s: reset');
    eq(eyes.get_boolean('lock-screen'), true, 'the user\'s value back');
    eq(move.get_boolean('fade-screen'), true, 'changed meanwhile: left');
    eq(holdApplied(settings), false);
    eq(settings.get_string('break-gnome-saved'), '');
});

// The service and the keeper together, as in the Shell (breakWorld: GNOME's
// real BreakManager on a fake clock, settings in memory).
async function running(selected = ['eyesight']) {
    allowPauses();
    const w = await setup({froonty: {'break-enabled': true}, selected});
    const gnome = new GnomeBreakSettings({backend: w.world.backend});
    return {...w, gnome};
}

test('the tab turned off during a pause: GNOME\'s breaks back, even with the service still running', async () => {
    const {world, service, settings, gnome} = await running();
    const keeper = new PauseKeeper(settings, gnome);
    world.work(5);
    service.pause(30);
    flush();
    eq(gnome.selected(), []);
    settings.set_boolean('break-enabled', false);
    flush();
    eq(gnome.selected(), ['eyesight'], 'restored at once');
    world.work(5);
    eq(gnome.selected(), ['eyesight'], 'and not paused again by the service');
    service.stop();
    eq(gnome.selected(), ['eyesight']);
    keeper.destroy({restore: false});
});

test('Froonty turned off during a pause (not locked): GNOME\'s breaks back', async () => {
    const {world, service, settings, gnome} = await running();
    const keeper = new PauseKeeper(settings, gnome);
    world.work(5);
    service.pause(30);
    keeper.destroy({restore: true});
    world.work(2);
    service.stop();
    eq(gnome.selected(), ['eyesight']);
    eq(settings.get_int64('break-paused-until'), 0, 'a manual pause is over');
});

test('breaks turned on in GNOME\'s Settings during a pause stay on, and the pause is over', async () => {
    const {world, service, settings, gnome} = await running();
    world.work(5);
    service.pause(30);
    gnome.breaks.set_strv('selected-breaks', ['eyesight', 'movement']);
    flush();
    world.work(5);
    eq(gnome.selected(), ['eyesight', 'movement']);
    eq([settings.get_int64('break-paused-until'), pauseApplied(settings)], [0, false]);
    service.stop();
});

test('breaks off when a pause began, turned on during it: they stay on', async () => {
    const {world, service, gnome} = await running([]);
    world.work(5);
    service.pause(30);
    gnome.breaks.set_strv('selected-breaks', ['eyesight']);
    flush();
    world.work(5);
    eq(gnome.selected(), ['eyesight']);
    service.stop();
});

test('a pause ends at its time: GNOME\'s breaks back, the keys cleared', async () => {
    const {world, service, settings, gnome} = await running();
    world.work(5);
    service.pause(1);
    flush();
    eq(gnome.selected(), []);
    world.advance(62);
    flush();
    eq(gnome.selected(), ['eyesight']);
    eq([settings.get_int64('break-paused-until'), settings.get_string('break-gnome-saved')], [0, '']);
    service.stop();
});

await done();
