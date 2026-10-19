// SPDX-License-Identifier: GPL-3.0-or-later
// "Notice when you are busy" (features/break/busy.js): which signals keep
// you at the computer, which hold the cue, which hold GNOME. Pure.

import {done, eq, test} from './test.js';
import {SIGNALS, appName, busyState, cueHeld} from '../../froonty@catalin/features/break/busy.js';

const quiet = {'fullscreen': false, 'screen-share': false, 'microphone': false, 'dnd': false, 'watching': []};
const on = (over = {}) => ({...quiet, ...over});

test('nothing on, or no signals: not busy', () => {
    eq(busyState(null, SIGNALS), {present: false, hold: false, gnome: false, reasons: [], watching: []});
    eq(busyState(on(), SIGNALS).reasons, []);
});

test('a call or a share: present, holds the cue and (if asked) GNOME', () => {
    for (const signal of ['microphone', 'screen-share']) {
        const b = busyState(on({[signal]: true}), SIGNALS, {holdGnome: true});
        eq([b.present, b.hold, b.gnome, b.reasons], [true, true, true, [signal]], signal);
        eq(busyState(on({[signal]: true}), SIGNALS).gnome, false, `${signal} without hold-gnome`);
    }
});

test('a full-screen window holds the cue; GNOME only while something keeps the screen awake', () => {
    const plain = busyState(on({fullscreen: true}), SIGNALS, {holdGnome: true});
    eq([plain.present, plain.hold, plain.gnome], [true, true, false], 'a full-screen editor');
    const video = busyState(on({fullscreen: true, watching: [{app: 'mpv', reason: 'video'}]}), SIGNALS,
        {holdGnome: true});
    eq(video.gnome, true, 'a full-screen video');
});

test('Do Not Disturb holds the cue only: not present, not GNOME', () => {
    const b = busyState(on({dnd: true}), SIGNALS, {holdGnome: true});
    eq([b.present, b.hold, b.gnome], [false, true, false]);
});

test('watching keeps you present, holds nothing, and says who', () => {
    const watching = [{app: '/opt/brave.com/brave/brave', reason: 'Video Wake Lock'}];
    const b = busyState(on({watching}), SIGNALS, {holdGnome: true});
    eq([b.present, b.hold, b.gnome, b.watching], [true, false, false, watching]);
});

test('signals not chosen in break-busy-signals count for nothing', () => {
    eq(busyState(on({microphone: true, dnd: true}), ['dnd']).reasons, ['dnd']);
    eq(busyState(on({microphone: true}), ['fullscreen']).present, false);
});

test('the cue stays held for the grace after the last busy moment', () => {
    const idle = busyState(on(), SIGNALS);
    eq(cueHeld(busyState(on({dnd: true}), SIGNALS), null, 100, 120), true);
    eq(cueHeld(idle, null, 100, 120), false);
    eq(cueHeld(idle, 100, 219, 120), true);
    eq(cueHeld(idle, 100, 220, 120), false);
});

test('app names from desktop ids and paths', () => {
    eq(appName('/opt/brave.com/brave/brave'), 'brave');
    eq(appName('org.gnome.Totem.desktop'), 'org.gnome.Totem');
    eq(appName(''), null);
});

await done();
