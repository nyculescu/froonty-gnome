// SPDX-License-Identifier: GPL-3.0-or-later
// Calendar tab (docs/features/calendar.md §B): the user's calendars from
// Evolution Data Server, the month the grid shows, the selected day and
// span, and the events in them. No St and no Shell imports: what the
// Shell provides comes in `deps` (index.js), so this runs in plain-gjs
// unit tests over a fake EDS.
//
// Lazy and event-driven:
// - start() only connects settings. EDS is loaded the first time the tab
//   comes on screen; while it is missing (or failed), every visit tries
//   again, so installing gir1.2-ecal-2.0 works without logging out.
// - Each visible calendar has a live EDS view of the grid's six weeks,
//   from the first time the tab shows that month until another month,
//   another zone or stop(). While the tab is not on screen the views
//   stay, paused: what EDS sends waits in them, unexpanded (eds.js), and
//   closing or reopening the island makes no EDS call. Choosing a day
//   inside the six weeks needs no EDS work; another month replaces the
//   views, at once, or once the months have stopped changing for
//   RANGE_QUIET_MS (the wheel over the grid). The registry and the
//   calendar connections stay until stop().
// - The events of a view that is replaced stay on screen until its
//   successor has delivered its own ('complete'), then what it did not
//   deliver again is dropped: no flicker.
// - 'changed' is emitted at most once per main-loop turn.
//
// Read-only: nothing here writes to a calendar.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {Emitter} from '../../core/emitter.js';
import {sanitizeColor} from './color.js';
import {loadEds as realLoadEds} from './eds.js';
import {agendaDays, dayMarks, EventStore} from './model.js';
import {detectProvider, urlForDay} from './providers.js';
import {
    dateKey, dateOf, dayOfWeek, gridRange, GRANULARITIES, isWeekend, sameDate, shiftMonth,
    span, weeksOf,
} from './range.js';

export const HIDDEN_KEY = 'calendar-hidden-sources';
export const GRANULARITY_KEY = 'calendar-granularity';
const WEEK_START_KEY = 'week-start-day';
const WEEKDATE_KEY = 'show-weekdate';
// GNOME Shell's translatable list of days off (ui/calendar.js).
const NO_WORK = 'calendar-no-work\u000406';

/**
 * After a month (or zone) change that replaced the views, how long the
 * month must stay put before the next change replaces them again.
 */
export const RANGE_QUIET_MS = 250;
/**
 * While a view is still delivering its first events, the tab redraws at
 * most this often: a large calendar arrives over many short expansion
 * turns (eds.js), and redrawing after each would cost more than the
 * expansion.
 */
export const LOADING_REDRAW_MS = 200;

const defaultIdle = {
    add: fn => GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        fn();
        return GLib.SOURCE_REMOVE;
    }),
    cancel: id => GLib.source_remove(id),
};

const defaultTimeout = {
    add: (ms, fn) => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        fn();
        return GLib.SOURCE_REMOVE;
    }),
    cancel: id => GLib.source_remove(id),
};

const isCancelled = e => e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);

export class CalendarService extends Emitter {
    /**
     * @param {Gio.Settings} settings Froonty's
     * @param {object} deps
     * @param {Function} [deps.loadEds] eds.js loadEds, or a fake
     * @param {object} deps.clock `timeZone` (GLib.TimeZone)
     * @param {Function} [deps.localeWeekStart] the locale's first weekday (0 = Sunday)
     * @param {Function} [deps.translate] GNOME Shell's time-string translation
     * @param {Function} [deps.desktopCalendar] makes org.gnome.desktop.calendar settings
     * @param {Function} [deps.openUri] opens a web page
     * @param {Function} [deps.openOnlineAccounts]
     * @param {Function} [deps.collapse] closes the island (before a browser opens)
     * @param {object} [deps.idle] {add(fn) → id, cancel(id)}
     * @param {object} [deps.timeout] {add(ms, fn) → id, cancel(id)}
     * @param {Function} [deps.now] seconds since the epoch
     * @param {Function} [deps.monotonic] milliseconds, for the redraw rate
     */
    constructor(settings, deps = {}) {
        super();
        this._settings = settings;
        this._deps = deps;
        this._clock = deps.clock;
        this._idle = deps.idle ?? defaultIdle;
        this._timeout = deps.timeout ?? defaultTimeout;
        this._now = deps.now ?? (() => GLib.get_real_time() / 1e6);
        this._monotonic = deps.monotonic ?? (() => GLib.get_monotonic_time() / 1000);
        // Replaceable by tests.
        this._loadEds = deps.loadEds ?? realLoadEds;
        this._detectProvider = detectProvider;

        this._settingsIds = [];
        this._desktopCalendar = null;
        this._desktopIds = [];
        this._adapter = null;
        this._adapterIds = [];
        this._lifeCancellable = null;
        // Cancels the views being opened: replaced on each new range.
        this._viewsCancellable = null;
        this._loading = null;
        this._active = false;
        this._stopped = false;
        this._changedId = 0;
        // Whether _changedId is a timeout (a throttled redraw) or an idle.
        this._changedLater = false;
        this._lastChanged = -Infinity;
        // The quiet period after the views were replaced, and whether the
        // range changed again during it.
        this._quietId = 0;
        this._rangePending = false;

        /** 'idle', 'loading', 'ready', 'missing' or 'error'. */
        this.state = 'idle';
        /** Why EDS could not be used ('error'). */
        this.errorMessage = null;
        /** 'bindings' (the import failed) or 'service' (EDS did not answer). */
        this.errorKind = null;
        this._all = new Map();
        this._views = new Map();
        this._failed = new Map();
        this._store = new EventStore();
        // The views' range and zone: {start, end, tzid}, or null.
        this._range = null;
        // Bumped whenever the views' range or zone changes.
        this._generation = 0;

        const today = this._today();
        /** The selected day, {y, m, d}. */
        this.selected = today;
        /** The month the grid shows, {y, m}. */
        this.shownMonth = {y: today.y, m: today.m};
        this._readSettings();
    }

    start() {
        this._settingsIds = [HIDDEN_KEY, GRANULARITY_KEY].map(key =>
            this._settings.connect(`changed::${key}`, () => this._onSettingChanged(key)));
        this._desktopCalendar = this._deps.desktopCalendar?.() ?? null;
        const schema = this._desktopCalendar?.settings_schema;
        this._desktopIds = [WEEK_START_KEY, WEEKDATE_KEY]
            .filter(key => !schema || schema.has_key(key))
            .map(key => this._desktopCalendar.connect(`changed::${key}`, () => this._onDesktopChanged()));
        this._readSettings();
    }

    stop() {
        this._stopped = true;
        this.setActive(false);
        this._closeViews();
        this._cancelQuiet();
        this._lifeCancellable?.cancel();
        this._lifeCancellable = null;
        for (const id of this._adapterIds)
            this._adapter.disconnect(id);
        this._adapterIds = [];
        this._adapter?.stop();
        this._adapter = null;
        for (const id of this._settingsIds)
            this._settings.disconnect(id);
        this._settingsIds = [];
        for (const id of this._desktopIds)
            this._desktopCalendar.disconnect(id);
        this._desktopIds = [];
        this._desktopCalendar = null;
        this._cancelChanged();
    }

    /**
     * On screen: today is selected, EDS loaded if needed, views opened
     * (or reused). Off screen: the views pause; nothing is closed.
     */
    setActive(active) {
        if (active === this._active)
            return;
        this._active = active;
        this._adapter?.setPaused(!active);
        if (!active) {
            this._cancelQuiet();
            this._cancelChanged();
            return;
        }
        if (this._stopped)
            return;
        // As GNOME's date menu: each visit starts on today.
        const today = this._today();
        this.selected = today;
        this.shownMonth = {y: today.y, m: today.m};
        // A calendar that failed gets another chance on each visit.
        this._failed.clear();
        if (this.state === 'ready')
            this._openViews(!this._sameRange());
        else if (this.state !== 'loading')
            this._load();
        this._queueChanged();
    }

    get active() {
        return this._active;
    }

    /** For tests and the budget: views open (or opening). */
    get viewCount() {
        return this._views.size;
    }

    get clientCount() {
        return this._adapter?.clientCount ?? 0;
    }

    get registry() {
        return this._adapter?.registry ?? null;
    }

    // ------------------------------------------------------------ reading

    /** The first day of the week, 0 = Sunday, as GNOME's calendar. */
    get weekStart() {
        const settings = this._desktopCalendar;
        if (settings && settings.settings_schema?.has_key(WEEK_START_KEY) !== false) {
            // GDesktopEnums.Weekday: 0 = the locale's, 1 = Monday ... 7 = Sunday.
            const day = settings.get_enum(WEEK_START_KEY);
            if (day > 0)
                return day % 7;
        }
        const locale = this._deps.localeWeekStart?.();
        return Number.isInteger(locale) && locale >= 0 && locale <= 6 ? locale : 1;
    }

    get showWeekNumbers() {
        const settings = this._desktopCalendar;
        return Boolean(settings && settings.settings_schema?.has_key(WEEKDATE_KEY) !== false &&
            settings.get_boolean(WEEKDATE_KEY));
    }

    get timeZone() {
        return this._clock?.timeZone ?? GLib.TimeZone.new_local();
    }

    /** The visible calendars in GNOME's order, each with its provider. */
    get calendars() {
        const hidden = new Set(this._settings.get_strv(HIDDEN_KEY));
        return [...this._all.values()]
            .filter(info => !hidden.has(info.uid))
            .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name) ||
                a.uid.localeCompare(b.uid))
            .map(info => ({
                uid: info.uid,
                name: info.name,
                color: sanitizeColor(info.color),
                provider: this._detectProvider(info),
            }));
    }

    /** Calendars that could not be read this visit: [{uid, name}]. */
    get unavailable() {
        const visible = new Set(this.calendars.map(calendar => calendar.uid));
        return [...this._failed.keys()].filter(uid => visible.has(uid))
            .map(uid => ({uid, name: this._all.get(uid)?.name ?? uid,
                provider: this._detectProvider(this._all.get(uid) ?? {})}));
    }

    /** Before any view has delivered its events. */
    get loading() {
        if (this.state === 'loading')
            return true;
        if (this.state !== 'ready')
            return false;
        const entries = [...this._views.values()];
        return entries.length > 0 && entries.every(entry => !entry.complete) &&
            entries.every(entry => this._store.size(entry.uid) === 0);
    }

    /**
     * Every view is over the month shown and has delivered its events
     * (tests).
     */
    get settled() {
        return this.state === 'ready' && !this._rangePending && this._sameRange() &&
            [...this._views.values()].every(entry => entry.complete);
    }

    _today() {
        return dateOf(this._now(), this.timeZone);
    }

    _order(calendars) {
        return new Map(calendars.map((calendar, i) => [calendar.uid, i]));
    }

    _grid() {
        return gridRange(this.shownMonth.y, this.shownMonth.m, this.weekStart, this.timeZone);
    }

    /**
     * The month grid: six rows of seven days, each with its flags and up
     * to three calendar colours.
     */
    grid() {
        const tz = this.timeZone;
        const calendars = this.calendars;
        const colors = new Map(calendars.map(calendar => [calendar.uid, calendar.color]));
        const grid = this._grid();
        const marks = dayMarks(this._store.occurrences(calendars.map(c => c.uid)),
            grid.days, tz, this._order(calendars));
        const current = span(this.selected, this.granularity, this.weekStart, tz);
        const inSpan = new Set(current.days.map(dateKey));
        const today = this._today();
        const noWork = this._deps.translate?.(NO_WORK) ?? '06';
        return {
            month: {...this.shownMonth},
            weekStart: this.weekStart,
            showWeekNumbers: this.showWeekNumbers,
            rows: weeksOf(grid.days).map(({week, days}) => ({
                week,
                days: days.map(date => {
                    const key = dateKey(date);
                    const mark = marks.get(key) ?? {count: 0, calendars: []};
                    const dow = dayOfWeek(date);
                    return {
                        date,
                        dow,
                        inMonth: date.m === this.shownMonth.m && date.y === this.shownMonth.y,
                        isToday: sameDate(date, today),
                        isSelected: sameDate(date, this.selected),
                        inSpan: inSpan.has(key),
                        isWeekend: isWeekend(dow, noWork),
                        count: mark.count,
                        dots: mark.calendars.map(uid => colors.get(uid) ?? null),
                    };
                }),
            })),
        };
    }

    /**
     * The agenda of the selected span: its days with their events (see
     * model.js agendaDays), each entry with its calendar.
     */
    agenda() {
        const tz = this.timeZone;
        const calendars = this.calendars;
        const byUid = new Map(calendars.map(calendar => [calendar.uid, calendar]));
        const current = span(this.selected, this.granularity, this.weekStart, tz);
        const now = this._now();
        // "Next" is the first event after now of every event known, so
        // only when the views' range holds now: nothing between now and
        // the span is then missing.
        const range = this._range;
        const knowsNow = range !== null && range.start <= now && now < range.end;
        const {days, truncated} = agendaDays(
            this._store.occurrences(calendars.map(c => c.uid)), current.days, tz, now,
            {order: this._order(calendars), next: knowsNow ? undefined : null});
        const today = this._today();
        for (const day of days) {
            day.isToday = sameDate(day.date, today);
            for (const entry of day.entries)
                entry.calendar = byUid.get(entry.calendarUid);
        }
        const count = days.reduce((sum, day) => sum + day.entries.length, 0);
        return {
            granularity: this.granularity,
            selected: {...this.selected},
            span: current,
            today,
            days,
            truncated,
            // While another month's views wait for the quiet period,
            // "Loading…" rather than "No events".
            loading: this.loading || (this._rangePending && count === 0),
            count,
        };
    }

    /**
     * The web calendars among the visible ones, once per (provider,
     * account): [{kind, label, account, homeUrl, dayUrl, showAccount}].
     */
    providers() {
        const seen = new Map();
        for (const {provider} of this.calendars) {
            if (!provider.homeUrl && !provider.dayUrl)
                continue;
            const key = `${provider.kind}\n${provider.account ?? ''}`;
            if (!seen.has(key))
                seen.set(key, provider);
        }
        const list = [...seen.values()];
        return list.map(provider => ({
            ...provider,
            showAccount: Boolean(provider.account) &&
                list.filter(other => other.kind === provider.kind).length > 1,
        }));
    }

    /** Today's date in the clock's zone. */
    todayDate() {
        return this._today();
    }

    // ------------------------------------------------------------ actions

    select(date) {
        this.selected = {y: date.y, m: date.m, d: date.d};
        if (date.y !== this.shownMonth.y || date.m !== this.shownMonth.m)
            this._showMonthOf(this.selected);
        this._queueChanged();
    }

    /** 'day', 'week' or 'month'; remembered in the settings. */
    setGranularity(granularity) {
        if (GRANULARITIES.includes(granularity) && granularity !== this.granularity)
            this._settings.set_string(GRANULARITY_KEY, granularity);
    }

    /** The previous (-1) or next (+1) month, as GNOME's calendar's arrows. */
    showMonth(delta) {
        this.selected = shiftMonth(this.selected, delta);
        this._showMonthOf(this.selected);
        this._queueChanged();
    }

    today() {
        this.select(this._today());
    }

    /**
     * Opens an event's day in the web calendar it comes from.
     *
     * @param {object} entry an agenda entry
     * @param {object} date the day group it was shown under
     * @returns {boolean} whether a page was opened
     */
    openOccurrence(entry, date) {
        return this._open(urlForDay(entry?.calendar?.provider, date));
    }

    /** Opens a web calendar on the selected day. */
    openProvider(provider) {
        return this._open(urlForDay(provider, this.selected));
    }

    openOnlineAccounts() {
        this._deps.collapse?.();
        this._deps.openOnlineAccounts?.();
    }

    /** Opens a page in the browser. Replaceable by tests. */
    openUri(url) {
        this._deps.openUri?.(url);
    }

    _open(url) {
        if (!url || !/^https?:\/\//.test(url))
            return false;
        this._deps.collapse?.();
        this.openUri(url);
        return true;
    }

    /**
     * The clock ticked: a new zone restarts the views; a new day moves
     * "today". Returns whether anything but the time of day changed.
     */
    clockChanged() {
        const tzid = this.timeZone.get_identifier();
        if (this._range !== null && tzid !== this._range.tzid && this._active && this.state === 'ready') {
            this._rangeChanged();
            this._queueChanged();
            return true;
        }
        return false;
    }

    // ------------------------------------------------------------ loading

    _readSettings() {
        const granularity = this._settings.get_string(GRANULARITY_KEY);
        /** 'day', 'week' or 'month'. */
        this.granularity = GRANULARITIES.includes(granularity) ? granularity : 'week';
    }

    _onSettingChanged(key) {
        if (key === GRANULARITY_KEY) {
            this._readSettings();
        } else if (key === HIDDEN_KEY) {
            const visible = new Set(this.calendars.map(calendar => calendar.uid));
            for (const uid of [...this._views.keys()]) {
                if (!visible.has(uid)) {
                    this._closeView(uid);
                    this._store.dropCalendar(uid);
                }
            }
            this._openViews(false);
        }
        this._queueChanged();
    }

    // The week's first day changes the grid's first day, so its range.
    _onDesktopChanged() {
        if (!this._sameRange())
            this._rangeChanged();
        this._queueChanged();
    }

    _showMonthOf(date) {
        this.shownMonth = {y: date.y, m: date.m};
        if (!this._sameRange())
            this._rangeChanged();
    }

    // Whether the views are over the grid shown, in the clock's zone.
    _sameRange() {
        const grid = this._grid();
        const range = this._range;
        return range !== null && range.start === grid.start && range.end === grid.end &&
            range.tzid === this.timeZone.get_identifier();
    }

    // Another month or zone. New views at once, unless the last ones were
    // made less than RANGE_QUIET_MS ago (the wheel over the grid, or ›
    // clicked fast): then for the month shown once it has stayed that
    // long, so the months in between cost no EDS views. Off screen:
    // on the next visit (setActive).
    _rangeChanged() {
        if (!this._active || this.state !== 'ready')
            return;
        if (this._quietId) {
            this._rangePending = true;
            this._timeout.cancel(this._quietId);
            this._armQuiet();
            return;
        }
        this._openViews(true);
        this._armQuiet();
    }

    _armQuiet() {
        this._quietId = this._timeout.add(RANGE_QUIET_MS, () => this._onQuiet());
    }

    _onQuiet() {
        this._quietId = 0;
        const pending = this._rangePending;
        this._rangePending = false;
        if (pending && this._active && this.state === 'ready' && !this._sameRange()) {
            this._openViews(true);
            this._armQuiet();
            this._queueChanged();
        }
    }

    _cancelQuiet() {
        if (this._quietId)
            this._timeout.cancel(this._quietId);
        this._quietId = 0;
        this._rangePending = false;
    }

    async _load() {
        this.state = 'loading';
        this._queueChanged();
        let result;
        try {
            result = await this._loadEds();
        } catch (e) {
            result = {status: 'error', message: e.message};
        }
        if (this._stopped)
            return;
        if (result.status !== 'ok') {
            this.state = result.status === 'missing' ? 'missing' : 'error';
            this.errorMessage = result.message ?? null;
            this.errorKind = 'bindings';
            this._queueChanged();
            return;
        }
        const adapter = result.adapter;
        this._adapter = adapter;
        this._lifeCancellable = new Gio.Cancellable();
        this._adapterIds = [
            adapter.connect('calendar-appeared', (_a, info) => this._onAppeared(info)),
            adapter.connect('calendar-changed', (_a, info) => this._onCalendarChanged(info)),
            adapter.connect('calendar-disappeared', (_a, uid) => this._onDisappeared(uid)),
            adapter.connect('calendar-error', (_a, uid, message) => this._onCalendarError(uid, message)),
        ];
        try {
            await adapter.start(this._lifeCancellable);
        } catch (e) {
            if (this._stopped || this._adapter !== adapter)
                return;
            // Tried again on the next visit, with a fresh registry.
            for (const id of this._adapterIds)
                adapter.disconnect(id);
            this._adapterIds = [];
            adapter.stop();
            this._adapter = null;
            this._all.clear();
            this.state = 'error';
            this.errorMessage = e.message;
            this.errorKind = 'service';
            this._queueChanged();
            return;
        }
        if (this._stopped || this._adapter !== adapter)
            return;
        this.state = 'ready';
        this.errorMessage = null;
        adapter.setPaused(!this._active);
        this._openViews(true);
        this._queueChanged();
    }

    _onAppeared(info) {
        this._all.set(info.uid, info);
        this._failed.delete(info.uid);
        this._openViews(false);
        this._queueChanged();
    }

    _onCalendarChanged(info) {
        this._all.set(info.uid, info);
        this._queueChanged();
    }

    _onDisappeared(uid) {
        this._all.delete(uid);
        this._failed.delete(uid);
        this._closeView(uid);
        this._store.dropCalendar(uid);
        this._queueChanged();
    }

    _onCalendarError(uid, message) {
        this._failed.set(uid, message);
        this._closeView(uid);
        this._store.dropCalendar(uid);
        this._queueChanged();
    }

    // Opens a view for every visible calendar that has none; `restart`
    // first lets go of them all (another range or zone).
    _openViews(restart) {
        if (!this._active || this.state !== 'ready' || !this._adapter)
            return;
        if (restart || !this._range) {
            this._generation++;
            this._closeViews();
            const grid = this._grid();
            this._range = {start: grid.start, end: grid.end, tzid: this.timeZone.get_identifier()};
            this._viewsCancellable = new Gio.Cancellable();
        }
        for (const {uid} of this.calendars) {
            if (!this._views.has(uid) && !this._failed.has(uid))
                this._openView(uid, this._range);
        }
    }

    // Every view let go; opens in flight cancelled.
    _closeViews() {
        this._viewsCancellable?.cancel();
        this._viewsCancellable = null;
        for (const uid of [...this._views.keys()])
            this._closeView(uid);
    }

    _openView(uid, range) {
        const entry = {uid, view: null, ids: [], received: new Set(), complete: false,
            generation: this._generation, range};
        this._views.set(uid, entry);
        this._adapter.openView(uid, range, this._viewsCancellable).then(view => {
            // Closed meanwhile (hidden, another month, stopped).
            if (this._views.get(uid) !== entry) {
                view.release();
                return;
            }
            entry.view = view;
            entry.ids = [
                view.connect('items', (_v, items) => this._onItems(entry, items)),
                view.connect('detached', (_v, uid, items) => this._onDetached(entry, uid, items)),
                view.connect('removed', (_v, keys) => this._onRemoved(entry, keys)),
                view.connect('complete', (_v, message) => this._onComplete(entry, message)),
            ];
            view.start();
        }).catch(e => {
            if (this._views.get(uid) !== entry || isCancelled(e))
                return;
            this._views.delete(uid);
            this._onCalendarError(uid, e.message);
        });
    }

    // No D-Bus call: the view is let go (eds.js).
    _closeView(uid) {
        const entry = this._views.get(uid);
        if (!entry)
            return;
        this._views.delete(uid);
        for (const id of entry.ids)
            entry.view.disconnect(id);
        entry.ids = [];
        entry.view?.release();
    }

    _current(entry) {
        return this._views.get(entry.uid) === entry;
    }

    _onItems(entry, items) {
        if (!this._current(entry))
            return;
        if (!entry.complete) {
            for (const item of items)
                entry.received.add(item.key);
        }
        this._store.put(entry.uid, items);
        this._queueChanged();
    }

    // A repeating event's moved occurrences, all of them (eds.js).
    _onDetached(entry, uid, items) {
        if (!this._current(entry))
            return;
        for (const key of this._store.setDetached(entry.uid, uid, items))
            entry.received.delete(key);
        if (!entry.complete) {
            for (const item of items)
                entry.received.add(item.key);
        }
        this._queueChanged();
    }

    _onRemoved(entry, keys) {
        if (!this._current(entry))
            return;
        for (const key of this._store.removeKeys(entry.uid, keys))
            entry.received.delete(key);
        this._queueChanged();
    }

    // The initial events are in: whatever the previous view had that
    // this one did not deliver is gone (another range, or deleted).
    _onComplete(entry, message) {
        if (!this._current(entry))
            return;
        if (!entry.complete) {
            this._store.retain(entry.uid, entry.received);
            entry.received = new Set();
            entry.complete = true;
        }
        if (message)
            this._onCalendarError(entry.uid, message);
        // Not held back by the loading rate.
        if (this._changedLater)
            this._cancelChanged();
        this._queueChanged();
    }

    // Only while on screen: a hidden tab has nobody to tell, and a visit
    // starts with a fresh 'changed'. At most once per main-loop turn, and
    // once per LOADING_REDRAW_MS while a view has not delivered all its
    // first events.
    _queueChanged() {
        if (this._changedId || this._stopped || !this._active)
            return;
        const emit = () => {
            this._changedId = 0;
            this._changedLater = false;
            this._lastChanged = this._monotonic();
            this.emit('changed');
        };
        const loading = [...this._views.values()].some(entry => !entry.complete);
        const wait = loading ? Math.ceil(this._lastChanged + LOADING_REDRAW_MS - this._monotonic()) : 0;
        this._changedLater = wait > 0;
        this._changedId = this._changedLater ? this._timeout.add(wait, emit) : this._idle.add(emit);
    }

    _cancelChanged() {
        if (this._changedId) {
            if (this._changedLater)
                this._timeout.cancel(this._changedId);
            else
                this._idle.cancel(this._changedId);
        }
        this._changedId = 0;
        this._changedLater = false;
    }
}
