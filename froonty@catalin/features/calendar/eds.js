// SPDX-License-Identifier: GPL-3.0-or-later
// Calendar tab: the only module touching Evolution Data Server
// (docs/features/calendar.md §B). GNOME keeps the user's calendars there:
// the accounts in Settings → Online Accounts, and calendars added in
// GNOME Calendar or Evolution. Froonty only reads them; nothing here
// creates, changes or removes an event or a calendar.
//
// The bindings (ECal 2.0, EDataServer 1.2, ICalGLib 3.0; Debian and
// Ubuntu package them as gir1.2-ecal-2.0) are optional, so they are
// imported dynamically, and only once GIRepository says they are
// installed: GJS remembers a failed import for the rest of the Shell's
// life, even after the package is installed, while the probe sees a
// package installed later.
//
// Calls go through the bindings' asynchronous variants (callback +
// _finish), with one exception the bindings leave no choice about:
// ECal.ClientView.start() is a synchronous D-Bus call to
// evolution-calendar-factory (verified in libecal 3.56.2's code; about
// 0.3 ms here). It runs once per calendar and range: the first time the
// tab shows a month, and when it shows another one. Its siblings stop()
// and set_flags() are never called: a view Froonty is done with is let
// go, and libecal's dispose then tells the factory asynchronously
// (e_dbus_calendar_view_call_dispose: libecal 3.56.2 calls only that
// variant) once the garbage collector releases it; a new view already
// notifies its initial events.
//
// Signals are connected with plain connect() and disconnected one by one
// in release() and stop(). The garbage collector releases the EDS objects
// once Froonty lets go, except the source registry: one for the life of
// the Shell process (processRegistry()).

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {Emitter} from '../../core/emitter.js';
import {sexpTime} from './range.js';
import {Scheduler} from './scheduler.js';

const CALENDAR = 'Calendar';
const WEBDAV = 'WebDAV Backend';
const AUTHENTICATION = 'Authentication';
const COLLECTION = 'Collection';
/** Occurrences kept per event and range: a minutely event stops here. */
export const MAX_OCCURRENCES = 1000;
/** Occurrences one libecal call is planned to make for a sliced series. */
export const SLICE_OCCURRENCES = 50;
/** libecal calls for one series and range, at most. */
export const MAX_SLICES = 2000;
/**
 * A series expanded in one libecal call whose walk from its first
 * occurrence is estimated above this many occurrences is long: it runs
 * alone in its main-loop turn.
 */
export const LONG_OCCURRENCES = 200;
/** Occurrences one step walks along a series (_walk). */
const WALK_STEPS = 128;
// Room left before the range when a series' start is moved (seconds): an
// occurrence's length can differ from its first's by a daylight saving
// change.
const FIRST_MARGIN = 2 * 3600 + 1;
// ECal.Client.connect(): (guint32) -1 = "do not wait for the backend to
// be online"; a remote calendar opens with what EDS has cached and its
// view follows when EDS syncs.
const DO_NOT_WAIT = 0xFFFFFFFF;
const TZID = /^[A-Za-z0-9_+\-/]+$/;
const ECAL_CLIENT_ERROR = 'e-cal-client-error-quark';

// A callback-style asynchronous call as a promise. Not Gio._promisify():
// that patches the shared EDS classes for every extension.
function call(start, finish) {
    return new Promise((resolve, reject) => {
        start((source, result) => {
            try {
                resolve(finish(source, result));
            } catch (e) {
                reject(e);
            }
        });
    });
}

// Some _finish() functions return [ok, value] in GJS.
const value = result => Array.isArray(result) ? result.at(-1) : result;

/**
 * Whether the bindings are installed, without loading them.
 *
 * @returns {Promise<boolean>} throws when GIRepository 3.0 itself is
 *   missing (GLib before 2.80)
 */
export async function edsInstalled() {
    const {default: GIRepository} = await import('gi://GIRepository?version=3.0');
    const repository = GIRepository.Repository.dup_default();
    return [['ECal', '2.0'], ['EDataServer', '1.2'], ['ICalGLib', '3.0']]
        .every(([name, version]) => repository.enumerate_versions(name).includes(version));
}

/**
 * Loads the bindings.
 *
 * @returns {Promise<object>} {status: 'missing'}, {status: 'error',
 *   message} or {status: 'ok', adapter}
 */
export async function loadEds() {
    let installed = null;
    try {
        installed = await edsInstalled();
    } catch {
        // No way to tell without importing: try it.
    }
    if (installed === false)
        return {status: 'missing'};
    try {
        const ECal = (await import('gi://ECal?version=2.0')).default;
        const EDataServer = (await import('gi://EDataServer?version=1.2')).default;
        const ICalGLib = (await import('gi://ICalGLib?version=3.0')).default;
        return {status: 'ok', adapter: new EdsAdapter({ECal, EDataServer, ICalGLib})};
    } catch (e) {
        return installed === null ? {status: 'missing'} : {status: 'error', message: e.message};
    }
}

// The source registry, made on the Calendar tab's first use and kept for
// the life of the Shell process, across disable() and enable(). EDS
// (EDataServer 3.56) leaves no safe way to let one go: its dispose runs
// the default main context, so finalized by the garbage collector it
// makes GJS refuse, and drop for good, every JS timeout or idle due then
// (the Shell's and other extensions' too), and disposed by hand it stops
// every other registry of the process from seeing new calendars. While
// Froonty is disabled it holds no handler on it.
// By bindings module (the unit tests' fakes each get their own).
const registries = new WeakMap();

function processRegistry(EDataServer) {
    if (!registries.has(EDataServer)) {
        registries.set(EDataServer, call(
            done => EDataServer.SourceRegistry.new(null, done),
            (_source, result) => EDataServer.SourceRegistry.new_finish(result))
            .catch(e => {
                registries.delete(EDataServer);
                throw e;
            }));
    }
    return registries.get(EDataServer);
}

/**
 * GNOME's calendars and live views of their events.
 *
 * Emits 'calendar-appeared' (info), 'calendar-changed' (info),
 * 'calendar-disappeared' (uid) and 'calendar-error' (uid, message).
 * The calendars are the ones GNOME's own calendar shows (as
 * gnome-shell-calendar-server picks them): enabled, with their account
 * enabled, and selected (ticked in GNOME Calendar or Evolution).
 */
export class EdsAdapter extends Emitter {
    constructor(libs) {
        super();
        this._libs = libs;
        this._registry = null;
        this._watcher = null;
        this._handlers = [];
        this._sources = new Map();
        // uid -> ClientEntry
        this._clients = new Map();
        this._connecting = new Map();
        // One idle for every view's expansion work (scheduler.js).
        this._scheduler = new Scheduler();
        this._stopped = false;
    }

    async start(cancellable) {
        const {EDataServer} = this._libs;
        const registry = await processRegistry(EDataServer);
        if (this._stopped || cancellable?.is_cancelled())
            return;
        this._registry = registry;

        const watcher = EDataServer.SourceRegistryWatcher.new(registry, CALENDAR);
        this._watcher = watcher;
        this._connect(watcher, 'filter', (_watcher, source) =>
            source.has_extension(CALENDAR) && source.get_extension(CALENDAR).get_selected());
        this._connect(watcher, 'appeared', (_watcher, source) => {
            const uid = source.get_uid();
            this._sources.set(uid, source);
            this.emit('calendar-appeared', this.info(source));
        });
        this._connect(watcher, 'disappeared', (_watcher, source) => {
            const uid = source.get_uid();
            this._sources.delete(uid);
            this._dropClient(uid);
            this.emit('calendar-disappeared', uid);
        });
        // A calendar renamed or recoloured.
        this._connect(registry, 'source-changed', (_registry, source) => {
            const uid = source.get_uid();
            if (this._sources.has(uid))
                this.emit('calendar-changed', this.info(this._sources.get(uid)));
        });
        watcher.reclaim();
    }

    stop() {
        this._stopped = true;
        this._scheduler.stop();
        for (const [object, id] of this._handlers)
            object.disconnect(id);
        this._handlers = [];
        for (const uid of [...this._clients.keys()])
            this._dropClient(uid);
        this._connecting.clear();
        this._sources.clear();
        this._watcher = null;
        this._registry = null;
    }

    /**
     * While paused (the tab is not on screen), views keep what EDS sends
     * them and expand nothing.
     */
    setPaused(paused) {
        this._scheduler.setPaused(paused);
    }

    /** For tests and the budget: the open calendar connections. */
    get clientCount() {
        return this._clients.size;
    }

    get registry() {
        return this._registry;
    }

    /** The views' shared expansion scheduler (tests and the budget). */
    get scheduler() {
        return this._scheduler;
    }

    _connect(object, signal, handler) {
        this._handlers.push([object, object.connect(signal, handler)]);
    }

    /**
     * What Froonty shows of a calendar, as plain values: its name and
     * colour, and where it comes from (providers.js).
     */
    info(source) {
        const extension = name => source.has_extension(name) ? source.get_extension(name) : null;
        const calendar = extension(CALENDAR);
        const webdav = extension(WEBDAV);
        const auth = extension(AUTHENTICATION);
        let uri = null;
        try {
            uri = webdav?.dup_uri() ?? null;
        } catch {
            uri = null;
        }
        const collection = this._registry?.find_extension(source, COLLECTION) ?? null;
        const collectionExtension = collection?.has_extension(COLLECTION)
            ? collection.get_extension(COLLECTION) : null;
        return {
            uid: source.get_uid(),
            name: source.get_display_name() ?? '',
            color: calendar?.get_color() ?? null,
            backend: calendar?.get_backend_name() ?? null,
            order: calendar?.get_order?.() ?? 0,
            webdav: uri ? {
                scheme: uri.get_scheme()?.toLowerCase() ?? null,
                host: uri.get_host() ?? null,
                port: uri.get_port(),
                path: uri.get_path() ?? '',
            } : null,
            webdavEmail: webdav?.get_email_address() ?? null,
            authHost: auth?.get_host() ?? null,
            authUser: auth?.get_user() ?? null,
            collectionBackend: collectionExtension?.get_backend_name() ?? null,
            collectionIdentity: collectionExtension?.get_identity() ?? null,
            collectionName: collection?.get_display_name() ?? null,
        };
    }

    /**
     * A live view of a calendar's events in [start, end).
     *
     * @param {string} uid
     * @param {object} range
     * @param {number} range.start seconds
     * @param {number} range.end seconds
     * @param {string} range.tzid the zone of floating times (the clock's)
     * @param {Gio.Cancellable} cancellable
     * @returns {Promise<EdsView>} not started yet
     */
    async openView(uid, {start, end, tzid}, cancellable) {
        const entry = await this._client(uid, cancellable);
        const {ICalGLib} = this._libs;
        const safeTzid = TZID.test(tzid ?? '') ? tzid : 'UTC';
        const zone = ICalGLib.Timezone.get_builtin_timezone(safeTzid) ??
            ICalGLib.Timezone.get_utc_timezone();
        // The same query as GNOME Shell's calendar server.
        const sexp = `(occur-in-time-range? (make-time "${sexpTime(start)}") ` +
            `(make-time "${sexpTime(end)}") "${safeTzid}")`;
        const view = value(await call(
            done => entry.client.get_view(sexp, cancellable, done),
            (client, result) => client.get_view_finish(result)));
        if (cancellable?.is_cancelled())
            throw new GLib.Error(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED, 'Cancelled');
        return new EdsView(this._libs, entry, view, {start, end, zone}, this._scheduler);
    }

    async _client(uid, cancellable) {
        const known = this._clients.get(uid);
        if (known)
            return known;
        const source = this._sources.get(uid);
        if (!source)
            throw new Error('The calendar is gone');
        let connecting = this._connecting.get(uid);
        if (!connecting) {
            const {ECal} = this._libs;
            connecting = call(
                done => ECal.Client.connect(source, ECal.ClientSourceType.EVENTS,
                    DO_NOT_WAIT, cancellable, done),
                (_source, result) => ECal.Client.connect_finish(result));
            this._connecting.set(uid, connecting);
        }
        let client;
        try {
            client = await connecting;
        } finally {
            if (this._connecting.get(uid) === connecting)
                this._connecting.delete(uid);
        }
        if (this._stopped || !this._sources.has(uid))
            throw new Error('The calendar is gone');
        // Another caller may have stored it meanwhile.
        const existing = this._clients.get(uid);
        if (existing)
            return existing;
        const entry = new ClientEntry(this._libs, client);
        entry.diedId = client.connect('backend-died', () => {
            this._dropClient(uid);
            this.emit('calendar-error', uid, 'Evolution Data Server stopped serving this calendar');
        });
        this._clients.set(uid, entry);
        return entry;
    }

    _dropClient(uid) {
        const entry = this._clients.get(uid);
        if (!entry)
            return;
        entry.client.disconnect(entry.diedId);
        entry.close();
        this._clients.delete(uid);
    }
}

/**
 * A calendar connection, and the time zones its views asked it for: the
 * ones libical does not know (Exchange's "Pacific Standard Time"),
 * fetched once per calendar and shared by every view of it, also the
 * views made after the answer came.
 */
export class ClientEntry {
    constructor(libs, client) {
        this._libs = libs;
        this.client = client;
        this.diedId = 0;
        /** tzid → ICalGLib.Timezone, or null when the calendar does not know it. */
        this.zones = new Map();
        // tzid → the views waiting for the answer (one request per zone).
        this._asking = new Map();
        this._cancellable = new Gio.Cancellable();
        this._closed = false;
    }

    /**
     * `view` needs the zone: it hears back through _zoneKnown(tzid) (the
     * answer is in `zones`) or _zoneFailed(tzid) (no answer; ask again
     * when needed).
     */
    wantZone(tzid, view) {
        if (this._closed)
            return;
        if (this.zones.has(tzid)) {
            view._zoneKnown(tzid);
            return;
        }
        const waiting = this._asking.get(tzid);
        if (waiting) {
            waiting.add(view);
            return;
        }
        this._asking.set(tzid, new Set([view]));
        const client = this.client;
        call(done => client.get_timezone(tzid, this._cancellable, done),
            (source, result) => value(source.get_timezone_finish(result)))
            .then(zone => this._answer(tzid, zone ?? null))
            .catch(e => this._answer(tzid, this._notFound(e) ? null : undefined));
    }

    /** A view gone: it waits for nothing any more. */
    forget(view) {
        for (const waiting of this._asking.values())
            waiting.delete(view);
    }

    close() {
        this._closed = true;
        this._cancellable.cancel();
        this._asking.clear();
    }

    // Only "not found" means the calendar does not know the zone; a
    // cancelled or failed request leaves nothing cached.
    _notFound(e) {
        const {ECal} = this._libs;
        return e instanceof GLib.Error && GLib.quark_to_string(e.domain) === ECAL_CLIENT_ERROR &&
            e.code === ECal.ClientError.OBJECT_NOT_FOUND;
    }

    _answer(tzid, zone) {
        const waiting = this._asking.get(tzid);
        this._asking.delete(tzid);
        if (this._closed)
            return;
        if (zone !== undefined)
            this.zones.set(tzid, zone);
        for (const view of waiting ?? []) {
            if (zone === undefined)
                view._zoneFailed(tzid);
            else
                view._zoneKnown(tzid);
        }
    }
}

// The values of a component's properties of one kind.
function properties(component, kind) {
    const out = [];
    for (let property = component.get_first_property(kind); property;
        property = component.get_next_property(kind))
        out.push(property);
    return out;
}


// The rule's BY parts: name → values ('BYDAY' → ['MO', 'WE']).
function byParts(text) {
    const parts = new Map();
    for (const match of text.matchAll(/(?:^|;)(BY[A-Z]+)=([^;]*)/g))
        parts.set(match[1], match[2].split(','));
    return parts;
}

// Per FREQ: seconds per unit (an average month and year for estimates
// only), whether the series' start can be moved (its occurrences repeat
// every INTERVAL units: of wall-clock time for days and weeks, of
// elapsed time for seconds, minutes and hours, as libecal 3.56.2 counts
// them across a daylight saving change), and the BY parts that add
// occurrences within a period; the others only filter (RFC 5545
// §3.3.10).
function frequencies(ICalGLib) {
    const F = ICalGLib.RecurrenceFrequency;
    const time = ['BYSECOND', 'BYMINUTE', 'BYHOUR'];
    return new Map([
        [F.SECONDLY_RECURRENCE, {unit: 1, movable: true, expand: []}],
        [F.MINUTELY_RECURRENCE, {unit: 60, movable: true, expand: time.slice(0, 1)}],
        [F.HOURLY_RECURRENCE, {unit: 3600, movable: true, expand: time.slice(0, 2)}],
        [F.DAILY_RECURRENCE, {unit: 86400, movable: true, expand: time}],
        [F.WEEKLY_RECURRENCE, {unit: 7 * 86400, movable: true, expand: [...time, 'BYDAY']}],
        [F.MONTHLY_RECURRENCE, {unit: 30.44 * 86400, movable: false, expand: [...time, 'BYDAY', 'BYMONTHDAY'],
            weekdays: 4}],
        [F.YEARLY_RECURRENCE, {unit: 365.25 * 86400, movable: false,
            expand: [...time, 'BYDAY', 'BYMONTHDAY', 'BYYEARDAY', 'BYWEEKNO', 'BYMONTH'], weekdays: 52}],
    ]);
}

// Occurrences per period at most, from the expanding BY parts. In a
// monthly or yearly rule a weekday without an ordinal (MO, not 1MO) is
// several days.
function perPeriod(parts, frequency) {
    let n = 1;
    for (const name of frequency.expand) {
        const values = parts.get(name);
        if (!values)
            continue;
        n *= name === 'BYDAY' && frequency.weekdays
            ? values.reduce((sum, day) => sum + (/\d/.test(day) ? 1 : frequency.weekdays), 0)
            : values.length;
    }
    return Math.max(1, n);
}

/**
 * One calendar's events in a range, live. Emits:
 * - 'items' (item[], see model.js): added or changed events;
 * - 'detached' (uid, item[]): every moved or changed occurrence of a
 *   repeating event, replacing the ones known before;
 * - 'removed' (key[]);
 * - 'complete' (error message or null) once the initial events are in.
 *
 * What EDS sends is queued and expanded into occurrences by libecal
 * (RRULE, RDATE, EXDATE) in steps the shared Scheduler runs a few
 * milliseconds per main-loop turn; additions and removals keep their
 * order. A newer version of an event that is still waiting replaces the
 * older one, and a removal drops it, so the queue holds each event once
 * however long the tab stays hidden.
 *
 * libecal walks a series from its first occurrence to the end of the
 * range asked for, and makes every occurrence in that range before
 * handing back the first (measured with libecal 3.56.2: 15–35 ms for a
 * daily series begun in 2016, seconds for a minutely one). So a series
 * that repeats at most weekly, with one rule (no COUNT unless it has no
 * BY parts), is expanded in slices of the range, about SLICE_OCCURRENCES
 * occurrences each, every slice from a copy whose start is moved to its
 * latest occurrence boundary before the slice: the same occurrences from
 * there on, as its INTERVAL counts from the start. An occurrence belongs
 * to the slice it starts in. Other series (monthly, yearly, several
 * rules, a counted rule with BY parts, an RDATE with a period) are
 * expanded in one call, alone in their turn when their walk looks long.
 *
 * An EDS view delivers a repeating event's master, but not its moved
 * occurrences that existed before the view started (verified with EDS
 * 3.56.2's local calendars: a new view never sent them; one that was
 * running got a change only as it happened). So for each repeating
 * event Froonty asks the calendar for all of that event's objects
 * (asynchronous get_objects_for_uid, what libecal's own
 * generate_instances_for_object does synchronously), one event at a
 * time; 'complete' waits for those answers.
 */
export class EdsView extends Emitter {
    constructor(libs, clientEntry, clientView, {start, end, zone}, scheduler) {
        super();
        this._libs = libs;
        this._entry = clientEntry;
        this._clientView = clientView;
        this._scheduler = scheduler;
        this._zone = zone;
        this._start = start;
        this._end = end;
        this._utc = libs.ICalGLib.Timezone.get_utc_timezone();
        this._frequencies = frequencies(libs.ICalGLib);
        this._ids = [];
        // [{kind: 'add', components: Map(key → component)}, {kind:
        // 'remove', keys: Set}, {kind: 'detached', uid, pending, items},
        // {kind: 'complete', message}]
        this._queue = [];
        // key → the 'add' op an event waits in; uid → its keys there.
        this._pendingAdds = new Map();
        this._pendingUids = new Map();
        // The event being expanded, slice by slice.
        this._job = null;
        this._cancellable = new Gio.Cancellable();
        // tzid → Map(key → component): expanded without that zone.
        this._waiting = new Map();
        // Zones asked of the calendar, not answered yet.
        this._asked = new Set();
        // Repeating events whose moved occurrences are to be fetched.
        this._detachedQueue = [];
        this._detachedFetching = false;
        this._heldComplete = undefined;
        this._started = false;
        this._released = false;
        /** libecal calls made, and the longest in microseconds (tests). */
        this.calls = 0;
        this.longestCall = 0;
    }

    /** The EDS view, for tests. */
    get clientView() {
        return this._clientView;
    }

    start() {
        if (this._started || this._released)
            return;
        this._started = true;
        const view = this._clientView;
        this._ids = [
            view.connect('objects-added', (_view, components) => this._added([...components])),
            view.connect('objects-modified', (_view, components) => this._added([...components])),
            view.connect('objects-removed', (_view, ids) =>
                this._removed(ids.map(id => `${id.get_uid()}\n${id.get_rid() ?? ''}`))),
            view.connect('complete', (_view, error) => this._push({kind: 'complete', message: error?.message ?? null})),
        ];
        // The one synchronous D-Bus call (see the top of this file).
        view.start();
    }

    /**
     * Done with this view: nothing is emitted any more. No stop(): the
     * EDS view is let go (see the top of this file).
     */
    release() {
        if (this._released)
            return;
        this._released = true;
        this._cancellable.cancel();
        this._scheduler.forget(this);
        this._entry?.forget(this);
        for (const id of this._ids)
            this._clientView.disconnect(id);
        this._ids = [];
        this._queue = [];
        this._pendingAdds.clear();
        this._pendingUids.clear();
        this._job = null;
        this._waiting.clear();
        this._asked.clear();
        this._detachedQueue = [];
        this._clientView = null;
        this._entry = null;
    }

    get released() {
        return this._released;
    }

    _keyOf(component) {
        const {ECal} = this._libs;
        return `${component.get_uid() ?? ''}\n${ECal.util_component_get_recurid_as_string(component) ?? ''}`;
    }

    _push(op) {
        if (this._released)
            return;
        this._queue.push(op);
        this._scheduler.want(this);
    }

    _added(components) {
        if (this._released || components.length === 0)
            return;
        let op = this._queue.at(-1);
        if (op?.kind !== 'add') {
            op = {kind: 'add', components: new Map()};
            this._queue.push(op);
        }
        for (const component of components) {
            const key = this._keyOf(component);
            this._unpend(key);
            this._unwait(key);
            op.components.set(key, component);
            this._pendingAdds.set(key, op);
            const uid = key.slice(0, key.indexOf('\n'));
            if (!this._pendingUids.has(uid))
                this._pendingUids.set(uid, new Set());
            this._pendingUids.get(uid).add(key);
        }
        this._scheduler.want(this);
    }

    // An event no longer waits in the queue (expanded, replaced or removed).
    _unpend(key) {
        const op = this._pendingAdds.get(key);
        if (!op)
            return;
        op.components.delete(key);
        this._pendingAdds.delete(key);
        const uid = key.slice(0, key.indexOf('\n'));
        const keys = this._pendingUids.get(uid);
        keys?.delete(key);
        if (keys?.size === 0)
            this._pendingUids.delete(uid);
    }

    // A key with an empty recurrence id (a whole series) also covers its
    // moved occurrences (model.js removeKeys).
    _removed(keys) {
        if (this._released)
            return;
        for (const key of keys) {
            const series = key.endsWith('\n');
            const uid = key.slice(0, key.indexOf('\n'));
            for (const pending of series ? [...this._pendingUids.get(uid) ?? []] : [key])
                this._unpend(pending);
            this._unwait(key, series);
        }
        let op = this._queue.at(-1);
        if (op?.kind !== 'remove') {
            op = {kind: 'remove', keys: new Set()};
            this._queue.push(op);
        }
        for (const key of keys)
            op.keys.add(key);
        this._scheduler.want(this);
    }

    _unwait(key, series = false) {
        for (const waiting of this._waiting.values()) {
            for (const known of series ? [...waiting.keys()] : [key]) {
                if (known === key || (series && known.startsWith(key)))
                    waiting.delete(known);
            }
        }
    }

    /**
     * Runs expansion steps while the turn allows (scheduler.js).
     *
     * @returns {boolean} whether work is left
     */
    work(turn) {
        let items = [];
        const flush = () => {
            if (items.length && !this._released)
                this.emit('items', items);
            items = [];
        };
        while (!this._released && !turn.over) {
            if (!this._job && !this._next(flush))
                break;
            const job = this._job;
            if (!job)
                continue;
            if (!turn.step(job.plan.long))
                break;
            this._step(job);
            turn.done(job.plan.long);
            if (!job.done)
                continue;
            this._job = null;
            this._finish(job);
            if (job.op.kind === 'add')
                items.push(job.item);
            else
                job.op.items.push(job.item);
        }
        flush();
        if (this._released)
            return false;
        this._fetchZones();
        this._fetchDetached();
        return this._job !== null || this._queue.length > 0;
    }

    // Takes the next event to expand, or handles the op that comes first.
    // Returns false when the queue is empty.
    _next(flush) {
        const op = this._queue[0];
        if (!op)
            return false;
        if (op.kind === 'add') {
            const first = op.components.entries().next();
            if (first.done) {
                this._queue.shift();
                return true;
            }
            const [key, component] = first.value;
            this._unpend(key);
            this._job = this._newJob(component, key, op);
            return true;
        }
        if (op.kind === 'detached' && op.pending.length) {
            const component = op.pending.shift();
            this._job = this._newJob(component, this._keyOf(component), op);
            return true;
        }
        flush();
        this._queue.shift();
        if (op.kind === 'remove')
            this.emit('removed', [...op.keys]);
        else if (op.kind === 'detached')
            this.emit('detached', op.uid, op.items);
        else
            this._complete(op.message);
        return true;
    }

    // 'complete' once the moved occurrences asked for so far are in.
    _complete(message) {
        if (this._detachedFetching || this._detachedQueue.length)
            this._heldComplete = message;
        else
            this.emit('complete', message);
    }

    _wantDetached(uid) {
        if (!this._detachedQueue.includes(uid))
            this._detachedQueue.push(uid);
    }

    _fetchDetached() {
        if (this._detachedFetching || this._released)
            return;
        const uid = this._detachedQueue.shift();
        if (uid === undefined) {
            if (this._heldComplete !== undefined) {
                const message = this._heldComplete;
                this._heldComplete = undefined;
                // After the moved occurrences queued before it.
                this._push({kind: 'complete', message});
            }
            return;
        }
        this._detachedFetching = true;
        const {ECal} = this._libs;
        const client = this._entry.client;
        call(done => client.get_objects_for_uid(uid, this._cancellable, done),
            (source, result) => value(source.get_objects_for_uid_finish(result)))
            .then(objects => {
                const pending = (objects ?? [])
                    .map(object => object.get_icalcomponent())
                    .filter(component => ECal.util_component_get_recurid_as_string(component));
                this._push({kind: 'detached', uid, pending, items: []});
            })
            .catch(() => {
                // Gone meanwhile, or the calendar failed: the series shows
                // as EDS delivered it.
            })
            .finally(() => {
                this._detachedFetching = false;
                this._fetchDetached();
            });
    }

    // A zone EDS knows but libical does not (Exchange's "Pacific Standard
    // Time"): asked of the calendar once (ClientEntry), then the events
    // that used it are expanded again.
    _fetchZones() {
        for (const tzid of [...this._waiting.keys()]) {
            if (this._released)
                return;
            if (this._asked.has(tzid))
                continue;
            this._asked.add(tzid);
            this._entry.wantZone(tzid, this);
        }
    }

    // From ClientEntry: the zone's answer is in.
    _zoneKnown(tzid) {
        this._asked.delete(tzid);
        const waiting = this._waiting.get(tzid);
        this._waiting.delete(tzid);
        if (this._released || !waiting?.size || !this._entry.zones.get(tzid))
            return;
        this._added([...waiting.values()]);
    }

    // From ClientEntry: no answer. The next expansion that needs the zone
    // asks again; these events keep their floating times meanwhile.
    _zoneFailed(tzid) {
        this._asked.delete(tzid);
        this._waiting.delete(tzid);
    }

    _resolve(tzid, missing) {
        if (!tzid)
            return null;
        const {ICalGLib} = this._libs;
        const builtin = ICalGLib.Timezone.get_builtin_timezone_from_tzid(tzid) ??
            ICalGLib.Timezone.get_builtin_timezone(tzid);
        if (builtin)
            return builtin;
        const zone = this._entry.zones.get(tzid);
        // null: the calendar does not know it either.
        if (zone !== undefined)
            return zone;
        missing.add(tzid);
        return null;
    }

    _epoch(time, missing, tzid = null) {
        const zone = time.get_timezone() ?? (tzid ? this._resolve(tzid, missing) : null);
        return time.as_timet_with_zone(zone ?? this._zone);
    }

    _occurrence(start, end, missing) {
        if (start.is_date()) {
            const date = t => `${String(t.get_year()).padStart(4, '0')}-` +
                `${String(t.get_month()).padStart(2, '0')}-${String(t.get_day()).padStart(2, '0')}`;
            return {
                allDay: true,
                startDate: date(start),
                endDate: date(end),
                rid: this._epoch(start, missing),
            };
        }
        const from = this._epoch(start, missing);
        return {allDay: false, start: from, end: Math.max(from, this._epoch(end, missing)), rid: from};
    }

    _tzidOf(property) {
        const {ICalGLib} = this._libs;
        return property?.get_first_parameter(ICalGLib.ParameterKind.TZID_PARAMETER)?.get_tzid() ?? null;
    }

    _newJob(component, key, op) {
        const {ECal, ICalGLib} = this._libs;
        const uid = component.get_uid() ?? '';
        const recurrenceId = ECal.util_component_get_recurid_as_string(component) ?? '';
        const missing = new Set();
        let rid = null;
        if (recurrenceId) {
            const property = component.get_first_property(ICalGLib.PropertyKind.RECURRENCEID_PROPERTY);
            rid = this._epoch(component.get_recurrenceid(), missing, this._tzidOf(property));
        } else if (ECal.util_component_has_recurrences(component)) {
            this._wantDetached(uid);
        }
        // get_status() throws when there is no STATUS.
        const status = component.get_first_property(ICalGLib.PropertyKind.STATUS_PROPERTY);
        const item = {
            key: `${uid}\n${recurrenceId}`,
            uid,
            rid,
            title: component.get_summary() || null,
            location: component.get_location() || null,
            cancelled: status !== null && component.get_status() === ICalGLib.PropertyStatus.CANCELLED,
            occurrences: [],
        };
        return {component, key, op, item, missing, plan: this._plan(component, missing), index: 0, done: false};
    }

    // How a component is expanded (class comment): `slices` 0 for one
    // libecal call over the range, else that many slices of the range,
    // each from a copy of the series moved to just before it. `long`: one
    // call that walks many occurrences.
    _plan(component, missing) {
        const {ECal, ICalGLib} = this._libs;
        const plain = {slices: 0, long: false};
        if (!ECal.util_component_has_recurrences(component))
            return plain;
        const kinds = ICalGLib.PropertyKind;
        const startProperty = component.get_first_property(kinds.DTSTART_PROPERTY);
        const dtstart = startProperty?.get_dtstart() ?? null;
        if (!dtstart || dtstart.is_null_time())
            return plain;
        const tzid = dtstart.get_timezone() ? null : this._tzidOf(startProperty);
        const first = this._epoch(dtstart, missing, tzid);
        const rules = properties(component, kinds.RRULE_PROPERTY).map(property => property.get_rrule());
        let estimate = 0;
        for (const rule of rules) {
            const frequency = this._frequencies.get(rule.get_freq());
            if (!frequency)
                continue;
            const periods = Math.max(0, this._end - first) / (frequency.unit * Math.max(1, rule.get_interval()));
            const count = rule.get_count();
            const n = (periods + 1) * perPeriod(byParts(rule.to_string()), frequency);
            estimate += count > 0 ? Math.min(n, count) : n;
        }
        const whole = {slices: 0, long: estimate > LONG_OCCURRENCES};
        if (rules.length !== 1 || properties(component, kinds.EXRULE_PROPERTY).length > 0 ||
            properties(component, kinds.RDATE_PROPERTY).some(property => {
                const periodStart = property.get_rdate()?.get_period()?.get_start();
                return periodStart && !periodStart.is_null_time();
            }))
            return whole;
        const rule = rules[0];
        const text = rule.to_string();
        const frequency = this._frequencies.get(rule.get_freq());
        const parts = byParts(text);
        const count = rule.get_count();
        if (!frequency?.movable || /RSCALE|SKIP/.test(text) || (count > 0 && parts.size > 0) ||
            (dtstart.is_date() && frequency.unit < 86400))
            return whole;
        const period = frequency.unit * Math.max(1, rule.get_interval());
        const length = Math.max(1, Math.floor(SLICE_OCCURRENCES * period / perPeriod(parts, frequency)));
        const slices = Math.min(MAX_SLICES, Math.max(1, Math.ceil((this._end - this._start) / length)));
        const elapsed = frequency.unit < 86400;
        return {
            slices,
            long: false,
            component,
            dtstart,
            tzid,
            first,
            period,
            elapsed,
            count,
            duration: Math.max(0, component.get_duration()?.as_int() ?? 0),
            // libical counts seconds, minutes and hours in elapsed time,
            // but an occurrence that falls in the hour a daylight saving
            // change repeats is read as the second one, which moves the
            // rest of the series by an hour (verified with libecal
            // 3.56.2). Only a period that divides an hour lands on the
            // same times after that, and only a UTC series has no such
            // change: otherwise the series is walked to each slice with
            // libical's own iterator, as libecal does.
            walk: elapsed && 3600 % period !== 0 && !dtstart.is_utc()
                ? {rule, iterator: null, last: null, seen: 0, peek: null, ended: false} : null,
        };
    }

    // Slice i's start (i = slices: the range's end).
    _bound(i, slices) {
        return this._start + Math.round(i * (this._end - this._start) / slices);
    }

    // One libecal call: the whole range, or the job's next slice.
    _step(job) {
        const {ECal, ICalGLib} = this._libs;
        const {plan} = job;
        let component = job.component;
        let from = this._start;
        let to = this._end;
        let queryFrom = this._start;
        const first = job.index === 0;
        if (plan.slices) {
            from = this._bound(job.index, plan.slices);
            to = this._bound(job.index + 1, plan.slices);
            // The first slice also takes what started before the range
            // and lasts into it; the others only what starts in them.
            queryFrom = first ? from : from - 1;
            const target = first ? from - plan.duration - FIRST_MARGIN : from - 1;
            if (plan.walk) {
                // Not there yet: the next step walks on.
                if (!this._walk(plan, target, job.missing))
                    return;
                component = this._walked(plan, job.missing);
            } else {
                component = this._moved(plan, target, job.missing);
            }
        }
        job.index++;
        if (component) {
            const started = GLib.get_monotonic_time();
            try {
                ECal.recur_generate_instances_sync(component,
                    ICalGLib.Time.new_from_timet_with_zone(queryFrom, false, this._utc),
                    ICalGLib.Time.new_from_timet_with_zone(to, false, this._utc),
                    (_instance, start, end) => {
                        const occurrence = this._occurrence(start, end, job.missing);
                        if (first || occurrence.rid >= from)
                            job.item.occurrences.push(occurrence);
                        return job.item.occurrences.length < MAX_OCCURRENCES;
                    },
                    tzid => this._resolve(tzid, job.missing),
                    this._zone, null);
            } catch {
                // An event libecal cannot expand is left without occurrences.
            }
            this.calls++;
            this.longestCall = Math.max(this.longestCall, GLib.get_monotonic_time() - started);
        }
        job.done = !plan.slices || job.index >= plan.slices ||
            job.item.occurrences.length >= MAX_OCCURRENCES;
    }

    // `time` (of a property with `tzid`) `seconds` later: of wall-clock
    // time (a date stays a date), or of elapsed time, written as the
    // original was (UTC, or wall-clock time of its TZID or floating).
    _shift(time, tzid, seconds, elapsed, missing) {
        if (elapsed) {
            const {ICalGLib} = this._libs;
            const zone = time.get_timezone() ?? (tzid ? this._resolve(tzid, missing) : null) ?? this._zone;
            const moved = ICalGLib.Time.new_from_timet_with_zone(
                time.as_timet_with_zone(zone) + seconds, false, zone);
            if (!time.get_timezone())
                moved.set_timezone(null);
            return moved;
        }
        const copy = time.clone();
        const days = Math.floor(seconds / 86400);
        copy.adjust(days, 0, 0, seconds - days * 86400);
        return copy;
    }

    // A copy of the series starting at its latest occurrence boundary at
    // or before `target` (seconds): DTSTART (and DTEND) a whole number of
    // INTERVALs later, and a COUNT that many smaller. The series itself
    // when there is nothing to skip; null when a counted series has ended
    // by then.
    _moved(plan, target, missing) {
        const {ICalGLib} = this._libs;
        let skip = Math.floor((target - plan.first) / plan.period);
        let start = null;
        // Days of wall-clock time and of elapsed time differ across a
        // daylight saving change: step back until the copy starts by
        // `target`.
        for (let tries = 0; skip > 0 && tries < 3 && !start; tries++) {
            const candidate = this._shift(plan.dtstart, plan.tzid, skip * plan.period, plan.elapsed, missing);
            const over = this._epoch(candidate, missing, plan.tzid) - target;
            if (over <= 0)
                start = candidate;
            else
                skip -= Math.ceil(over / plan.period);
        }
        if (!start)
            return plan.component;
        if (plan.count > 0 && skip >= plan.count)
            return null;
        const kinds = ICalGLib.PropertyKind;
        const copy = plan.component.clone();
        copy.get_first_property(kinds.DTSTART_PROPERTY).set_dtstart(start);
        const endProperty = copy.get_first_property(kinds.DTEND_PROPERTY);
        if (endProperty) {
            const end = endProperty.get_dtend();
            endProperty.set_dtend(this._shift(end, end.get_timezone() ? null : this._tzidOf(endProperty),
                skip * plan.period, plan.elapsed, missing));
        }
        if (plan.count > 0) {
            const ruleProperty = copy.get_first_property(kinds.RRULE_PROPERTY);
            const rule = ruleProperty.get_rrule();
            rule.set_count(plan.count - skip);
            ruleProperty.set_rrule(rule);
        }
        return copy;
    }

    // Up to WALK_STEPS occurrences further along the series, keeping the
    // last one that starts by `target`. True once past it (or at the end).
    _walk(plan, target, missing) {
        const {ICalGLib} = this._libs;
        const walk = plan.walk;
        if (!walk.iterator) {
            const start = plan.dtstart.clone();
            if (!start.get_timezone())
                start.set_timezone((plan.tzid ? this._resolve(plan.tzid, missing) : null) ?? this._zone);
            walk.iterator = ICalGLib.RecurIterator.new(walk.rule, start);
        }
        for (let steps = 0; steps < WALK_STEPS; steps++) {
            const next = walk.peek ?? walk.iterator.next();
            walk.peek = null;
            if (!next || next.is_null_time()) {
                walk.ended = true;
                return true;
            }
            if (next.as_timet_with_zone(next.get_timezone() ?? this._zone) > target) {
                walk.peek = next;
                return true;
            }
            walk.last = next;
            walk.seen++;
        }
        return walk.ended;
    }

    // A copy of the series starting at the walk's last occurrence; the
    // series itself when the walk is still at its start.
    _walked(plan, missing) {
        const {ICalGLib} = this._libs;
        const walk = plan.walk;
        if (!walk.last || walk.seen <= 1)
            return plan.component;
        const start = walk.last.clone();
        const skipped = start.as_timet_with_zone(start.get_timezone() ?? this._zone) - plan.first;
        if (!plan.dtstart.get_timezone())
            start.set_timezone(null);
        const kinds = ICalGLib.PropertyKind;
        const copy = plan.component.clone();
        copy.get_first_property(kinds.DTSTART_PROPERTY).set_dtstart(start);
        const endProperty = copy.get_first_property(kinds.DTEND_PROPERTY);
        if (endProperty) {
            const end = endProperty.get_dtend();
            endProperty.set_dtend(this._shift(end, end.get_timezone() ? null : this._tzidOf(endProperty),
                skipped, true, missing));
        }
        if (plan.count > 0) {
            const ruleProperty = copy.get_first_property(kinds.RRULE_PROPERTY);
            const rule = ruleProperty.get_rrule();
            rule.set_count(plan.count - (walk.seen - 1));
            ruleProperty.set_rrule(rule);
        }
        return copy;
    }

    // An event expanded without a zone waits for it.
    _finish(job) {
        for (const tzid of job.missing) {
            let waiting = this._waiting.get(tzid);
            if (!waiting) {
                waiting = new Map();
                this._waiting.set(tzid, waiting);
            }
            waiting.set(job.key, job.component);
        }
    }
}
