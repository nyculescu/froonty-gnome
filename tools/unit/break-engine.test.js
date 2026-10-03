// SPDX-License-Identifier: GPL-3.0-or-later
// The Break tab's rules (features/break/engine.js, words.js): pure.

import {done, eq, ok, test} from './test.js';
import {STATE} from '../../froonty@catalin/shell/breakEngine.js';
import {
    LEVEL, RANK, actionsOf, classify, cueModel, levelOf, nextBoundary, postureCue, suggested,
} from '../../froonty@catalin/features/break/engine.js';
import {words} from '../../froonty@catalin/features/break/words.js';
import {addAway, freshState} from '../../froonty@catalin/features/break/ledger.js';

// GNOME Shell (and its preferences process) adds String.prototype.format;
// plain gjs does not.
String.prototype.format ??= imports.format.format;

const EYES = {interval: 1200, duration: 20, delay: 180, fade: true, lock: false};
const MOVE = {interval: 1800, duration: 300, delay: 180, fade: true, lock: false};

// A model with the eye break due at t = 10000 (last end 8800).
function model(over = {}) {
    return {
        now: 10000,
        state: STATE.ACTIVE,
        lastEnd: {eyesight: 8800},
        nextDue: 10000,
        nextType: 'eyesight',
        types: {eyesight: EYES, movement: MOVE},
        breaks: {eyesight: {consecutive: 0, delaysInRow: 0, owed: 0},
            movement: {consecutive: 0, delaysInRow: 0, owed: 0}},
        prefs: {escalateAfter: 2, maxDelays: 0, makeUp: false, longRest: true,
            longRestAfter: 7200, longRestLength: 900},
        screenSinceLongRest: 0,
        present: true,
        posture: {enabled: false},
        cueMode: 'icon',
        midnight: 50000,
        ...over,
    };
}
const at = (now, over = {}) => model({now, ...over});

test('levels at each boundary: -121 s fine, -120 soon, 0 due, 59 due, 60 overdue, an interval urgent', () => {
    eq(levelOf(at(10000 - 121)).level, LEVEL.FINE);
    eq(levelOf(at(10000 - 120)).level, LEVEL.SOON);
    eq(levelOf(at(10000)).level, LEVEL.DUE);
    eq(levelOf(at(10059)).level, LEVEL.DUE);
    eq(levelOf(at(10060)).level, LEVEL.OVERDUE);
    eq(levelOf(at(10000 + 1199)).level, LEVEL.OVERDUE);
    const urgent = levelOf(at(10000 + 1200));
    eq([urgent.level, urgent.reason, urgent.froontyRule], [LEVEL.URGENT, 'interval', true]);
});

test('levels come from times only, whatever GNOME\'s state says', () => {
    for (const state of [STATE.ACTIVE, STATE.IDLE, STATE.IN_BREAK, STATE.BREAK_DUE])
        eq(levelOf(at(10010, {state})).level, LEVEL.DUE, `state ${state}`);
    eq(levelOf(at(10010, {state: STATE.DISABLED})).level, LEVEL.FINE);
});

test('escalation after N skips or delays in a row; N = 0 means never', () => {
    const breaks = {eyesight: {consecutive: 2, delaysInRow: 0, owed: 0}, movement: {consecutive: 0, delaysInRow: 0, owed: 0}};
    const lv = levelOf(at(10005, {breaks}));
    eq([lv.level, lv.reason, lv.froontyRule], [LEVEL.OVERDUE, 'skips', true]);
    eq(levelOf(at(10005, {breaks, prefs: {...model().prefs, escalateAfter: 0}})).level, LEVEL.DUE);
    // Not due: no escalation.
    eq(levelOf(at(9000, {breaks})).level, LEVEL.FINE);
});

test('level 4 from a long rest; a 15-min away clears it', () => {
    const lv = levelOf(at(9000, {screenSinceLongRest: 7200}));
    eq([lv.level, lv.reason], [LEVEL.URGENT, 'long-rest']);
    eq(levelOf(at(9000, {screenSinceLongRest: 7200, prefs: {...model().prefs, longRest: false}})).level,
        LEVEL.FINE);
    const s = freshState(0);
    s.ledger.screenSinceLongRest = 7300;
    addAway(s, 1000, 1000 + 900 * 1000, {movementSeconds: 300, longRestSeconds: 900});
    eq(s.ledger.screenSinceLongRest, 0);
    eq(s.today.longRests, 1);
    eq(levelOf(at(9000, {screenSinceLongRest: s.ledger.screenSinceLongRest})).level, LEVEL.FINE);
});

test('actions: BREAK_DUE offers all three, with GNOME\'s delay', () => {
    const a = actionsOf(at(10010, {state: STATE.BREAK_DUE}));
    eq([a.take, a.delay, a.skip, a.skipBoth, a.type, a.delaySeconds], [true, true, true, false, 'eyesight', 180]);
});

test('actions: back early (IN_BREAK) or working with a break owed (IDLE): no Take, "interrupted"', () => {
    for (const state of [STATE.IN_BREAK, STATE.IDLE]) {
        const a = actionsOf(at(10010, {state}));
        eq([a.take, a.delay, a.skip, a.interrupted], [false, true, true, true], `state ${state}`);
    }
});

test('actions: GNOME a little behind (ACTIVE, due under 1 s ago): no Take yet', () => {
    const a = actionsOf(at(10000.5, {state: STATE.ACTIVE}));
    eq([a.take, a.delay, a.skip], [false, true, true]);
});

test('actions: nothing due, or GNOME off: none', () => {
    eq(actionsOf(at(9990, {state: STATE.BREAK_DUE})).skip, false);
    eq(actionsOf(at(10010, {state: STATE.DISABLED})).skip, false);
});

test('actions: Delay hidden once overdue by its delay, or after the most delays in a row', () => {
    const late = actionsOf(at(10000 + 180, {state: STATE.BREAK_DUE}));
    eq([late.delay, late.delayHidden.reason], [false, 'overdue']);
    const breaks = {eyesight: {consecutive: 1, delaysInRow: 2, owed: 0}, movement: {consecutive: 0, delaysInRow: 0, owed: 0}};
    const capped = actionsOf(at(10010, {state: STATE.BREAK_DUE, breaks, prefs: {...model().prefs, maxDelays: 2}}));
    eq([capped.delay, capped.delayHidden.reason], [false, 'capped']);
    eq(actionsOf(at(10010, {state: STATE.BREAK_DUE, breaks})).delay, true, 'no cap by default');
});

test('actions: both due: "Skip both", movement reported', () => {
    const a = actionsOf(at(10010, {state: STATE.BREAK_DUE, lastEnd: {eyesight: 8800, movement: 8200}}));
    eq([a.skipBoth, a.type, a.duration], [true, 'movement', 300]);
});

test('suggested length: GNOME\'s; owed time only with make-up on, at most doubled', () => {
    const lv = {level: LEVEL.DUE, reason: 'due', type: 'movement'};
    const breaks = {eyesight: {consecutive: 2, delaysInRow: 0, owed: 0}, movement: {consecutive: 0, delaysInRow: 0, owed: 500}};
    eq(suggested(model({breaks}), lv).seconds, 300);
    eq(suggested(model({breaks, prefs: {...model().prefs, makeUp: true}}), lv).seconds, 600);
    const eyes = suggested(model({breaks}), {level: LEVEL.DUE, reason: 'due', type: 'eyesight'});
    eq([eyes.seconds, eyes.insteadMovement], [20, true]);
    eq(suggested(model(), {level: LEVEL.URGENT, reason: 'long-rest', type: null}).seconds, 900);
});

test('classify: delay, own skip, taken, a skip from GNOME\'s notification, and no event', () => {
    const types = {eyesight: EYES};
    const ctx = over => ({now: 10050, ownAction: null, types, returnLength: null, ...over});
    eq(classify({eyesight: 8800}, {eyesight: 8980}, ctx({ownAction: 'delay'})),
        [{type: 'eyesight', kind: 'delay', source: 'froonty'}]);
    eq(classify({eyesight: 8800}, {eyesight: 8980}, ctx())[0].source, 'gnome');
    eq(classify({eyesight: 8800}, {eyesight: 10050}, ctx({ownAction: 'skip'})),
        [{type: 'eyesight', kind: 'skip', source: 'froonty'}]);
    eq(classify({eyesight: 8800}, {eyesight: 10050}, ctx({returnLength: 25}))[0].kind, 'taken');
    eq(classify({eyesight: 8800}, {eyesight: 10050}, ctx()),
        [{type: 'eyesight', kind: 'skip', source: 'gnome'}]);
    // Not due, no return: something else (a settings reset).
    eq(classify({eyesight: 9500}, {eyesight: 10050}, ctx()), []);
    // Turned on, or unchanged.
    eq(classify({}, {eyesight: 10050}, ctx()), []);
    eq(classify({eyesight: 8800}, {eyesight: 8800}, ctx()), []);
});

test('nextBoundary: the earliest of 2 min before, due, +60 s, +interval, long rest, posture, midnight', () => {
    eq(nextBoundary(at(5000)), 10000 - 120);
    eq(nextBoundary(at(9900)), 10000);
    eq(nextBoundary(at(10000)), 10060);
    eq(nextBoundary(at(10060)), 11200);
    eq(nextBoundary(at(5000, {screenSinceLongRest: 7000})), 5200, 'long rest');
    eq(nextBoundary(at(5000, {screenSinceLongRest: 7000, present: false})), 10000 - 120, 'idle: not counting');
    const posture = {enabled: true, reminders: true, mode: 'sitting', modeActiveSeconds: 2600,
        sitAfter: 2700, standAfter: 900, standingSeconds: 0, targetSeconds: 7200};
    eq(nextBoundary(at(5000, {posture})), 5100, 'posture switch');
    eq(nextBoundary(at(12000, {state: STATE.DISABLED, prefs: {...model().prefs, longRest: false}})),
        50000, 'midnight');
});

test('posture cue: stand after sitting, sit after standing; no stand once the target is met', () => {
    const p = {enabled: true, reminders: true, mode: 'sitting', modeActiveSeconds: 2700,
        sitAfter: 2700, standAfter: 900, standingSeconds: 0, targetSeconds: 7200};
    eq(postureCue(p), 'stand');
    eq(postureCue({...p, standingSeconds: 7200}), null);
    eq(postureCue({...p, mode: 'standing', modeActiveSeconds: 900}), 'sit');
    eq(postureCue({...p, reminders: false}), null);
});

test('cue: most urgent first, posture between due and soon; L0 only with minutes', () => {
    const posture = {enabled: true, reminders: true, mode: 'sitting', modeActiveSeconds: 2700,
        sitAfter: 2700, standAfter: 900, standingSeconds: 0, targetSeconds: 7200};
    eq(cueModel(at(10070, {posture})).kind, 'break', 'overdue beats posture');
    eq(cueModel(at(9950, {posture})).kind, 'posture', 'posture beats soon');
    eq(cueModel(at(9950)).rank, RANK[1]);
    eq(cueModel(at(5000)), null, 'fine, icon mode: nothing');
    eq(cueModel(at(5000, {cueMode: 'icon-and-time'})).seconds, 5000);
    eq(cueModel(at(10070, {cueMode: 'off'})), null);
    ok(RANK[4] > RANK[3] && RANK[3] > RANK[2] && RANK[2] > RANK.posture && RANK.posture > RANK[1]);
});

test('words: cue texts and accessible names', () => {
    const w = words({_: s => s, ngettext: (one, many, n) => (n === 1 ? one : many)});
    const cue = c => w.cue(c, 'icon-and-time');
    eq(cue({kind: 'break', level: 0, type: 'eyesight', seconds: 1500}),
        {text: '25m', accessibleText: 'Next break in 25 minutes'});
    eq(cue({kind: 'break', level: 1, type: 'eyesight', seconds: 110}),
        {text: '2m', accessibleText: 'Eye break in 2 minutes'});
    eq(cue({kind: 'break', level: 2, type: 'movement', seconds: 0}).accessibleText, 'Movement break due');
    eq(cue({kind: 'break', level: 3, type: 'movement', seconds: 190}),
        {text: '+3m', accessibleText: 'Movement break overdue by 3 minutes'});
    eq(cue({kind: 'break', level: 3, reason: 'skips', type: 'eyesight', seconds: 5}).accessibleText,
        'Eye break due, after skips or delays in a row');
    eq(cue({kind: 'break', level: 4, reason: 'long-rest', seconds: 7300}),
        {text: '2h', accessibleText: 'Urgent: long rest suggested, 2 hours at the screen without a 15-minute pause'});
    eq(w.cue({kind: 'break', level: 4, reason: 'interval', type: 'eyesight', seconds: 1860}, 'icon').text, '!');
    eq(w.cue({kind: 'posture', posture: 'stand'}, 'icon').accessibleText, 'Time to stand up');
    eq(w.meterName(3), 'Urgency: overdue, 3 of 4');
    eq(w.duration(4200), '1 h 10 min');
    eq(w.hint({skip: true, take: true, fade: true, lock: false, interrupted: false, duration: 300}),
        'The screen dims; the break counts once you’ve been away 5 min.');
    eq(w.delayHidden({reason: 'overdue', delay: 180, overdue: 720}),
        'Delay moves a break by 3 min; this one is 12 min overdue.');
});

await done();
