// SPDX-License-Identifier: GPL-3.0-or-later
// The Break tab's 14-week chart, its pure part (features/break/chartData.js):
// which day is in which cell, each metric's value, the levels, the words.

import GLib from 'gi://GLib';

import {done, eq, ok, test} from './test.js';
import {
    METRICS, cellText, chartCells, dayValue,
} from '../../froonty@catalin/features/break/chartData.js';
import {words} from '../../froonty@catalin/features/break/words.js';

// GNOME Shell adds String.prototype.format; plain gjs does not.
String.prototype.format ??= imports.format.format;

const _ = s => s;
const ngettext = (one, many, n) => (n === 1 ? one : many);
const {duration} = words({_, ngettext});
const GETTEXT = {_, ngettext, duration};

// 2026-10-15 is a Thursday; its week began on Monday 2026-10-12.
const TODAY = '2026-10-15';

// A record as written before busy, held, reasons and hours were kept.
function oldDay(key, over = {}) {
    const counts = () => ({taken: 0, delayed: 0, skipped: 0});
    return Object.assign({
        day: key, activeSeconds: 0, longestStretchSeconds: 0, eyesight: counts(), movement: counts(),
        longRests: 0, standingSeconds: 0, targetSeconds: 0, minimumOnly: false,
    }, over);
}

// A record with every field.
function day(key, over = {}) {
    const counts = () => ({taken: 0, delayed: 0, skipped: 0, busy: 0, held: 0});
    return oldDay(key, {
        eyesight: counts(), movement: counts(), busySeconds: 0,
        reasons: {meeting: 0, deadline: 0, flow: 0, other: 0},
        hourActive: new Array(24).fill(0), hourMoved: new Array(24).fill(0),
        ...over,
    });
}

const cellOf = (result, key) => result.cells.find(c => c.day === key);
const date = key => {
    const [y, m, d] = key.split('-').map(Number);
    return GLib.DateTime.new_local(y, m, d, 12, 0, 0).format('%a %-d %b');
};
// Days between two keys, by the calendar.
const utc = key => Date.UTC(...key.split('-').map((n, i) => Number(n) - (i === 1 ? 1 : 0)));

test('14 weeks, Monday at the top, today in the last column, the rest of its week in the future', () => {
    const {cells} = chartCells([], day(TODAY), 'screen');
    eq(cells.length, 98);
    eq([cells[0].day, cells[0].col, cells[0].row], ['2026-07-13', 0, 0]);
    eq(cellOf({cells}, TODAY), {day: TODAY, col: 13, row: 3, value: 0, level: 0, inFuture: false});
    eq(cells.filter(c => c.col === 13).map(c => c.day),
        ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18']);
    eq(cells.filter(c => c.inFuture).map(c => c.day), ['2026-10-16', '2026-10-17', '2026-10-18']);
    // Each cell's row is its weekday (GLib: 1 Monday … 7 Sunday).
    ok(cells.every(c => {
        const [y, m, d] = c.day.split('-').map(Number);
        return GLib.DateTime.new_local(y, m, d, 12, 0, 0).get_day_of_week() === c.row + 1;
    }), 'rows are weekdays');
});

test('every day once, in order, across both DST changes', () => {
    for (const today of ['2026-11-05', '2027-04-08']) {
        const {cells} = chartCells([], null, 'screen', {todayKey: today});
        ok(cells.every((c, i) => i === 0 || utc(c.day) - utc(cells[i - 1].day) === 86400000),
            `consecutive days up to ${today}`);
        ok(cells.every((c, i) => c.col === Math.floor(i / 7) && c.row === i % 7), 'columns are weeks');
    }
});

test('a Monday or a Sunday today; other week counts', () => {
    let {cells} = chartCells([], null, 'screen', {todayKey: '2026-10-12'});
    eq([cellOf({cells}, '2026-10-12').col, cellOf({cells}, '2026-10-12').row], [13, 0]);
    eq(cells.filter(c => c.inFuture).length, 6);
    ({cells} = chartCells([], null, 'screen', {todayKey: '2026-10-18'}));
    eq([cells[97].day, cells[97].inFuture], ['2026-10-18', false]);
    ({cells} = chartCells([], null, 'screen', {todayKey: TODAY, weeks: 2}));
    eq([cells.length, cells[0].day], [14, '2026-10-05']);
});

test('records: today wins over history; days without a record and older ones are null', () => {
    const history = [
        day('2026-10-15', {activeSeconds: 100}),
        day('2026-10-14', {activeSeconds: 7200}),
        day('2026-07-12', {activeSeconds: 3600}),
    ];
    const result = chartCells(history, day(TODAY, {activeSeconds: 3600}), 'screen');
    eq(cellOf(result, TODAY).value, 3600);
    eq(cellOf(result, '2026-10-14').value, 7200);
    eq(cellOf(result, '2026-10-13').value, null);
    eq(cellOf(result, '2026-07-12'), undefined, 'before the 14 weeks');
    eq(result.max, 7200);
    eq(result.metric, 'screen');
    eq(chartCells([], null, 'kept', {todayKey: TODAY}).max, null);
});

test('kept: taken of taken, skipped and delayed, eyes and movement together', () => {
    const record = day(TODAY, {
        eyesight: {taken: 4, delayed: 1, skipped: 1, busy: 5, held: 2},
        movement: {taken: 2, delayed: 0, skipped: 1, busy: 0, held: 0},
    });
    eq(dayValue(record, 'kept'), 6 / 9);
    eq(dayValue(day(TODAY), 'kept'), null, 'no breaks: no value');
    eq(dayValue(oldDay(TODAY, {movement: {taken: 1, delayed: 0, skipped: 1}}), 'kept'), 0.5);
    eq(dayValue(day(TODAY, {eyesight: {taken: 0, delayed: 2, skipped: 0}}), 'kept'), 0);
});

test('screen and stretch: the seconds; standing: of the target, null without one', () => {
    const record = day(TODAY, {activeSeconds: 20000, longestStretchSeconds: 5400,
        standingSeconds: 5400, targetSeconds: 7200});
    eq([dayValue(record, 'screen'), dayValue(record, 'stretch'), dayValue(record, 'standing')],
        [20000, 5400, 0.75]);
    eq(dayValue(day(TODAY, {standingSeconds: 600}), 'standing'), null);
    eq(dayValue(day(TODAY, {standingSeconds: 9000, targetSeconds: 7200}), 'standing'), 1.25);
    eq(dayValue(undefined, 'screen'), null);
});

test('moves: desk hours (30 min or more) you moved in', () => {
    const hourActive = new Array(24).fill(0);
    const hourMoved = new Array(24).fill(0);
    [9, 10, 11, 14].forEach(h => (hourActive[h] = 2400));
    hourActive[15] = 1799;
    hourActive[16] = 1800;
    hourMoved[9] = 1;
    hourMoved[15] = 1; // not a desk hour
    hourMoved[16] = 1;
    eq(dayValue(day(TODAY, {hourActive, hourMoved}), 'moves'), 2 / 5);
    eq(dayValue(day(TODAY), 'moves'), null, 'no desk hour');
    eq(dayValue(oldDay(TODAY, {activeSeconds: 9000}), 'moves'), null, 'no hours kept');
    eq(dayValue(oldDay(TODAY, {hourActive}), 'moves'), 0, 'hours without moves');
});

test('levels of a share: 0 for nothing, then at 25, 50 and 75%', () => {
    const history = [
        [0, 4], [1, 9], [2, 10], [3, 19], [4, 20], [5, 29], [6, 30], [7, 40],
    ].map(([i, taken]) => day(`2026-10-0${i + 1}`, {eyesight: {taken, delayed: 0, skipped: 40 - taken}}));
    history.push(day('2026-09-30', {eyesight: {taken: 0, delayed: 0, skipped: 3}}));
    const result = chartCells(history, day(TODAY), 'kept');
    const levels = ['2026-09-30', ...history.slice(0, 8).map(d => d.day)].map(k => cellOf(result, k).level);
    eq(levels, [0, 1, 1, 2, 2, 3, 3, 4, 4]);
    eq([cellOf(result, TODAY).value, cellOf(result, TODAY).level], [null, 0]);
    const standing = chartCells([day(TODAY, {standingSeconds: 9000, targetSeconds: 7200})], null, 'standing',
        {todayKey: TODAY});
    eq(cellOf(standing, TODAY).level, 4, 'over the target');
});

test('levels of time: quartiles of the days with any, 0 for none', () => {
    const history = [1, 2, 3, 4, 5, 6, 7, 8].map(h => day(`2026-10-0${h}`, {activeSeconds: h * 3600}));
    const result = chartCells(history, day(TODAY), 'screen');
    eq(history.map(d => cellOf(result, d.day).level), [1, 1, 2, 2, 3, 3, 4, 4]);
    eq([cellOf(result, TODAY).value, cellOf(result, TODAY).level], [0, 0]);
    eq(result.max, 8 * 3600);
    // All alike: the lowest level; one day alone too.
    const same = chartCells([1, 2, 3].map(d => day(`2026-10-0${d}`, {longestStretchSeconds: 1800})), null,
        'stretch', {todayKey: TODAY});
    eq(same.cells.filter(c => c.value !== null).map(c => c.level), [1, 1, 1]);
});

test('every metric gives cells; an unknown one throws', () => {
    for (const metric of METRICS)
        eq(chartCells([], day(TODAY), metric).cells.length, 98);
    let thrown = false;
    try {
        chartCells([], day(TODAY), 'steps');
    } catch {
        thrown = true;
    }
    ok(thrown, 'unknown metric');
});

test('the words for a day', () => {
    const cell = {day: '2026-10-01'};
    const text = (record, metric) => cellText(cell, record, metric, GETTEXT);
    const d = date('2026-10-01');
    const record = day('2026-10-01', {
        activeSeconds: 22320, longestStretchSeconds: 5400, standingSeconds: 7500, targetSeconds: 7200,
        eyesight: {taken: 4, delayed: 1, skipped: 1, busy: 0, held: 0},
        movement: {taken: 2, delayed: 0, skipped: 1, busy: 0, held: 0},
    });
    eq(text(record, 'kept'), `${d}: 6 of 9 breaks taken (67%)`);
    eq(text(day('2026-10-01', {movement: {taken: 1, delayed: 0, skipped: 0}}), 'kept'),
        `${d}: 1 of 1 break taken (100%)`);
    eq(text(day('2026-10-01'), 'kept'), `${d}: no breaks taken, skipped or delayed`);
    eq(text(record, 'screen'), `${d}: 6 h 12 min at the computer`);
    eq(text(record, 'stretch'), `${d}: longest stretch 1 h 30 min`);
    eq(text(record, 'standing'), `${d}: standing 2 h 5 min of 2 h (104%)`);
    eq(text(day('2026-10-01'), 'standing'), `${d}: no standing target`);
    const hourActive = new Array(24).fill(0);
    const hourMoved = new Array(24).fill(0);
    [9, 10, 11].forEach(h => (hourActive[h] = 3600));
    hourMoved[10] = 1;
    eq(text(day('2026-10-01', {hourActive, hourMoved}), 'moves'),
        `${d}: moved in 1 of 3 hours at the computer (33%)`);
    eq(text(day('2026-10-01'), 'moves'), `${d}: no hour with 30 min at the computer`);
    eq(text(oldDay('2026-10-01'), 'moves'), `${d}: hours not recorded`);
    eq(text(undefined, 'screen'), `${d}: nothing recorded`);
});

await done();
