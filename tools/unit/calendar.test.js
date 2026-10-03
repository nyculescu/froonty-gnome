// SPDX-License-Identifier: GPL-3.0-or-later
// Calendar tab: date math, provider links, colours, the event model and
// the service's lifecycle over a fake EDS. Nothing here talks to D-Bus or
// to a real calendar.

import GLib from 'gi://GLib';

import {Emitter} from '../../froonty@catalin/core/emitter.js';
import {FALLBACK_COLOR, parseColor, sanitizeColor} from '../../froonty@catalin/features/calendar/color.js';
import {
    agendaDays, dayMarks, EventStore, MAX_CARDS, overlaps,
} from '../../froonty@catalin/features/calendar/model.js';
import {detectProvider, urlForDay} from '../../froonty@catalin/features/calendar/providers.js';
import {
    addDays, dateKey, gridRange, isWeekend, midnight, sexpTime, span, weeksOf,
} from '../../froonty@catalin/features/calendar/range.js';
import {CalendarService} from '../../froonty@catalin/features/calendar/service.js';
import {done, eq, ok, test} from './test.js';

const BUCHAREST = GLib.TimeZone.new('Europe/Bucharest');
const VANCOUVER = GLib.TimeZone.new('America/Vancouver');
const NEW_YORK = GLib.TimeZone.new('America/New_York');
const at = (tz, y, m, d, h = 0, min = 0) => GLib.DateTime.new(tz, y, m, d, h, min, 0).to_unix();
const keys = dates => dates.map(dateKey);
const D = (y, m, d) => ({y, m, d});

// ---------------------------------------------------------------- range.js

test('range: the week of Fri 2026-10-02 for Monday, Sunday and Saturday starts', () => {
    const fri = D(2026, 10, 2);
    for (const [start, first, last] of [
        [1, '2026-09-28', '2026-10-04'],
        [0, '2026-09-27', '2026-10-03'],
        [6, '2026-09-26', '2026-10-02'],
    ]) {
        const week = span(fri, 'week', start, BUCHAREST);
        eq([dateKey(week.days[0]), dateKey(week.days.at(-1)), week.days.length], [first, last, 7], `start ${start}`);
        eq(week.end, midnight(addDays(week.days.at(-1), 1), BUCHAREST));
    }
});

test('range: the October 2026 grid with Monday first is Sep 28 to Nov 8 (42 days)', () => {
    const grid = gridRange(2026, 10, 1, BUCHAREST);
    eq(grid.days.length, 42);
    eq([dateKey(grid.days[0]), dateKey(grid.days.at(-1))], ['2026-09-28', '2026-11-08']);
    eq(grid.start, at(BUCHAREST, 2026, 9, 28));
    eq(grid.end, at(BUCHAREST, 2026, 11, 9));
});

test('range: GNOME\'s padding: a month starting on the week\'s first day gets a week before', () => {
    // 1 February 2026 is a Sunday.
    const grid = gridRange(2026, 2, 0, BUCHAREST);
    eq(dateKey(grid.days[0]), '2026-01-25');
    eq(dateKey(grid.days.at(-1)), '2026-03-07');
});

test('range: day, week and month spans', () => {
    const day = span(D(2026, 10, 2), 'day', 1, BUCHAREST);
    eq(keys(day.days), ['2026-10-02']);
    eq(day.end - day.start, 86400);
    const month = span(D(2026, 10, 17), 'month', 1, BUCHAREST);
    eq([dateKey(month.days[0]), month.days.length], ['2026-10-01', 31]);
    eq([month.start, month.end], [at(BUCHAREST, 2026, 10, 1), at(BUCHAREST, 2026, 11, 1)]);
    const feb = span(D(2028, 2, 10), 'month', 1, BUCHAREST);
    eq(feb.days.length, 29, 'leap year');
});

test('range: days across daylight saving changes are 25 or 23 hours, spans start at midnight', () => {
    const length = (tz, date) => {
        const s = span(date, 'day', 1, tz);
        return s.end - s.start;
    };
    eq(length(BUCHAREST, D(2026, 10, 25)), 90000);
    // tzdata 2026c: British Columbia stays on UTC-7 from November 2026,
    // so Vancouver's 1 November is 24 hours; New York's is 25.
    eq(length(NEW_YORK, D(2026, 11, 1)), 90000);
    eq(length(VANCOUVER, D(2026, 3, 8)), 82800);
    const week = span(D(2026, 10, 25), 'week', 1, BUCHAREST);
    eq(week.start, at(BUCHAREST, 2026, 10, 19));
    eq(week.end, at(BUCHAREST, 2026, 10, 26));
    eq(week.end - week.start, 7 * 86400 + 3600);
});

test('range: ISO week numbers per grid row (Thursday\'s week)', () => {
    const rows = weeksOf(gridRange(2026, 10, 1, BUCHAREST).days);
    eq(rows.length, 6);
    const row = rows.find(r => r.days.some(date => dateKey(date) === '2026-10-01'));
    eq(row.week, 40);
    // January 2027: its first row is 28 Dec - 3 Jan, week 53 of 2026.
    eq(weeksOf(gridRange(2027, 1, 1, BUCHAREST).days)[0].week, 53);
});

test('range: days off from GNOME\'s calendar-no-work string', () => {
    eq([0, 1, 2, 3, 4, 5, 6].filter(d => isWeekend(d, '06')), [0, 6]);
    eq([0, 1, 2, 3, 4, 5, 6].filter(d => isWeekend(d, '56')), [5, 6]);
    eq([0, 1, 2, 3, 4, 5, 6].filter(d => isWeekend(d, 'calendar-no-work\u000406')), [0, 6], 'untranslated');
});

test('range: s-expression times', () => {
    eq(sexpTime(Date.UTC(2026, 9, 1, 7) / 1000), '20261001T070000Z');
});

// ---------------------------------------------------------------- providers.js

test('providers: Google by collection, CalDAV host and ICS feed; its day link', () => {
    const byCollection = detectProvider({collectionBackend: 'google', collectionIdentity: 'me@gmail.com'});
    eq([byCollection.kind, byCollection.label], ['google', 'Google']);
    eq(byCollection.dayUrl(2026, 10, 2),
        'https://calendar.google.com/calendar/r/day/2026/10/2?authuser=me%40gmail.com');
    const caldav = detectProvider({backend: 'caldav',
        webdav: {scheme: 'https', host: 'apidata.googleusercontent.com', path: '/caldav/v2/x/events'}});
    eq(caldav.kind, 'google');
    eq(caldav.dayUrl(2026, 10, 2), 'https://calendar.google.com/calendar/r/day/2026/10/2');
    const old = detectProvider({webdav: {scheme: 'https', host: 'www.google.com', path: '/calendar/dav/x/events'}});
    eq(old.kind, 'google');
    const ics = detectProvider({backend: 'webcal',
        webdav: {scheme: 'https', host: 'calendar.google.com', path: '/calendar/ical/x/basic.ics'}});
    eq(ics.kind, 'google');
});

test('providers: Microsoft 365 and Exchange open outlook.office.com, Outlook.com outlook.live.com', () => {
    for (const collectionBackend of ['microsoft365', 'ews']) {
        const work = detectProvider({collectionBackend, collectionIdentity: 'ana@contoso.com'});
        eq([work.kind, work.label], ['microsoft', 'Outlook']);
        eq(work.dayUrl(2026, 10, 2), 'https://outlook.office.com/calendar/view/day/2026/10/2');
    }
    for (const identity of ['ana@outlook.com', 'ana@hotmail.co.uk', 'ana@live.com', 'ana@msn.com']) {
        const home = detectProvider({collectionBackend: 'microsoft365', collectionIdentity: identity});
        eq(home.dayUrl(2026, 10, 2), 'https://outlook.live.com/calendar/0/view/day/2026/10/2', identity);
    }
});

test('providers: iCloud and Yahoo have a home page only; Nextcloud keeps its path', () => {
    for (const host of ['caldav.icloud.com', 'p57-caldav.icloud.com']) {
        const icloud = detectProvider({webdav: {scheme: 'https', host, path: '/1234/calendars/home/'}});
        eq([icloud.kind, icloud.label, icloud.homeUrl, icloud.dayUrl],
            ['icloud', 'iCloud', 'https://www.icloud.com/calendar/', null], host);
    }
    const yahoo = detectProvider({webdav: {scheme: 'https', host: 'caldav.calendar.yahoo.com', path: '/dav/x/'}});
    eq([yahoo.kind, yahoo.homeUrl, yahoo.dayUrl], ['yahoo', 'https://calendar.yahoo.com/', null]);
    const nextcloud = detectProvider({collectionBackend: 'webdav',
        webdav: {scheme: 'https', host: 'ex.org', port: -1, path: '/nc/remote.php/dav/calendars/ana/personal/'}});
    eq([nextcloud.kind, nextcloud.homeUrl, nextcloud.dayUrl],
        ['nextcloud', 'https://ex.org/nc/apps/calendar/', null]);
    const port = detectProvider({collectionBackend: 'webdav',
        webdav: {scheme: 'https', host: 'ex.org', port: 8443, path: '/remote.php/dav/calendars/a/b/'}});
    eq(port.homeUrl, 'https://ex.org:8443/apps/calendar/');
});

test('providers: local, birthdays, weather and other hosts have no link', () => {
    for (const info of [
        {backend: 'local'},
        {backend: 'contacts'},
        {backend: 'weather'},
        {backend: 'webcal', webdav: {scheme: 'https', host: 'calendars.example.org', path: '/team.ics'}},
        {backend: 'caldav', webdav: {scheme: 'https', host: 'dav.example.org', path: '/remote.php/dav/x/'}},
    ]) {
        const provider = detectProvider(info);
        eq([provider.label, provider.homeUrl, provider.dayUrl], [null, null, null], JSON.stringify(info));
    }
    eq(detectProvider({backend: 'local'}).kind, 'local');
});

test('providers: look-alike hosts are not matched', () => {
    for (const host of ['evilgoogle.com', 'google.com.evil.org', 'apidata.googleusercontent.com.evil.org',
        'icloud.com.example', 'noticloud.com', 'outlook.office.com.example']) {
        const provider = detectProvider({webdav: {scheme: 'https', host, path: '/calendar/dav/x'}});
        eq(provider.kind, 'other', host);
    }
});

test('providers: day links only for integer dates', () => {
    const google = detectProvider({collectionBackend: 'google'});
    eq(google.dayUrl(2026, 10, '2'), null);
    eq(google.dayUrl(2026.5, 10, 2), null);
    eq(google.dayUrl(2026, 13, 2), null);
    eq(google.dayUrl('2026/../../x', 1, 1), null);
    eq(urlForDay(google, D(2026, 10, 2)), 'https://calendar.google.com/calendar/r/day/2026/10/2');
    eq(urlForDay(detectProvider({webdav: {scheme: 'https', host: 'caldav.icloud.com', path: '/'}}),
        D(2026, 10, 2)), 'https://www.icloud.com/calendar/');
});

// ---------------------------------------------------------------- color.js

test('colors: hex and rgb() parse; names and injections do not', () => {
    eq(parseColor('#62a0ea'), [0x62, 0xa0, 0xea]);
    eq(parseColor('#abc'), [0xaa, 0xbb, 0xcc]);
    eq(parseColor('#62a0eaff'), [0x62, 0xa0, 0xea]);
    eq(parseColor('rgb(1,2,3)'), [1, 2, 3]);
    eq(parseColor('rgba(1, 2, 3, 0.5)'), [1, 2, 3]);
    for (const bad of ['red', '', 'x; background:url(a)', '#62a0ea; color: red', 'rgb(300,0,0)', null, 42])
        eq(parseColor(bad), null, String(bad));
    eq(sanitizeColor('rgb(1,2,3)'), '#010203');
    eq(sanitizeColor('#e01b24; x'), null);
    ok(FALLBACK_COLOR.startsWith('rgba('));
});

// ---------------------------------------------------------------- model.js

const tz = BUCHAREST;
const NOON = at(tz, 2026, 10, 2, 12);

function timed(uid, title, start, end, {rid = null, recurrenceId = '', cancelled = false} = {}) {
    return {
        key: `${uid}\n${recurrenceId}`, uid, rid, title, location: null, cancelled,
        occurrences: [{allDay: false, start, end, rid: start}],
    };
}

function allDay(uid, title, startDate, endDate) {
    return {
        key: `${uid}\n`, uid, rid: null, title, location: null, cancelled: false,
        occurrences: [{allDay: true, startDate, endDate, rid: 0}],
    };
}

const daysOf = (first, count) => Array.from({length: count}, (_, i) => addDays(first, i));

function agendaOf(items, days, now = NOON, calendar = 'cal') {
    const store = new EventStore();
    store.put(calendar, items);
    return agendaDays(store.occurrences([calendar]), days, tz, now);
}

const titles = day => day.entries.map(e => e.item.title);

test('model: a timed event shows once, on its day', () => {
    const {days} = agendaOf([timed('a', 'Standup', at(tz, 2026, 10, 2, 9), at(tz, 2026, 10, 2, 9, 15))],
        daysOf(D(2026, 10, 1), 3));
    eq(days.map(titles), [[], ['Standup'], []]);
    eq(days[1].entries[0].kind, 'timed');
});

test('model: an all-day event spans its days, not its exclusive end', () => {
    const {days} = agendaOf([allDay('a', 'Trip', '2026-10-02', '2026-10-04')], daysOf(D(2026, 10, 1), 5));
    eq(days.map(titles), [[], ['Trip'], ['Trip'], [], []]);
    eq(days[1].entries[0].kind, 'all-day');
});

test('model: a timed event across midnight shows on both days, starting and ending', () => {
    const {days} = agendaOf([timed('a', 'Night', at(tz, 2026, 10, 2, 22), at(tz, 2026, 10, 3, 2))],
        daysOf(D(2026, 10, 2), 2));
    eq(days.map(d => d.entries.map(e => e.kind)), [['starts'], ['ends']]);
    const long = agendaOf([timed('b', 'Conference', at(tz, 2026, 10, 2, 9), at(tz, 2026, 10, 4, 17))],
        daysOf(D(2026, 10, 2), 3));
    eq(long.days.map(d => d.entries.map(e => e.kind)), [['starts'], ['middle'], ['ends']]);
});

test('model: midnight to midnight is all day; a zero-length event at 00:00 is that day\'s', () => {
    const {days} = agendaOf([
        timed('a', 'Whole', at(tz, 2026, 10, 2), at(tz, 2026, 10, 3)),
        timed('b', 'Mark', at(tz, 2026, 10, 3), at(tz, 2026, 10, 3)),
    ], daysOf(D(2026, 10, 2), 2));
    eq(days.map(titles), [['Whole'], ['Mark']]);
    eq(days[0].entries[0].kind, 'all-day');
});

test('model: a moved occurrence replaces its series\' own, whichever arrives first', () => {
    const d = day => at(tz, 2026, 10, day, 9);
    // EDS already left out the EXDATE on the 4th.
    const master = {
        key: 'rec\n', uid: 'rec', rid: null, title: 'Standup', location: null, cancelled: false,
        occurrences: [2, 3, 5, 6].map(day => ({allDay: false, start: d(day), end: d(day) + 900, rid: d(day)})),
    };
    const moved = timed('rec', 'Standup (moved)', at(tz, 2026, 10, 3, 11, 30), at(tz, 2026, 10, 3, 11, 45),
        {rid: d(3), recurrenceId: '20261003T090000'});
    for (const order of [[master, moved], [moved, master]]) {
        const store = new EventStore();
        for (const item of order)
            store.put('cal', [item]);
        const {days} = agendaDays(store.occurrences(['cal']), daysOf(D(2026, 10, 2), 5), tz, NOON);
        eq(days.map(day => day.entries.map(e => `${e.item.title}@${GLib.DateTime.new_from_unix_utc(e.start)
            .to_timezone(tz).format('%H:%M')}`)),
        [['Standup@09:00'], ['Standup (moved)@11:30'], [], ['Standup@09:00'], ['Standup@09:00']]);
    }
});

test('model: removing a series removes its moved occurrences; removing one leaves the series', () => {
    const store = new EventStore();
    store.put('cal', [
        timed('rec', 'Standup', 1, 2),
        timed('rec', 'Moved', 3, 4, {rid: 1, recurrenceId: '20261003T090000'}),
        timed('other', 'Other', 5, 6),
    ]);
    eq(store.removeKeys('cal', ['rec\n20261003T090000']), ['rec\n20261003T090000']);
    eq(store.items('cal').map(i => i.key).sort(), ['other\n', 'rec\n']);
    store.put('cal', [timed('rec', 'Moved', 3, 4, {rid: 1, recurrenceId: '20261003T090000'})]);
    eq(store.removeKeys('cal', ['rec\n']).sort(), ['rec\n', 'rec\n20261003T090000']);
    eq(store.items('cal').map(i => i.key), ['other\n']);
});

test('model: a series\' moved occurrences are replaced as a set', () => {
    const store = new EventStore();
    const moved = rid => timed('rec', `Moved ${rid}`, rid + 10, rid + 20, {rid, recurrenceId: `R${rid}`});
    store.put('cal', [timed('rec', 'Standup', 1, 2), timed('other', 'Other', 5, 6)]);
    eq(store.setDetached('cal', 'rec', [moved(100), moved(200)]), []);
    eq(store.items('cal').map(i => i.key).sort(), ['other\n', 'rec\n', 'rec\nR100', 'rec\nR200']);
    eq(store.setDetached('cal', 'rec', [moved(200)]), ['rec\nR100']);
    eq(store.setDetached('cal', 'rec', []), ['rec\nR200']);
    eq(store.items('cal').map(i => i.key).sort(), ['other\n', 'rec\n']);
});

test('model: the same event in two calendars stays twice; hidden calendars are left out', () => {
    const store = new EventStore();
    const invite = () => timed('meet', 'Meeting', at(tz, 2026, 10, 2, 10), at(tz, 2026, 10, 2, 11));
    store.put('work', [invite()]);
    store.put('home', [invite()]);
    eq(store.occurrences(['work', 'home']).length, 2);
    eq(store.occurrences(['work']).length, 1);
});

test('model: at most three calendar colours per day, in calendar order', () => {
    const store = new EventStore();
    for (const cal of ['c', 'a', 'd', 'b'])
        store.put(cal, [timed(`${cal}1`, cal, at(tz, 2026, 10, 2, 10), at(tz, 2026, 10, 2, 11))]);
    store.put('a', [allDay('a2', 'A2', '2026-10-01', '2026-10-03')]);
    const order = new Map([['a', 0], ['b', 1], ['c', 2], ['d', 3]]);
    const marks = dayMarks(store.occurrences(['a', 'b', 'c', 'd']), daysOf(D(2026, 10, 1), 3), tz, order);
    eq(marks.get('2026-10-02'), {count: 5, calendars: ['a', 'b', 'c']});
    eq(marks.get('2026-10-01'), {count: 1, calendars: ['a']});
    eq(marks.get('2026-10-03'), {count: 0, calendars: []});
});

test('model: now, a single next, never for all-day events, and past', () => {
    const now = at(tz, 2026, 10, 2, 12);
    const {days} = agendaOf([
        timed('past', 'Past', at(tz, 2026, 10, 2, 9), at(tz, 2026, 10, 2, 10)),
        timed('now', 'Now', at(tz, 2026, 10, 2, 11, 50), at(tz, 2026, 10, 2, 12, 20)),
        timed('next', 'Next', at(tz, 2026, 10, 2, 12, 30), at(tz, 2026, 10, 2, 13)),
        timed('later', 'Later', at(tz, 2026, 10, 2, 15), at(tz, 2026, 10, 2, 16)),
        timed('gone', 'Cancelled', at(tz, 2026, 10, 2, 12, 10), at(tz, 2026, 10, 2, 12, 15), {cancelled: true}),
        allDay('today', 'All day', '2026-10-02', '2026-10-03'),
        allDay('yesterday', 'Yesterday', '2026-10-01', '2026-10-02'),
    ], daysOf(D(2026, 10, 1), 2), now);
    const state = title => days.flatMap(d => d.entries).find(e => e.item.title === title).state;
    eq(['Past', 'Now', 'Next', 'Later', 'Cancelled', 'All day', 'Yesterday'].map(state),
        ['past', 'now', 'next', null, null, null, 'past']);
    eq(days[1].entries[0].item.title, 'All day', 'all-day first');
});

test('model: "Next" is the first event after now anywhere, not the span\'s first (calendar-6)', () => {
    const store = new EventStore();
    store.put('cal', [
        timed('tomorrow', 'Tomorrow', at(tz, 2026, 10, 3, 9), at(tz, 2026, 10, 3, 10)),
        timed('later', 'Later', at(tz, 2026, 10, 20, 9), at(tz, 2026, 10, 20, 10)),
    ]);
    const occurrences = store.occurrences(['cal']);
    const later = agendaDays(occurrences, daysOf(D(2026, 10, 20), 1), tz, NOON);
    eq([later.days[0].entries[0].state, later.next.item.title], [null, 'Tomorrow']);
    const tomorrow = agendaDays(occurrences, daysOf(D(2026, 10, 3), 1), tz, NOON);
    eq(tomorrow.days[0].entries[0].state, 'next');
    const none = agendaDays(occurrences, daysOf(D(2026, 10, 3), 1), tz, NOON, {next: null});
    eq([none.days[0].entries[0].state, none.next], [null, null], 'none when the caller cannot tell');
});

test('model: the agenda shows at most MAX_CARDS cards and counts the rest', () => {
    const many = Array.from({length: MAX_CARDS + 7}, (_, i) =>
        timed(`e${i}`, `E${i}`, at(tz, 2026, 10, 2, 8) + i * 60, at(tz, 2026, 10, 2, 8) + i * 60 + 30));
    const {days, truncated} = agendaOf(many, daysOf(D(2026, 10, 2), 1));
    eq([days[0].entries.length, truncated], [MAX_CARDS, 7]);
});

test('model: GNOME\'s overlap rule', () => {
    ok(overlaps(10, 10, 10, 20), 'zero length at the start');
    ok(!overlaps(20, 20, 10, 20), 'zero length at the end belongs to the next');
    ok(!overlaps(0, 10, 10, 20), 'ending at the start');
    ok(overlaps(0, 11, 10, 20));
});

// ---------------------------------------------------------------- service.js

class Counted extends Emitter {
    constructor() {
        super();
        this.handlers = 0;
    }

    connect(name, fn) {
        this.handlers++;
        return super.connect(name, fn);
    }

    disconnect(id) {
        this.handlers--;
        return super.disconnect(id);
    }
}

// An EdsView: start() is its one synchronous D-Bus call; release()
// makes none. stop() does not exist any more and must never be called.
class FakeView extends Counted {
    constructor(uid, range) {
        super();
        this.uid = uid;
        this.range = range;
        this.starts = 0;
        this.stopped = false;
    }

    get started() {
        return this.starts > 0;
    }

    start() {
        this.starts++;
    }

    release() {
        this.stopped = true;
    }
}

class FakeEds extends Counted {
    constructor() {
        super();
        this.infos = new Map();
        this.views = [];
        this.started = false;
        this.stopped = false;
        this.paused = null;
        this.slow = false;
        this.pending = [];
        this.failing = new Set();
    }

    setPaused(paused) {
        this.paused = paused;
    }

    async start() {
        this.started = true;
        for (const info of this.infos.values())
            this.emit('calendar-appeared', info);
    }

    stop() {
        this.stopped = true;
    }

    get clientCount() {
        return 0;
    }

    addCalendar(info) {
        this.infos.set(info.uid, info);
        if (this.started)
            this.emit('calendar-appeared', info);
    }

    removeCalendar(uid) {
        this.infos.delete(uid);
        this.emit('calendar-disappeared', uid);
    }

    openView(uid, range) {
        if (this.failing.has(uid))
            return Promise.reject(new Error('Cannot connect'));
        const view = new FakeView(uid, range);
        this.views.push(view);
        if (this.slow)
            return new Promise(resolve => this.pending.push(() => resolve(view)));
        return Promise.resolve(view);
    }

    live(uid) {
        return this.views.filter(v => v.uid === uid && !v.stopped);
    }
}

function fakeSettings(values = {}) {
    const all = {'calendar-hidden-sources': [], 'calendar-granularity': 'week', ...values};
    const handlers = new Map();
    let next = 1;
    const set = (key, value) => {
        all[key] = value;
        for (const {signal, fn} of [...handlers.values()]) {
            if (signal === `changed::${key}`)
                fn();
        }
    };
    return {
        get_strv: key => all[key],
        get_string: key => all[key],
        set_strv: set,
        set_string: set,
        connect: (signal, fn) => {
            handlers.set(next, {signal, fn});
            return next++;
        },
        disconnect: id => handlers.delete(id),
        handlers,
        all,
    };
}

function fakeTimeout() {
    const timers = new Map();
    let next = 1;
    return {
        add: (ms, fn) => {
            timers.set(next, fn);
            return next++;
        },
        cancel: id => timers.delete(id),
        fire() {
            for (const [id, fn] of [...timers]) {
                timers.delete(id);
                fn();
            }
        },
        get pending() {
            return timers.size;
        },
    };
}

function fakeIdle() {
    const queue = new Map();
    let next = 1;
    return {
        add: fn => {
            queue.set(next, fn);
            return next++;
        },
        cancel: id => queue.delete(id),
        run() {
            for (const [id, fn] of [...queue]) {
                queue.delete(id);
                fn();
            }
        },
        get pending() {
            return queue.size;
        },
    };
}

// Lets promise chains (loadEds, openView) settle.
const settle = () => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10, () => {
    resolve();
    return GLib.SOURCE_REMOVE;
}));

const info = (uid, name, extra = {}) => ({uid, name, color: '#62a0ea', backend: 'local', order: 0, ...extra});

function harness({settingsValues = {}, loads = null, calendars = [info('personal', 'Personal'),
    info('work', 'Work', {color: 'rgb(224,27,36)', backend: 'caldav',
        webdav: {scheme: 'https', host: 'apidata.googleusercontent.com', path: '/caldav/v2/x/events'}})]} = {}) {
    const eds = new FakeEds();
    for (const calendar of calendars)
        eds.infos.set(calendar.uid, calendar);
    const settings = fakeSettings(settingsValues);
    const idle = fakeIdle();
    const timeout = fakeTimeout();
    const clock = {timeZone: BUCHAREST};
    const desktop = fakeSettings({'week-start-day': 1, 'show-weekdate': true});
    desktop.get_enum = key => desktop.all[key];
    desktop.get_boolean = key => desktop.all[key];
    const opened = [];
    let now = NOON;
    let monotonic = 0;
    const results = loads ?? [{status: 'ok', adapter: eds}];
    let loadCalls = 0;
    const service = new CalendarService(settings, {
        loadEds: async () => results[Math.min(loadCalls++, results.length - 1)],
        clock,
        localeWeekStart: () => 0,
        translate: s => s,
        desktopCalendar: () => desktop,
        openUri: url => opened.push(url),
        collapse: () => opened.push('collapse'),
        idle,
        timeout,
        now: () => now,
        monotonic: () => monotonic,
    });
    let changed = 0;
    service.connect('changed', () => changed++);
    return {service, eds, settings, idle, timeout, clock, desktop, opened, changes: () => changed,
        loadCalls: () => loadCalls, setNow: value => (now = value), advance: ms => (monotonic += ms)};
}

const item = (uid, title, start, end) => timed(uid, title, start, end);

test('service: start() alone loads nothing', async () => {
    const h = harness();
    h.service.start();
    await settle();
    eq([h.loadCalls(), h.service.state, h.eds.started], [0, 'idle', false]);
    h.service.stop();
});

test('service: a missing typelib shows the hint; installing it later works on the next visit', async () => {
    const eds = new FakeEds();
    eds.infos.set('personal', info('personal', 'Personal'));
    const h = harness({loads: [{status: 'missing'}, {status: 'ok', adapter: eds}]});
    h.service.start();
    h.service.setActive(true);
    await settle();
    eq(h.service.state, 'missing');
    h.service.setActive(false);
    h.service.setActive(true);
    await settle();
    eq([h.service.state, h.loadCalls(), eds.live('personal').length], ['ready', 2, 1]);
    h.service.stop();
});

test('service: one view per visible calendar over the grid, kept and paused off screen; a late open is let go', async () => {
    const h = harness();
    h.service.start();
    h.service.setActive(true);
    await settle();
    eq(h.service.state, 'ready');
    const views = [...h.eds.views];
    eq(views.map(v => v.uid).sort(), ['personal', 'work']);
    eq(views[0].range, {start: at(tz, 2026, 9, 28), end: at(tz, 2026, 11, 9), tzid: 'Europe/Bucharest'});
    ok(views.every(v => v.starts === 1));
    eq(h.eds.paused, false);
    h.service.setActive(false);
    eq([h.eds.paused, h.service.viewCount], [true, 2], 'paused, not closed');
    ok(views.every(v => !v.stopped));

    // Another month, then off screen before EDS answers: let go, never started.
    h.service.setActive(true);
    h.eds.slow = true;
    h.service.showMonth(1);
    h.service.setActive(false);
    for (const resolve of h.eds.pending)
        resolve();
    await settle();
    ok(views.every(v => v.stopped), 'the old month\'s views let go');
    eq(h.eds.views.length, 4);
    ok(h.eds.views.slice(2).every(v => v.started && !v.stopped), 'kept: the next visit may want them');
    h.service.stop();
    ok(h.eds.views.every(v => v.stopped));
});

test('service: closing and reopening the island makes no EDS call (calendar-3)', async () => {
    const h = harness();
    h.service.start();
    h.service.setActive(true);
    await settle();
    const views = [...h.eds.views];
    for (let i = 0; i < 5; i++) {
        h.service.setActive(false);
        eq(h.eds.paused, true);
        h.service.setActive(true);
        eq(h.eds.paused, false);
        await settle();
    }
    eq(h.eds.views.length, 2, 'no new view');
    ok(views.every(v => v.starts === 1 && !v.stopped), 'started once, never let go');
    eq(h.service.viewCount, 2);
    h.service.stop();
});

test('service: a visit on another day than the last restarts the views only when the month moved', async () => {
    const h = harness();
    h.service.start();
    h.service.setActive(true);
    await settle();
    h.service.showMonth(1);
    await settle();
    eq(h.eds.views.length, 4);
    h.service.setActive(false);
    // Each visit starts on today: back to October's grid.
    h.service.setActive(true);
    await settle();
    eq(h.eds.live('work')[0].range.start, at(tz, 2026, 9, 28));
    h.service.setActive(false);
    h.service.setActive(true);
    await settle();
    eq(h.eds.views.length, 6, 'the same month: kept');
    h.service.stop();
});

test('service: the wheel over the grid: the first month at once, the last after a quiet moment, none between', async () => {
    const h = harness();
    h.service.start();
    h.service.setActive(true);
    await settle();
    h.timeout.fire();
    eq(h.eds.views.length, 2);
    h.service.showMonth(1);
    await settle();
    eq(h.eds.views.length, 4, 'the first notch at once');
    for (let i = 0; i < 5; i++)
        h.service.showMonth(1);
    await settle();
    eq(h.eds.views.length, 4, 'the next notches wait');
    eq(h.service.agenda().loading, true, '"Loading…" meanwhile, not "No events"');
    ok(!h.service.settled);
    h.timeout.fire();
    await settle();
    eq(h.eds.views.length, 6, 'one set of views for the month shown');
    eq(h.eds.live('work')[0].range.start, at(tz, 2027, 3, 29));
    for (const view of h.eds.live('work'))
        view.emit('complete', null);
    for (const view of h.eds.live('personal'))
        view.emit('complete', null);
    ok(h.service.settled);
    h.timeout.fire();
    eq(h.eds.views.length, 6, 'nothing more once quiet');
    h.service.stop();
    eq(h.timeout.pending, 0);
});

test('service: live additions, changes and removals: one \'changed\' per main-loop turn', async () => {
    const h = harness();
    h.service.start();
    h.service.setActive(true);
    await settle();
    for (const view of h.eds.views)
        view.emit('complete', null);
    h.idle.run();
    const before = h.changes();
    const [view] = h.eds.live('work');
    view.emit('items', [item('a', 'A', NOON + 3600, NOON + 7200)]);
    view.emit('items', [item('a', 'A renamed', NOON + 3600, NOON + 7200), item('b', 'B', NOON, NOON + 60)]);
    view.emit('removed', ['b\n']);
    eq(h.changes(), before, 'nothing before the idle');
    h.idle.run();
    eq(h.changes(), before + 1);
    const today = h.service.agenda().days.find(d => d.isToday);
    eq(today.entries.map(e => e.item.title), ['A renamed']);
    h.service.stop();
});

test('service: while a calendar loads, the tab redraws at most every LOADING_REDRAW_MS; completion at once', async () => {
    const h = harness();
    h.service.start();
    h.service.setActive(true);
    await settle();
    h.idle.run();
    h.timeout.fire();
    const before = h.changes();
    const [view] = h.eds.live('work');
    // A large calendar: a batch per expansion turn.
    for (let i = 0; i < 40; i++) {
        view.emit('items', [item(`e${i}`, `E${i}`, NOON + i * 60, NOON + i * 60 + 30)]);
        h.idle.run();
        h.advance(5);
    }
    eq([h.changes(), h.timeout.pending], [before, 1], 'drawn at 0 ms: the next waits for 200 ms');
    h.timeout.fire();
    eq(h.changes(), before + 1, 'one redraw for 40 batches');
    h.advance(50);
    view.emit('items', [item('last', 'Last', NOON, NOON + 30)]);
    eq(h.timeout.pending, 1);
    for (const v of h.eds.views)
        v.emit('complete', null);
    h.idle.run();
    eq([h.changes(), h.timeout.pending], [before + 2, 0], 'complete: at once');
    view.emit('items', [item('live', 'Live', NOON, NOON + 30)]);
    h.idle.run();
    eq(h.changes(), before + 3, 'loaded: live changes redraw in the next turn');
    eq(h.timeout.pending, 0);
    h.service.stop();
});

test('service: a series\' moved occurrences (fetched apart by eds.js) replace its own', async () => {
    const h = harness();
    h.service.start();
    h.service.setActive(true);
    await settle();
    const [view] = h.eds.live('work');
    const nine = at(tz, 2026, 10, 2, 9);
    const series = {
        key: 'rec\n', uid: 'rec', rid: null, title: 'Standup', location: null, cancelled: false,
        occurrences: [0, 1, 2].map(day => ({allDay: false, start: nine + day * 86400, end: nine + day * 86400 + 900,
            rid: nine + day * 86400})),
    };
    view.emit('items', [series]);
    view.emit('detached', 'rec', [timed('rec', 'Standup (moved)', nine + 86400 + 9000, nine + 86400 + 9900,
        {rid: nine + 86400, recurrenceId: '20261003T090000'})]);
    view.emit('complete', null);
    const titles = () => h.service.agenda().days.flatMap(d => d.entries.map(e => e.item.title));
    eq(titles(), ['Standup', 'Standup (moved)', 'Standup']);
    view.emit('detached', 'rec', []);
    eq(titles(), ['Standup', 'Standup', 'Standup'], 'moved back');
    h.service.stop();
});

test('service: a calendar appearing opens a view; disappearing stops it and drops its events', async () => {
    const h = harness();
    h.service.start();
    h.service.setActive(true);
    await settle();
    h.eds.addCalendar(info('team', 'Team'));
    await settle();
    eq(h.eds.live('team').length, 1);
    h.eds.live('team')[0].emit('items', [item('t', 'Team thing', NOON, NOON + 60)]);
    ok(h.service.agenda().count === 1);
    const [view] = h.eds.live('team');
    h.eds.removeCalendar('team');
    ok(view.stopped);
    eq([h.service.agenda().count, h.service.calendars.map(c => c.uid)], [0, ['personal', 'work']]);
    h.service.stop();
});

test('service: hiding a calendar in the settings stops its view; showing it reopens one', async () => {
    const h = harness();
    h.service.start();
    h.service.setActive(true);
    await settle();
    const [view] = h.eds.live('work');
    view.emit('items', [item('w', 'Work thing', NOON, NOON + 60)]);
    h.settings.set_strv('calendar-hidden-sources', ['work']);
    ok(view.stopped);
    eq([h.service.viewCount, h.service.agenda().count], [1, 0]);
    h.settings.set_strv('calendar-hidden-sources', []);
    await settle();
    eq([h.service.viewCount, h.eds.live('work').length], [2, 1]);
    h.service.stop();
});

test('service: another month replaces the views; late events from the old ones are ignored', async () => {
    const h = harness();
    h.service.start();
    h.service.setActive(true);
    await settle();
    const old = h.eds.live('work')[0];
    h.service.showMonth(1);
    await settle();
    ok(old.stopped);
    const fresh = h.eds.live('work');
    eq(fresh.length, 1);
    eq(fresh[0].range.start, at(tz, 2026, 10, 26));
    eq([h.service.selected, h.service.shownMonth], [D(2026, 11, 2), {y: 2026, m: 11}]);
    old.emit('items', [item('late', 'Late', NOON, NOON + 60)]);
    eq(h.service._store.size('work'), 0);
    h.service.stop();
});

test('service: the previous events stay until the new view completes, then the rest goes', async () => {
    const h = harness();
    h.service.start();
    h.service.setActive(true);
    await settle();
    const first = h.eds.live('work')[0];
    first.emit('items', [item('keep', 'Keep', NOON, NOON + 60), item('drop', 'Drop', NOON + 60, NOON + 120)]);
    first.emit('complete', null);
    h.service.showMonth(1);
    await settle();
    const second = h.eds.live('work')[0];
    ok(second !== first);
    eq(h.service._store.size('work'), 2, 'still shown while loading');
    eq(h.service.loading, false, 'the old events show, not "Loading…"');
    second.emit('items', [item('keep', 'Keep', NOON, NOON + 60)]);
    eq(h.service._store.size('work'), 2);
    second.emit('complete', null);
    eq(h.service._store.items('work').map(i => i.uid), ['keep']);
    h.service.stop();
});

test('service: a calendar that cannot be read is listed; the others still show', async () => {
    const h = harness();
    h.eds.failing.add('work');
    h.service.start();
    h.service.setActive(true);
    await settle();
    eq(h.service.unavailable.map(c => c.name), ['Work']);
    eq(h.eds.live('personal').length, 1);
    h.eds.failing.clear();
    h.service.setActive(false);
    h.service.setActive(true);
    await settle();
    eq([h.service.unavailable.length, h.eds.live('work').length], [0, 1], 'tried again on the next visit');
    eq(h.eds.views.filter(v => v.uid === 'personal').length, 1, 'the others kept');
    h.service.stop();
});

test('service: a new time zone restarts the views with it', async () => {
    const h = harness();
    h.service.start();
    h.service.setActive(true);
    await settle();
    eq(h.service.clockChanged(), false);
    const old = h.eds.live('personal')[0];
    h.clock.timeZone = VANCOUVER;
    eq(h.service.clockChanged(), true);
    await settle();
    ok(old.stopped);
    eq(h.eds.live('personal')[0].range.tzid, 'America/Vancouver');
    h.service.stop();
});

test('service: stop() leaves no handler and no pending idle', async () => {
    const h = harness();
    h.service.start();
    h.service.setActive(true);
    await settle();
    h.eds.live('work')[0].emit('items', [item('a', 'A', NOON, NOON + 60)]);
    ok(h.idle.pending > 0);
    h.service.showMonth(1);
    h.service.showMonth(1);
    ok(h.timeout.pending > 0);
    h.service.stop();
    eq([h.settings.handlers.size, h.desktop.handlers.size, h.eds.handlers, h.idle.pending, h.timeout.pending],
        [0, 0, 0, 0, 0]);
    // The views still being opened are let go when EDS answers.
    await settle();
    ok(h.eds.stopped && h.eds.views.every(v => v.stopped && v.handlers === 0));
});

test('service: the granularity is remembered; the grid marks the span', async () => {
    const h = harness();
    h.service.start();
    h.service.setActive(true);
    await settle();
    h.service.setGranularity('month');
    eq([h.settings.all['calendar-granularity'], h.service.granularity], ['month', 'month']);
    h.service.setGranularity('year');
    eq(h.settings.all['calendar-granularity'], 'month');
    h.service.setGranularity('week');
    const grid = h.service.grid();
    const inSpan = grid.rows.flatMap(r => r.days).filter(d => d.inSpan).map(d => dateKey(d.date));
    eq(inSpan, keys(daysOf(D(2026, 9, 28), 7)));
    eq([grid.showWeekNumbers, grid.rows[0].week, grid.weekStart], [true, 40, 1]);
    h.service.stop();
});

test('service: choosing a day of another month shows that month; Today comes back', async () => {
    const h = harness();
    h.service.start();
    h.service.setActive(true);
    await settle();
    h.service.select(D(2026, 10, 20));
    eq(h.eds.views.length, 2, 'a day inside the shown month: no EDS work');
    h.service.select(D(2026, 11, 3));
    eq(h.service.shownMonth, {y: 2026, m: 11});
    h.service.today();
    eq([h.service.selected, h.service.shownMonth], [D(2026, 10, 2), {y: 2026, m: 10}]);
    h.service.stop();
});

test('service: "Next" only when nothing between now and it can be missing (calendar-6)', async () => {
    const h = harness();
    h.service.start();
    h.service.setActive(true);
    await settle();
    const [view] = h.eds.live('work');
    // Today is Fri 2 Oct, noon: a meeting tomorrow, events later on.
    view.emit('items', [
        item('tomorrow', 'Tomorrow', at(tz, 2026, 10, 3, 9), at(tz, 2026, 10, 3, 10)),
        item('later', 'Later', at(tz, 2026, 10, 20, 9), at(tz, 2026, 10, 20, 10)),
        item('november', 'November', at(tz, 2026, 11, 4, 9), at(tz, 2026, 11, 4, 10)),
    ]);
    view.emit('complete', null);
    const states = () => Object.fromEntries(h.service.agenda().days.flatMap(d => d.entries)
        .map(e => [e.item.title, e.state]));
    h.service.setGranularity('day');
    h.service.select(D(2026, 10, 20));
    eq(states(), {Later: null}, 'a later day: its first event is not next');
    h.service.select(D(2026, 10, 3));
    eq(states(), {Tomorrow: 'next'}, 'tomorrow\'s meeting is');
    h.service.setGranularity('month');
    h.service.showMonth(1);
    await settle();
    const [november] = h.eds.live('work');
    november.emit('items', [item('november', 'November', at(tz, 2026, 11, 4, 9), at(tz, 2026, 11, 4, 10))]);
    november.emit('complete', null);
    eq(states(), {November: null}, 'next month: its views do not hold now');
    h.service.stop();
});

test('service: links open the event\'s day, after closing the island; local events none', async () => {
    const h = harness();
    h.service.start();
    h.service.setActive(true);
    await settle();
    h.eds.live('work')[0].emit('items', [item('w', 'Work thing', NOON, NOON + 60)]);
    h.eds.live('personal')[0].emit('items', [item('p', 'Mine', NOON, NOON + 60)]);
    const entries = h.service.agenda().days.find(d => d.isToday).entries;
    const work = entries.find(e => e.item.title === 'Work thing');
    ok(h.service.openOccurrence(work, D(2026, 10, 2)));
    eq(h.opened, ['collapse', 'https://calendar.google.com/calendar/r/day/2026/10/2']);
    ok(!h.service.openOccurrence(entries.find(e => e.item.title === 'Mine'), D(2026, 10, 2)));
    eq(h.service.providers().map(p => p.label), ['Google']);
    h.service.stop();
});

// ---------------------------------------------------------------- static checks

const SOURCE_DIR = GLib.build_filenamev([GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]),
    '..', '..', 'froonty@catalin', 'features', 'calendar']);

function sources() {
    const dir = GLib.Dir.open(SOURCE_DIR, 0);
    const files = [];
    for (let name = dir.read_name(); name !== null; name = dir.read_name()) {
        if (name.endsWith('.js')) {
            const [, bytes] = GLib.file_get_contents(GLib.build_filenamev([SOURCE_DIR, name]));
            files.push({name, text: new TextDecoder().decode(bytes)});
        }
    }
    dir.close();
    ok(files.length >= 8, `found ${files.length} files`);
    return files;
}

test('static: the Calendar tab never writes to a calendar', () => {
    // .remove( on anything but the Shell's laters (a main-loop callback).
    const writes = /create_object|modify_object|remove_object|create_objects|modify_objects|remove_objects|commit_source|create_sources|\.write\(|(?<!get_laters\(\))\.remove\(|receive_objects|send_objects|discard_alarm/;
    for (const {name, text} of sources())
        ok(!writes.test(text), `${name}: ${writes.exec(text)?.[0]}`);
});

// The code without its comments.
const code = text => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

test('static: no synchronous call but libecal\'s CPU-only expansion and one ClientView.start() (calendar-3)', () => {
    for (const {name, text} of sources()) {
        const source = code(text);
        const calls = [...source.matchAll(/\w*_sync\(/g)].map(m => m[0])
            .filter(call => call !== 'recur_generate_instances_sync(');
        eq(calls, [], name);
        // ECal.ClientView's start, stop, set_flags and
        // set_fields_of_interest are synchronous D-Bus calls although
        // their names do not say so; only start() is made, once per view.
        ok(!/(clientView|_clientView|\bview)\.(stop|set_flags|set_fields_of_interest)\(/.test(source), name);
        // Only the source registry and its watcher, in disposeRegistry():
        // their dispose runs the main context, which must not happen
        // during a garbage collection (eds.js).
        const disposes = [...source.matchAll(/(\w+)\?\.run_dispose\(\)/g)].map(m => m[1]);
        eq(disposes, name === 'eds.js' ? ['watcher', 'registry'] : [], `${name}: run_dispose`);
        ok(!/\.run_dispose\(\)/.test(source.replace(/\w+\?\.run_dispose\(\)/g, '')), `${name}: other run_dispose`);
    }
    const eds = code(sources().find(file => file.name === 'eds.js').text);
    eq([...eds.matchAll(/\.start\(\);/g)].length, 1, 'one ClientView.start() call site');
    eq([...eds.matchAll(/\.stop\(\)/g)].map(m => m.index).length, 1, 'eds.js stops nothing but its scheduler');
    ok(/this\._scheduler\.stop\(\)/.test(eds));
});

test('static: the Calendars settings let go of EDS when the window closes, not on a page\'s destroy (calendar-5)', () => {
    const prefs = sources().find(file => file.name === 'prefs.js').text;
    ok(/window\.connect\('close-request'/.test(prefs), 'close-request');
    ok(!/\.connect\('destroy'/.test(prefs), 'GTK 4 emits no destroy on a closed window\'s pages');
    const [, main] = GLib.file_get_contents(GLib.build_filenamev([SOURCE_DIR, '..', '..', 'prefs.js']));
    ok(/calendarPage\(settings, window\)/.test(new TextDecoder().decode(main)), 'the window is passed');
});

test('static: the EDS bindings are only imported at run time', () => {
    for (const {name, text} of sources())
        ok(!/from\s+'gi:\/\/(ECal|EDataServer|ICalGLib|GIRepository)/.test(text), name);
});

await done();
