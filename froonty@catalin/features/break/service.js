// SPDX-License-Identifier: GPL-3.0-or-later
// The Break tab's service (docs/features/break.md). GNOME's engine times
// the breaks (shell/breakEngine.js); this follows it and adds what GNOME
// does not have: when the user was at the computer or away (ledger.js),
// the urgency and the pill's cue (engine.js), the sit/stand tracker and its
// target (plan.js), and the day's totals and history (store.js).
//
// No polling. Event sources: GNOME's six engine signals, one Mutter idle
// watch (10 s, like GNOME's) and, while idle, one one-shot active watch;
// Froonty's and GNOME's settings; the top bar's WallClock minute tick (only
// to spot a suspend that did not lock); clicks. Plus at most one one-shot
// timer, armed at the next moment something shown changes by itself
// (engine.nextBoundary: GNOME emits nothing 2 min before a break, 60 s or
// an interval after it, at the long-rest or posture moments, at midnight).
//
// Emits 'changed'. No St; unit-tested against GNOME's real BreakManager.

import {Emitter} from '../../core/emitter.js';
import {BREAK_TYPES, IDLE_WATCH_SECONDS} from '../../shell/breakEngine.js';
import {
    actionsOf, classify, classifyGap, cueModel, levelOf, nextBoundary, suggested,
} from './engine.js';
import {parseSaved, takeoverStatus} from './gnomeSettings.js';
import {
    AWAY_MIN_SECONDS, LOCAL_DAYS, addAway, addPresent, emptyDay, freshState, pushHistory,
    suspendDrift,
} from './ledger.js';
import {builtTarget, evaluateStep, todayTarget} from './plan.js';

// Froonty's keys the service follows.
const KEYS = [
    'break-pill-cue', 'break-pill-reminders', 'break-escalate-after-skips', 'break-max-delays',
    'break-make-up-time', 'break-long-rest', 'break-long-rest-after-minutes',
    'break-long-rest-minutes', 'break-exercises', 'break-history-days', 'break-gnome-saved',
    'posture-enabled', 'posture-target-minutes', 'posture-buildup', 'posture-buildup-step-minutes',
    'posture-buildup-ceiling-minutes', 'posture-buildup-target', 'posture-reminders',
    'posture-sit-minutes', 'posture-stand-minutes',
];
// A stretch at the screen ends with an away this long when GNOME's
// movement breaks are off (GNOME's default movement break).
const DEFAULT_MOVEMENT_SECONDS = 300;
// GNOME's active watch and Froonty's fire in either order: a return is
// "now" within this.
const RETURN_TOLERANCE_MS = 2000;

const num = (value, fallback) => (Number.isFinite(value) ? value : fallback);
const pick = (from, defaults) => Object.fromEntries(Object.entries(defaults).map(
    ([key, value]) => [key, typeof value === 'number' ? num(from?.[key], value)
        : from?.[key] === undefined ? value : from[key]]));

// The saved state over a fresh one, field by field: an older or damaged
// file never leaves a hole.
function restoreState(saved, now, days) {
    const s = freshState(now, days);
    if (!saved)
        return s;
    s.ledger = pick(saved.ledger, {...s.ledger, lastLongRestEnd: 0, idleStart: 0});
    s.ledger.lastLongRestEnd = num(saved.ledger?.lastLongRestEnd, null);
    s.ledger.idleStart = num(saved.ledger?.idleStart, null);
    for (const t of BREAK_TYPES)
        s.breaks[t] = pick(saved.breaks?.[t], s.breaks[t]);
    s.posture = pick(saved.posture, s.posture);
    if (!['sitting', 'standing'].includes(s.posture.mode))
        s.posture.mode = 'sitting';
    s.plan = pick(saved.plan, s.plan);
    s.exercise.next = num(saved.exercise?.next, 0);
    if (typeof saved.today?.day === 'string') {
        const today = emptyDay(saved.today.day);
        for (const [key, value] of Object.entries(today)) {
            if (typeof value === 'number')
                today[key] = num(saved.today[key], 0);
            else if (typeof value === 'object')
                today[key] = pick(saved.today[key], value);
        }
        today.minimumOnly = Boolean(saved.today.minimumOnly);
        s.today = today;
    }
    return s;
}

export class BreakService extends Emitter {
    /**
     * @param {Gio.Settings} settings Froonty's
     * @param {object} deps (features/break/shared.js wires the real ones)
     * @param {BreakEngine} deps.engine
     * @param {Function} deps.gnome (onChanged) → GnomeBreakSettings
     * @param {object} deps.idle {addIdle(ms, cb), addActive(cb), remove(id), idleTime()}
     * @param {?object} deps.wallClock the top bar's WallClock (connect/disconnect)
     * @param {object} deps.timer {add(seconds, cb), remove(id)}
     * @param {Function} deps.now wall-clock ms
     * @param {Function} deps.mono monotonic µs
     * @param {BreakStore} deps.store
     * @param {number} deps.pid this Shell's process id
     * @param {object} [deps.days] dayKey/nextMidnight (ledger.js)
     */
    constructor(settings, deps) {
        super();
        this._settings = settings;
        this._deps = deps;
        this._engine = deps.engine;
        this._days = deps.days ?? LOCAL_DAYS;
        this._store = deps.store;
        this._gnome = null;
        this._s = null;
        this._history = [];
        this._snapshot = null;
        this._lastReturn = null;
        this._lastTick = null;
        this._generation = 0;
        this._started = false;
        this._ids = {settings: [], engine: 0, wallClock: 0};
        this._idleWatch = 0;
        this._activeWatch = 0;
        this._timer = 0;
        /** Whether the state file has been read (nothing is saved before). */
        this.loaded = false;
        /** The last break event (for tests): {type, kind, source}. */
        this.lastEvent = null;
    }

    /** Reads the files, then follows GNOME and the user. */
    async start() {
        if (this._started)
            return;
        this._started = true;
        const generation = ++this._generation;
        let saved = null;
        let history = [];
        try {
            [saved, history] = await Promise.all([this._store.loadState(), this._store.loadHistory()]);
        } catch (e) {
            console.warn(`Froonty: break state: ${e.message}`);
        }
        // Stopped (a screen lock) while reading: nothing to follow.
        if (generation !== this._generation)
            return;
        this._history = history;
        this._gnome = this._deps.gnome(key => this._onGnomeChanged(key));
        const now = this._deps.now();
        this._s = restoreState(saved, now, this._days);
        this._connect();
        this.loaded = true;
        this._catchUp(saved, now);
        this._save();
        this._update();
    }

    stop() {
        this._generation++;
        if (!this._started)
            return;
        this._started = false;
        if (this.loaded) {
            this._accountTo(this._deps.now());
            this._save();
        }
        for (const id of this._ids.settings)
            this._settings.disconnect(id);
        this._ids.settings = [];
        if (this._ids.engine)
            this._engine.disconnect(this._ids.engine);
        this._ids.engine = 0;
        this._engine.stop();
        if (this._ids.wallClock)
            this._deps.wallClock.disconnect(this._ids.wallClock);
        this._ids.wallClock = 0;
        for (const watch of ['_idleWatch', '_activeWatch']) {
            if (this[watch])
                this._deps.idle.remove(this[watch]);
            this[watch] = 0;
        }
        this._disarm();
        this._gnome?.destroy();
        this._gnome = null;
        this.loaded = false;
    }

    /** What is connected or armed (for tests and the resource budget). */
    get resources() {
        return {
            idleWatch: this._idleWatch !== 0,
            activeWatch: this._activeWatch !== 0,
            boundaryTimer: this._timer !== 0,
            wallClock: this._ids.wallClock !== 0,
            engineSignals: this._engine.connected,
        };
    }

    get history() {
        return this._history;
    }

    /** The state as saved (for tests). */
    get state() {
        return this._s;
    }

    // ------------------------------------------------------------ model

    /**
     * Everything the tab and the pill show, at `nowMs`, with the present
     * time not yet accounted added on (nothing is changed).
     */
    model(nowMs = this._deps.now()) {
        const s = this._settings;
        const g = this._gnome;
        const read = g && this._engine.available ? this._engine.read() : null;
        const types = {};
        for (const t of BREAK_TYPES) {
            const type = g?.type(t);
            if (type)
                types[t] = type;
        }
        const l = this._s?.ledger;
        const extra = l ? Math.max(0, (this._presentUntil(nowMs) - l.accountedUntil) / 1000) : 0;
        const standing = this._s?.posture.mode === 'standing';
        const today = this._s ? {...this._s.today} : emptyDay(this._days.dayKey(nowMs));
        today.activeSeconds += extra;
        if (standing)
            today.standingSeconds += extra;
        const minimumToday = this._s?.plan.minimumDay === today.day;
        const plan = this._planSettings();
        const targetMinutes = todayTarget(plan, minimumToday);

        const m = {
            loaded: this.loaded,
            available: Boolean(read) && Boolean(g?.available),
            selected: g?.selected() ?? [],
            selectedWritable: g?.selectedWritable() ?? false,
            fallback: Boolean(read) && read.lastEnd === null,
            now: nowMs / 1000,
            state: read?.state ?? 0,
            lastEnd: read?.lastEnd ?? null,
            nextDue: read?.nextDue ?? 0,
            nextType: read?.nextType ?? null,
            currentType: read?.currentType ?? null,
            types,
            breaks: this._s?.breaks ?? freshState(nowMs, this._days).breaks,
            prefs: {
                escalateAfter: s.get_int('break-escalate-after-skips'),
                maxDelays: s.get_int('break-max-delays'),
                makeUp: s.get_boolean('break-make-up-time'),
                longRest: s.get_boolean('break-long-rest'),
                longRestAfter: s.get_int('break-long-rest-after-minutes') * 60,
                longRestLength: s.get_int('break-long-rest-minutes') * 60,
            },
            screenSinceLongRest: (l?.screenSinceLongRest ?? 0) + extra,
            present: !l || l.idleStart === null,
            posture: {
                enabled: s.get_boolean('posture-enabled'),
                reminders: s.get_boolean('posture-reminders'),
                mode: this._s?.posture.mode ?? 'sitting',
                modeActiveSeconds: (this._s?.posture.modeActiveSeconds ?? 0) + extra,
                sitAfter: s.get_int('posture-sit-minutes') * 60,
                standAfter: s.get_int('posture-stand-minutes') * 60,
                standingSeconds: today.standingSeconds,
                targetSeconds: targetMinutes * 60,
                targetMinutes,
                minimumToday,
                plan,
                building: plan.buildup && !minimumToday && builtTarget(plan) > plan.base,
            },
            cueMode: s.get_string('break-pill-cue'),
            pillReminders: s.get_boolean('break-pill-reminders'),
            exercises: s.get_boolean('break-exercises'),
            exerciseNext: this._s?.exercise.next ?? 0,
            takeover: g ? takeoverStatus(parseSaved(s.get_string('break-gnome-saved')), g)
                : {state: 'gnome', dailyLimitHidden: false},
            today,
            midnight: this._days.nextMidnight(nowMs) / 1000,
        };
        m.level = levelOf(m);
        m.actions = actionsOf(m);
        m.suggestion = suggested(m, m.level);
        m.cue = this.loaded ? cueModel(m, m.level) : null;
        return m;
    }

    _planSettings() {
        const s = this._settings;
        return {
            base: s.get_int('posture-target-minutes'),
            buildup: s.get_boolean('posture-buildup'),
            step: s.get_int('posture-buildup-step-minutes'),
            ceiling: s.get_int('posture-buildup-ceiling-minutes'),
            built: s.get_int('posture-buildup-target'),
        };
    }

    // ------------------------------------------------------------ actions

    /** Asks GNOME to dim or lock (only while a break is due). */
    take() {
        if (this.loaded && this.model().actions.take)
            this._engine.take();
    }

    delay() {
        if (this.loaded && this.model().actions.delay)
            this._engine.delay();
    }

    skip() {
        if (this.loaded && this.model().actions.skip)
            this._engine.skip();
    }

    /** The tab's offer: turns on GNOME's eye and movement breaks. */
    turnOnGnomeBreaks() {
        this._gnome?.selectAll();
    }

    setPosture(mode) {
        if (!this.loaded || !['sitting', 'standing'].includes(mode))
            return;
        this._accountTo(this._deps.now());
        const p = this._s.posture;
        if (p.mode !== mode) {
            p.mode = mode;
            p.modeActiveSeconds = 0;
        }
        p.notNowAt = null;
        this._changed();
    }

    /** "Not now": the switch reminder starts its interval again. */
    notNow() {
        if (!this.loaded)
            return;
        const now = this._deps.now();
        this._accountTo(now);
        this._s.posture.modeActiveSeconds = 0;
        this._s.posture.notNowAt = now;
        this._changed();
    }

    /** "Just the minimum today": today's target is the base, whatever the build-up. */
    setMinimumToday(on) {
        if (!this.loaded)
            return;
        this._accountTo(this._deps.now());
        this._s.plan.minimumDay = on ? this._s.today.day : null;
        this._changed();
    }

    nextExercise() {
        if (!this.loaded)
            return;
        this._s.exercise.next++;
        this._changed();
    }

    /** Deletes the history and zeroes today's totals (posture and plan stay). */
    forgetHistory() {
        if (!this.loaded)
            return;
        this._accountTo(this._deps.now());
        this._history = [];
        this._store.forgetHistory().catch(e => console.warn(`Froonty: break history: ${e.message}`));
        this._s.today = emptyDay(this._s.today.day);
        this._changed();
    }

    // ------------------------------------------------------------ events

    _connect() {
        this._ids.settings = KEYS.map(key =>
            this._settings.connect(`changed::${key}`, () => this._update()));
        this._engine.start();
        this._ids.engine = this._engine.connect('changed', (_e, signal) => this._onEngine(signal));
        this._snapshot = this._engine.available ? this._engine.read().lastEnd : null;
        this._idleWatch = this._deps.idle.addIdle(IDLE_WATCH_SECONDS * 1000, () => this._onIdle());
        const wallClock = this._deps.wallClock;
        if (wallClock) {
            this._ids.wallClock = wallClock.connect('notify::clock', () => this._onTick());
            this._lastTick = {wall: this._deps.now(), mono: this._deps.mono()};
        }
    }

    // A gap since the state was saved (a lock, Froonty off, a logout) was
    // away. In the same Shell process GNOME kept counting, so breaks it
    // credited meanwhile are counted too.
    _catchUp(saved, now) {
        const savedAt = num(saved?.savedAt, null);
        if (savedAt === null || savedAt > now)
            return;
        const from = Math.min(savedAt, this._s.ledger.idleStart ?? savedAt);
        this._s.ledger.idleStart = null;
        this._closeDays(addAway(this._s, from, now, this._awayRules(), this._days));
        if (saved.pid === this._deps.pid && this._engine.available) {
            const events = classifyGap(saved.gnome?.lastEnd ?? null, this._snapshot, {
                savedAt: savedAt / 1000,
                idleStart: from / 1000,
                now: now / 1000,
                types: this.model(now).types,
            });
            events.forEach(e => this._applyEvent(e));
        }
    }

    _onEngine(signal) {
        if (!this.loaded)
            return;
        const now = this._deps.now();
        this._accountTo(now);
        if (signal.startsWith('notify::') && this._engine.available) {
            const after = this._engine.read().lastEnd;
            const events = classify(this._snapshot, after, {
                now: now / 1000,
                ownAction: this._engine.ownAction,
                types: this.model(now).types,
                returnLength: this._returnLength(now),
            });
            this._snapshot = after;
            events.forEach(e => this._applyEvent(e));
            if (events.length)
                this._save();
        }
        this._update();
    }

    _onGnomeChanged() {
        if (this.loaded)
            this._update();
    }

    // Mutter's idle watch: 10 s without input (as GNOME's own).
    _onIdle() {
        const l = this._s.ledger;
        if (l.idleStart !== null)
            return;
        const now = this._deps.now();
        l.idleStart = now - Math.max(IDLE_WATCH_SECONDS * 1000, this._deps.idle.idleTime());
        this._accountTo(now);
        if (!this._activeWatch)
            this._activeWatch = this._deps.idle.addActive(() => this._onActive());
        this._update();
    }

    // The first input after an idle period (a one-shot watch, removed here
    // as GNOME does).
    _onActive() {
        this._deps.idle.remove(this._activeWatch);
        this._activeWatch = 0;
        const l = this._s.ledger;
        const start = l.idleStart;
        if (start === null)
            return;
        const now = this._deps.now();
        const length = (now - start) / 1000;
        this._lastReturn = {at: now, length};
        l.idleStart = null;
        if (length < AWAY_MIN_SECONDS) {
            // A reading pause: still at the computer.
            this._accountTo(now);
        } else {
            this._closeDays(addAway(this._s, start, now, this._awayRules(), this._days));
            this._save();
        }
        this._update();
    }

    // The top bar's minute tick: a wall-clock step larger than the
    // monotonic one was a suspend (without a lock; with one, the lock gap
    // already counts). An idle period already open covers it.
    _onTick() {
        const wall = this._deps.now();
        const mono = this._deps.mono();
        const last = this._lastTick;
        this._lastTick = {wall, mono};
        const drift = last ? suspendDrift(wall - last.wall, mono - last.mono) : null;
        if (drift !== null && this._s.ledger.idleStart === null) {
            this._closeDays(addAway(this._s, wall - drift * 1000, wall, this._awayRules(), this._days));
            this._save();
        }
        this._update();
    }

    // The length of the idle period ending right now, if one is: Mutter
    // runs GNOME's and Froonty's active watches in either order.
    _returnLength(now) {
        const l = this._s.ledger;
        if (l.idleStart !== null && this._deps.idle.idleTime() < 1000)
            return (now - l.idleStart) / 1000;
        if (this._lastReturn && Math.abs(now - this._lastReturn.at) <= RETURN_TOLERANCE_MS)
            return this._lastReturn.length;
        return null;
    }

    _applyEvent(e) {
        const b = this._s.breaks[e.type];
        const day = this._s.today[e.type];
        const duration = this._gnome?.type(e.type)?.duration ?? 0;
        if (e.kind === 'taken') {
            day.taken++;
            b.consecutive = 0;
            b.delaysInRow = 0;
            b.owed = Math.max(0, b.owed - Math.max(0, (e.length ?? 0) - duration));
            if (e.type === 'movement')
                this._s.exercise.next++;
        } else if (e.kind === 'skip') {
            day.skipped++;
            b.consecutive++;
            b.delaysInRow = 0;
            if (e.type === 'movement' && this._settings.get_boolean('break-make-up-time'))
                b.owed = Math.min(duration, b.owed + duration);
        } else if (e.kind === 'delay') {
            day.delayed++;
            b.consecutive++;
            b.delaysInRow++;
        }
        this.lastEvent = e;
    }

    _awayRules() {
        const movement = this._gnome?.selected().includes('movement')
            ? this._gnome.type('movement')?.duration : null;
        return {
            movementSeconds: movement ?? DEFAULT_MOVEMENT_SECONDS,
            longRestSeconds: this._settings.get_int('break-long-rest-minutes') * 60,
        };
    }

    // Present time ends at the last input: a pause going on is counted when
    // it ends (at the computer if short, away if not), and GNOME's idle
    // watch may fire just before Froonty's.
    _presentUntil(now) {
        const idleStart = this._s.ledger.idleStart;
        if (idleStart !== null)
            return Math.min(now, idleStart);
        return now - Math.max(0, this._deps.idle.idleTime());
    }

    // Present time up to `now` (see _presentUntil); the day moves on at
    // midnight.
    _accountTo(now) {
        const s = this._s;
        const until = this._presentUntil(now);
        const closed = until > s.ledger.accountedUntil ? addPresent(s, until, this._days) : [];
        if (this._days.dayKey(now) !== s.today.day) {
            closed.push(s.today);
            s.today = emptyDay(this._days.dayKey(now));
        }
        this._closeDays(closed);
    }

    // Days that ended: into the history (if anything happened), and the
    // build-up looks at them.
    _closeDays(closed) {
        if (!closed.length)
            return;
        const keep = this._settings.get_int('break-history-days');
        const posture = this._settings.get_boolean('posture-enabled');
        for (const day of closed) {
            day.minimumOnly = this._s.plan.minimumDay === day.day;
            day.targetSeconds = posture ? todayTarget(this._planSettings(), day.minimumOnly) * 60 : 0;
            this._history = pushHistory(this._history, day, keep);
            const step = evaluateStep(this._planSettings(), this._history,
                this._s.plan.lastStepDay, this._s.today.day);
            if (step && posture) {
                this._s.plan.lastStepDay = step.lastStepDay;
                this._settings.set_int('posture-buildup-target', step.built);
            }
        }
        this._store.saveHistory(this._history)
            .catch(e => console.warn(`Froonty: break history: ${e.message}`));
        this._save();
    }

    _changed() {
        this._save();
        this._update();
    }

    _save() {
        if (!this.loaded)
            return;
        const state = {savedAt: this._deps.now(), pid: this._deps.pid,
            gnome: {lastEnd: this._snapshot}, ...this._s};
        this._store.saveState(state).catch(e => console.warn(`Froonty: break state: ${e.message}`));
    }

    // Accounts, re-arms the one timer, and tells the tab and the pill.
    _update() {
        if (!this.loaded)
            return;
        const now = this._deps.now();
        this._accountTo(now);
        this._disarm();
        const next = nextBoundary(this.model(now));
        if (next !== null) {
            // Whole seconds (GLib may batch it), and a little late rather
            // than early.
            const seconds = Math.max(1, Math.ceil(next - now / 1000 + 0.25));
            this._timer = this._deps.timer.add(seconds, () => {
                this._timer = 0;
                this._update();
            });
        }
        this.emit('changed');
    }

    _disarm() {
        if (this._timer)
            this._deps.timer.remove(this._timer);
        this._timer = 0;
    }
}
