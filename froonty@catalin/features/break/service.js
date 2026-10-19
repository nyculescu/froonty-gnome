// SPDX-License-Identifier: GPL-3.0-or-later
// The Break tab's service (docs/features/break.md). GNOME's engine times
// the breaks (shell/breakEngine.js); this follows it and adds what GNOME
// does not have: when the user was at the computer or away (ledger.js),
// the urgency and the pill's cue (engine.js), the sit/stand tracker and its
// target (plan.js), and the day's totals and history (store.js).
//
// No polling. Event sources: GNOME's six engine signals, one Mutter idle
// watch (10 s, like GNOME's) and, while idle, one one-shot active watch;
// while a due break waits for a pause in typing, one 2 s idle watch;
// the busy signals (shell/busySignals.js, while "Notice when you are busy"
// is on); Froonty's and GNOME's settings; the top bar's WallClock minute
// tick (only to spot a suspend that did not lock); clicks. Plus at most
// one one-shot timer, armed at the next moment something shown changes by
// itself (engine.nextBoundary: GNOME emits nothing 2 min before a break,
// 60 s or an interval after it, at the long-rest, posture or move-bar
// moments, when a pause or working hours end, at midnight).
//
// Emits 'changed'. No St; unit-tested against GNOME's real BreakManager.

import {Emitter} from '../../core/emitter.js';
import {BREAK_TYPES, IDLE_WATCH_SECONDS} from '../../shell/breakEngine.js';
import {busyState, cueHeld} from './busy.js';
import {
    actionsOf, classify, classifyGap, cueModel, levelOf, nextBoundary, suggested,
} from './engine.js';
import {parseSaved, takeoverStatus} from './gnomeSettings.js';
import {
    AWAY_MIN_SECONDS, LOCAL_DAYS, REASONS, addAway, addPresent, emptyDay, freshState, pushHistory,
    suspendDrift,
} from './ledger.js';
import {
    RETURN_SECONDS, afterRead, coversAway, freshGarmin, intensityOf, shouldRead, todaysActivities, workoutOf,
} from './garminData.js';
import {
    allowPauses, applyHold, applyPause, holdApplied, hoursFrom, pauseApplied, pauseState, pauseWriting,
    restoreHold, restorePause, untilTomorrow,
} from './pause.js';
import {builtTarget, evaluateStep, todayTarget} from './plan.js';

// Froonty's keys the service follows.
const KEYS = [
    'break-pill-cue', 'break-pill-reminders', 'break-escalate-after-skips', 'break-max-delays',
    'break-make-up-time', 'break-long-rest', 'break-long-rest-after-minutes',
    'break-long-rest-minutes', 'break-exercises', 'break-history-days', 'break-gnome-saved',
    'posture-enabled', 'posture-target-minutes', 'posture-buildup', 'posture-buildup-step-minutes',
    'posture-buildup-ceiling-minutes', 'posture-buildup-target', 'posture-reminders',
    'posture-sit-minutes', 'posture-stand-minutes',
    'break-busy', 'break-busy-signals', 'break-busy-grace-minutes', 'break-busy-hold-gnome',
    'break-paused-until', 'break-work-hours', 'break-work-days', 'break-work-start',
    'break-work-end', 'break-work-override-until', 'break-move-goal', 'break-move-after-minutes',
    'break-move-step-minutes', 'break-natural-pause', 'break-natural-pause-max-seconds',
    'break-max-skips', 'break-workout', 'break-garmin',
    // Only the tab shows these: a change redraws it.
    'break-animate', 'break-routines', 'break-eye-exercises', 'break-breathing',
    'break-breathing-pattern', 'break-ideas', 'break-chart', 'break-chart-metric',
    'break-pause-button', 'break-pause-media', 'break-skip-reasons',
];
// A pause in typing this long shows a due break (break-natural-pause).
const NATURAL_PAUSE_MS = 2000;
// Workout days (a heuristic): the workout counts toward the standing
// target up to this; after it the move bar waits this much longer and a
// movement break suggests a walk this long; nothing is eased after this
// much time at the computer.
const WORKOUT_STANDING_CREDIT_SECONDS = 3600;
const WORKOUT_MOVE_FACTOR = 1.5;
const WORKOUT_WALK_SECONDS = 180;
const WORKOUT_LONG_DAY_SECONDS = 10 * 3600;
// "Remind me anyway" with no working hours ahead: this long.
const OVERRIDE_FALLBACK_SECONDS = 12 * 3600;
// The moves not repeated soon.
const RECENT_MOVES = 8;
// _update() runs again after a nested call at most this often.
const MAX_UPDATE_ROUNDS = 5;
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
    s.ledger = pick(saved.ledger, {...s.ledger, idleStart: 0});
    s.ledger.idleStart = num(saved.ledger?.idleStart, null);
    for (const t of BREAK_TYPES)
        s.breaks[t] = pick(saved.breaks?.[t], s.breaks[t]);
    s.posture = pick(saved.posture, s.posture);
    if (!['sitting', 'standing'].includes(s.posture.mode))
        s.posture.mode = 'sitting';
    s.plan = pick(saved.plan, s.plan);
    s.exercise.next = num(saved.exercise?.next, 0);
    s.exercise.idea = num(saved.exercise?.idea, 0);
    s.exercise.recent = Array.isArray(saved.exercise?.recent)
        ? saved.exercise.recent.filter(id => typeof id === 'string').slice(0, RECENT_MOVES) : [];
    s.pauseHandled = typeof saved.pauseHandled === 'string' ? saved.pauseHandled : null;
    s.garmin = pick(saved.garmin, freshGarmin());
    s.garmin.error = typeof saved.garmin?.error === 'string' ? saved.garmin.error : null;
    const away = saved.lastLongAway;
    s.lastLongAway = Number.isFinite(away?.from) && Number.isFinite(away?.to) ? {from: away.from, to: away.to} : null;
    if (typeof saved.today?.day === 'string')
        s.today = restoreDay(saved.today);
    return s;
}

// A saved day over an empty one, field by field (older files lack the
// newer fields).
function restoreDay(saved) {
    const today = emptyDay(saved.day);
    for (const [key, value] of Object.entries(today)) {
        if (Array.isArray(value)) {
            const list = saved[key];
            today[key] = value.map((v, i) => num(Array.isArray(list) ? list[i] : null, v));
        } else if (typeof value === 'number') {
            today[key] = num(saved[key], 0);
        } else if (value && typeof value === 'object') {
            today[key] = pick(saved[key], value);
        }
    }
    today.minimumOnly = Boolean(saved.minimumOnly);
    today.workoutEnd = num(saved.workoutEnd, null);
    today.garmin = Array.isArray(saved.garmin) ? saved.garmin.filter(a =>
        typeof a?.id === 'string' && Number.isFinite(a.start) && Number.isFinite(a.end) &&
        Number.isFinite(a.minutes)).map(({id, type, start, end, minutes}) =>
        ({id, type: typeof type === 'string' ? type : 'other', start, end, minutes})) : [];
    const i = saved.garminIntensity;
    today.garminIntensity = Number.isFinite(i?.moderate) && Number.isFinite(i?.vigorous)
        ? {moderate: i.moderate, vigorous: i.vigorous} : null;
    return today;
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
     * @param {?Function} [deps.busy] () → BusySignals-like {start, stop,
     *   connect, disconnect, active}; null where there are none (tests)
     * @param {?object} [deps.garmin] {read(day) → {promise, cancel}}: the
     *   Garmin helper (garminRun.js); null where there is none (tests)
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
        // Busy (busy.js): the signals while break-busy is on, what they
        // mean now, when the cue's hold last ended, and since when no
        // input counts as present because of them.
        this._busySignals = null;
        this._busyId = 0;
        this._busy = busyState(null, []);
        this._busyEndedAt = null;
        this._busyIdleFrom = null;
        // A due break waiting for a pause in typing: the 2 s idle watch,
        // and each type's due time already shown.
        this._naturalWatch = 0;
        this._released = {};
        this._updating = false;
        this._again = false;
        // A reading of Garmin in flight: {cancel}.
        this._garminRead = null;
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
        this._gnome = this._deps.gnome(() => this._onGnomeChanged());
        const now = this._deps.now();
        this._s = restoreState(saved, now, this._days);
        this._connect();
        this.loaded = true;
        allowPauses();
        this._catchUp(saved, now);
        this._save();
        // What the busy signals say (it updates).
        this._onBusy();
        this.syncGarmin('start');
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
        for (const watch of ['_idleWatch', '_activeWatch', '_naturalWatch']) {
            if (this[watch])
                this._deps.idle.remove(this[watch]);
            this[watch] = 0;
        }
        this._stopBusy();
        this._garminRead?.cancel();
        this._garminRead = null;
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
            naturalWatch: this._naturalWatch !== 0,
            busySignals: this._busySignals !== null,
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
        // A workout day (a heuristic, docs/features/break.md): the target
        // stays at the minimum and the workout counts toward it; after it
        // the move bar waits longer and a movement break is a short walk.
        // Not after a long day at the computer.
        const workout = this._workoutModel(today, nowMs);
        const minimumToday = this._s?.plan.minimumDay === today.day || workout.eased;
        const plan = this._planSettings();
        const targetMinutes = todayTarget(plan, minimumToday);
        const paused = pauseState({
            pausedUntil: s.get_int64('break-paused-until'),
            hours: hoursFrom(s),
            overrideUntil: s.get_int64('break-work-override-until'),
        }, nowMs);
        const busyOn = s.get_boolean('break-busy');
        const grace = s.get_int('break-busy-grace-minutes') * 60;
        const endedAt = this._busyEndedAt === null ? null : this._busyEndedAt / 1000;
        const moveAfter = s.get_int('break-move-after-minutes') * 60;

        // Today as the history will keep it (the chart reads it so).
        today.targetSeconds = s.get_boolean('posture-enabled') ? targetMinutes * 60 : 0;
        today.workoutCreditSeconds = workout.standingCredit;
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
            types,
            breaks: this._s?.breaks ?? freshState(nowMs, this._days).breaks,
            prefs: {
                escalateAfter: s.get_int('break-escalate-after-skips'),
                maxDelays: s.get_int('break-max-delays'),
                maxSkips: s.get_int('break-max-skips'),
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
                standingSeconds: today.standingSeconds + workout.standingCredit,
                workoutCredit: workout.standingCredit,
                targetSeconds: targetMinutes * 60,
                minimumToday,
                minimumChosen: this._s?.plan.minimumDay === today.day,
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
            paused,
            busy: busyOn ? this._busy : busyState(null, []),
            cueHeld: busyOn && cueHeld(this._busy, endedAt, nowMs / 1000, grace),
            busyGraceUntil: busyOn && !this._busy.hold && endedAt !== null && endedAt + grace > nowMs / 1000
                ? endedAt + grace : null,
            naturalWait: this._naturalWait(nowMs, types, read?.lastEnd ?? null),
            move: {
                enabled: s.get_boolean('break-move-goal'),
                sinceMove: (l?.screenSinceMove ?? 0) + extra,
                after: workout.after ? moveAfter * WORKOUT_MOVE_FACTOR : moveAfter,
                step: s.get_int('break-move-step-minutes') * 60,
            },
            workout,
            garmin: {
                enabled: s.get_boolean('break-garmin') && Boolean(this._deps.garmin),
                error: this._s?.garmin.error ?? null,
                lastSync: this._s?.garmin.lastSync ? this._s.garmin.lastSync / 1000 : null,
            },
            features: {
                routines: s.get_boolean('break-routines'),
                animate: s.get_boolean('break-animate'),
                eyeExercises: s.get_boolean('break-eye-exercises'),
                breathing: s.get_boolean('break-breathing'),
                breathingPattern: s.get_string('break-breathing-pattern'),
                ideas: s.get_boolean('break-ideas'),
                chart: s.get_boolean('break-chart'),
                chartMetric: s.get_string('break-chart-metric'),
                pauseButton: s.get_boolean('break-pause-button'),
                pauseMedia: s.get_boolean('break-pause-media'),
                skipReasons: s.get_boolean('break-skip-reasons'),
                workHours: s.get_boolean('break-work-hours'),
            },
            exercise: this._s?.exercise ?? {next: 0, recent: [], idea: 0},
        };
        m.level = levelOf(m);
        m.actions = actionsOf(m);
        m.suggestion = suggested(m, m.level);
        m.cue = this.loaded ? cueModel(m, m.level) : null;
        return m;
    }

    // Today's workouts (break-workout): whether today is eased, the
    // standing credit, whether the last one has ended, and the away the
    // tab asks about.
    _workoutModel(today, nowMs) {
        const on = this._settings.get_boolean('break-workout');
        // Logged by hand, and Garmin's (with break-garmin).
        const w = workoutOf(this._settings.get_boolean('break-garmin') ? today : {...today, garmin: []});
        const minutes = on ? w.minutes : 0;
        const eased = minutes > 0 && today.activeSeconds < WORKOUT_LONG_DAY_SECONDS;
        const away = on ? this._s?.lastLongAway ?? null : null;
        return {
            enabled: on,
            minutes,
            manualMinutes: on ? today.workoutMinutes : 0,
            garmin: on ? w.garmin : [],
            intensity: this._settings.get_boolean('break-garmin') ? today.garminIntensity ?? null : null,
            eased,
            longDay: minutes > 0 && !eased,
            standingCredit: eased ? Math.min(WORKOUT_STANDING_CREDIT_SECONDS, minutes * 60) : 0,
            after: eased && w.end !== null && nowMs >= w.end,
            walkSeconds: WORKOUT_WALK_SECONDS,
            ask: away && this._days.dayKey(away.from) === today.day ? away : null,
        };
    }

    // ------------------------------------------------------------ Garmin

    /**
     * Asks the Garmin helper for today's activities, if break-garmin is on
     * and the rules allow it now (garminData.js shouldRead).
     *
     * @param {string} reason 'start' | 'return' | 'tab' | 'setting'
     */
    syncGarmin(reason) {
        const garmin = this._deps.garmin;
        if (!this.loaded || !garmin || this._garminRead || !this._settings.get_boolean('break-garmin'))
            return;
        const now = this._deps.now();
        if (!shouldRead(this._s.garmin, now, reason))
            return;
        const day = this._s.today.day;
        const generation = this._generation;
        this._s.garmin.lastTry = now;
        const read = garmin.read(day);
        this._garminRead = read;
        read.promise.then(result => {
            if (generation !== this._generation || !this.loaded)
                return;
            this._garminRead = null;
            this._applyGarmin(result, day);
        }).catch(e => {
            if (generation === this._generation)
                this._garminRead = null;
            console.debug(`Froonty: break: Garmin: ${e.message}`);
        });
    }

    _applyGarmin(result, day) {
        const now = this._deps.now();
        this._s.garmin = afterRead(this._s.garmin, result, now);
        if (result?.ok && this._s.today.day === day) {
            const d = this._s.today;
            d.garmin = todaysActivities(result, day, ms => this._days.dayKey(ms));
            d.garminIntensity = intensityOf(result);
            // A long away Garmin recorded as an activity: no question.
            if (coversAway(d.garmin, this._s.lastLongAway))
                this._s.lastLongAway = null;
        }
        this._changed();
    }

    // Due types whose cue waits for a pause in typing: {type: until (s)}.
    // Only while the user types (no idle period, not just watching).
    _naturalWait(nowMs, types, lastEnd) {
        const s = this._settings;
        if (!this.loaded || !lastEnd || !s.get_boolean('break-natural-pause'))
            return {};
        const typing = this._s.ledger.idleStart === null && this._busyIdleFrom === null &&
            this._deps.idle.idleTime() < NATURAL_PAUSE_MS;
        if (!typing)
            return {};
        const max = s.get_int('break-natural-pause-max-seconds');
        const now = nowMs / 1000;
        const wait = {};
        for (const [t, end] of Object.entries(lastEnd)) {
            const due = end + (types[t]?.interval ?? Infinity);
            if (now >= due && now < due + max && this._released[t] !== due)
                wait[t] = due + max;
        }
        return wait;
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
        this._changed();
    }

    /** "Not now": the switch reminder starts its interval again. */
    notNow() {
        if (!this.loaded)
            return;
        this._accountTo(this._deps.now());
        this._s.posture.modeActiveSeconds = 0;
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

    /** The moves a card or routine showed: not picked again soon. */
    markShown(ids) {
        if (!this.loaded || !ids.length)
            return;
        const e = this._s.exercise;
        e.recent = [...ids, ...e.recent.filter(id => !ids.includes(id))].slice(0, RECENT_MOVES);
        this._save();
    }

    nextIdea() {
        if (!this.loaded)
            return;
        this._s.exercise.idea++;
        this._changed();
    }

    // ------------------------------------------------------------ pause

    /**
     * Pauses GNOME's breaks for `minutes`, or until tomorrow ('tomorrow':
     * the next working hours, or 06:00).
     */
    pause(minutes) {
        if (!this.loaded)
            return;
        const nowMs = this._deps.now();
        const until = minutes === 'tomorrow'
            ? untilTomorrow(hoursFrom(this._settings), nowMs)
            : Math.round(nowMs / 1000 + minutes * 60);
        this._settings.set_int64('break-paused-until', until);
    }

    /** Ends a pause now; outside working hours, reminds anyway until they start. */
    resume() {
        if (!this.loaded)
            return;
        const st = this.model().paused;
        this._settings.set_int64('break-paused-until', 0);
        if (st.reason === 'hours' || !st.hours.inside)
            this._remindAnyway(st.hours);
    }

    _remindAnyway(hours) {
        const now = this._deps.now() / 1000;
        this._settings.set_int64('break-work-override-until',
            Math.round(hours.nextStart ?? now + OVERRIDE_FALLBACK_SECONDS));
    }

    // ------------------------------------------------------------ skips

    /** One tap after a skip or delay: why (counted per day). */
    addReason(reason) {
        if (!this.loaded || !REASONS.includes(reason))
            return;
        this._accountTo(this._deps.now());
        this._s.today.reasons[reason]++;
        this._changed();
    }

    // ------------------------------------------------------------ workouts

    /**
     * A workout: `minutes` long, ended at `endMs` (default now). Its time
     * was an away already; this only marks the day (a heuristic).
     */
    logWorkout(minutes, endMs = this._deps.now()) {
        if (!this.loaded || !(minutes > 0))
            return;
        this._accountTo(this._deps.now());
        const d = this._s.today;
        d.workoutMinutes += Math.round(minutes);
        d.workoutEnd = Math.max(d.workoutEnd ?? 0, endMs);
        this._s.lastLongAway = null;
        this._changed();
    }

    /** "Yes" to "Was that a workout?": the last long away. */
    confirmWorkout() {
        const away = this._s?.lastLongAway;
        if (away)
            this.logWorkout((away.to - away.from) / 60000, away.to);
    }

    /** "No", or nothing to ask any more. */
    dismissWorkout() {
        if (!this.loaded || !this._s.lastLongAway)
            return;
        this._s.lastLongAway = null;
        this._changed();
    }

    /** Takes back today's workouts (a mistaken tap). */
    clearWorkout() {
        if (!this.loaded)
            return;
        this._s.today.workoutMinutes = 0;
        this._s.today.workoutEnd = null;
        this._changed();
    }

    /** Deletes the history and zeroes today's totals (posture and plan stay). */
    forgetHistory() {
        if (!this.loaded)
            return;
        this._accountTo(this._deps.now());
        this._s.today = emptyDay(this._s.today.day);
        this._history = [];
        this._store.forgetHistory().catch(e => console.warn(`Froonty: break history: ${e.message}`));
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
        this._ids.settings.push(this._settings.connect('changed::break-busy', () => this._syncBusySignals()));
        // Turned on: asked at once (a sign-in may just have happened).
        this._ids.settings.push(this._settings.connect('changed::break-garmin', () => {
            if (this._settings.get_boolean('break-garmin')) {
                this._s.garmin = freshGarmin();
                this.syncGarmin('setting');
            }
        }));
        for (const key of ['break-busy-signals', 'break-busy-hold-gnome'])
            this._ids.settings.push(this._settings.connect(`changed::${key}`, () => this._onBusy()));
        this._syncBusySignals();
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
                busyPresent: this._busyIdleFrom !== null,
            });
            this._snapshot = after;
            events.forEach(e => this._applyEvent(e));
            if (events.length)
                this._save();
        }
        this._update();
    }

    _onGnomeChanged() {
        if (!this.loaded)
            return;
        // GNOME's breaks turned back on (Settings → Wellbeing) during a
        // pause: the user's choice, the pause is over (said first, so the
        // updates this sets off do not pause again).
        if (!pauseWriting() && pauseApplied(this._settings) && this._gnome.selected().length) {
            const st = this.model().paused;
            if (st.reason === 'hours')
                this._remindAnyway(st.hours);
            else
                this._settings.set_int64('break-paused-until', 0);
            restorePause(this._settings, this._gnome);
        }
        this._update();
    }

    // ------------------------------------------------------------ busy

    // The busy signals exist only while "Notice when you are busy" is on.
    _syncBusySignals() {
        const on = this._settings.get_boolean('break-busy') && this._deps.busy;
        if (on && !this._busySignals) {
            this._busySignals = this._deps.busy();
            this._busyId = this._busySignals.connect('changed', () => this._onBusy());
            this._busySignals.start();
        } else if (!on && this._busySignals) {
            this._stopBusy();
        }
        this._onBusy();
    }

    _stopBusy() {
        if (this._busySignals) {
            this._busySignals.disconnect(this._busyId);
            this._busySignals.stop();
        }
        this._busySignals = null;
        this._busyId = 0;
    }

    // What the signals mean now (busy.js), and the ledger's side of it:
    // busy without input is time at the computer, and an idle period
    // starts when it ends.
    _onBusy() {
        if (!this.loaded)
            return;
        const s = this._settings;
        const was = this._busy;
        const now = this._deps.now();
        this._accountTo(now);
        this._busy = busyState(this._busySignals?.active ?? null, s.get_strv('break-busy-signals'),
            {holdGnome: s.get_boolean('break-busy-hold-gnome')});
        if (was.hold && !this._busy.hold)
            this._busyEndedAt = now;
        else if (this._busy.hold)
            this._busyEndedAt = null;
        const l = this._s.ledger;
        const idle = this._deps.idle.idleTime() >= IDLE_WATCH_SECONDS * 1000;
        if (this._busy.present && l.idleStart !== null) {
            // A call or a video began while away: the away ends here.
            this._endIdle(now);
            this._busyIdleFrom = now;
        } else if (!this._busy.present && this._busyIdleFrom !== null) {
            this._busyIdleFrom = null;
            if (idle) {
                // Still no input: away from now.
                l.idleStart = now;
                this._watchActive();
            }
        } else if (this._busy.present && idle && this._busyIdleFrom === null) {
            this._busyIdleFrom = now;
        }
        this._update();
    }

    // Mutter's idle watch: 10 s without input (as GNOME's own). Busy (a
    // call, a video): still at the computer.
    _onIdle() {
        const l = this._s.ledger;
        if (l.idleStart !== null)
            return;
        const now = this._deps.now();
        const from = now - Math.max(IDLE_WATCH_SECONDS * 1000, this._deps.idle.idleTime());
        if (this._busy.present) {
            this._accountTo(now);
            this._busyIdleFrom ??= from;
        } else {
            l.idleStart = from;
            this._accountTo(now);
        }
        this._watchActive();
        this._update();
    }

    _watchActive() {
        if (!this._activeWatch)
            this._activeWatch = this._deps.idle.addActive(() => this._onActive());
    }

    // The first input after an idle period (a one-shot watch, removed here
    // as GNOME does).
    _onActive() {
        this._deps.idle.remove(this._activeWatch);
        this._activeWatch = 0;
        const now = this._deps.now();
        if (this._busyIdleFrom !== null) {
            this._accountTo(now);
            this._busyIdleFrom = null;
        }
        this._endIdle(now);
        this._update();
    }

    // An idle period ends at `now`: a reading pause, or an away.
    _endIdle(now) {
        const l = this._s.ledger;
        const start = l.idleStart;
        if (start === null)
            return;
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
        // Back from long enough to have worked out: ask Garmin.
        if (length >= RETURN_SECONDS)
            this.syncGarmin('return');
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
            b.skipsInRow = 0;
            b.owed = Math.max(0, b.owed - Math.max(0, (e.length ?? 0) - duration));
            if (e.type === 'movement')
                this._s.exercise.next++;
        } else if (e.kind === 'skip') {
            day.skipped++;
            b.consecutive++;
            b.delaysInRow = 0;
            b.skipsInRow++;
            if (e.type === 'movement' && this._settings.get_boolean('break-make-up-time'))
                b.owed = Math.min(duration, b.owed + duration);
        } else if (e.kind === 'delay') {
            day.delayed++;
            b.consecutive++;
            b.delaysInRow++;
        } else if (e.kind === 'busy') {
            // Credited by GNOME during a call or a video: not a break.
            day.busy++;
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
        // Busy without input (a call, a video): at the computer till now.
        if (this._busyIdleFrom !== null)
            return now;
        return now - Math.max(0, this._deps.idle.idleTime());
    }

    // Present time up to `now` (see _presentUntil); the day moves on at
    // midnight.
    _accountTo(now) {
        const s = this._s;
        const until = this._presentUntil(now);
        const busyFrom = this._busyIdleFrom === null ? Infinity : Math.max(this._busyIdleFrom, s.ledger.accountedUntil);
        const closed = until > s.ledger.accountedUntil ? addPresent(s, until, this._days) : [];
        if (until > busyFrom)
            s.today.busySeconds += (until - busyFrom) / 1000;
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
            const workout = this._workoutModel(day, Infinity);
            day.minimumOnly = this._s.plan.minimumDay === day.day || workout.eased;
            day.targetSeconds = posture ? todayTarget(this._planSettings(), day.minimumOnly) * 60 : 0;
            day.workoutCreditSeconds = workout.standingCredit;
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

    // Accounts, ends or applies a pause, holds GNOME while busy, waits for
    // a pause in typing, re-arms the one timer, and tells the tab and the
    // pill. GSettings and GNOME's engine call back synchronously: a call
    // from inside runs the whole update once more afterwards, not nested.
    _update() {
        if (!this.loaded)
            return;
        if (this._updating) {
            this._again = true;
            return;
        }
        this._updating = true;
        try {
            for (let round = 0; round < MAX_UPDATE_ROUNDS && this.loaded; round++) {
                this._again = false;
                this._updateOnce();
                if (!this._again)
                    break;
            }
        } finally {
            this._updating = false;
        }
    }

    _updateOnce() {
        const now = this._deps.now();
        this._accountTo(now);
        this._syncPause(now);
        const m = this.model(now);
        this._syncHold(m);
        this._syncNatural(m);
        this._disarm();
        const next = nextBoundary(m);
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

    // Paused (or outside working hours): GNOME's breaks off, once per
    // pause (breaks the user turns back on meanwhile stay on); over:
    // given back. An expired pause key is cleared.
    _syncPause(now) {
        const s = this._settings;
        if (!this._gnome?.available)
            return;
        const st = pauseState({
            pausedUntil: s.get_int64('break-paused-until'),
            hours: hoursFrom(s),
            overrideUntil: s.get_int64('break-work-override-until'),
        }, now);
        const key = st.paused ? `${st.reason}:${st.until}` : null;
        if (key !== this._s.pauseHandled && (!key || applyPause(s, this._gnome))) {
            this._s.pauseHandled = key;
            this._save();
        }
        if (!st.paused && pauseApplied(s))
            restorePause(s, this._gnome);
        for (const key of ['break-paused-until', 'break-work-override-until']) {
            const until = s.get_int64(key);
            if (until > 0 && until <= now / 1000)
                s.set_int64(key, 0);
        }
    }

    // Busy (a call, a screen share, a full-screen video): GNOME's dimming
    // and locking off meanwhile (break-busy-hold-gnome), given back after.
    // GNOME dims or locks as soon as its state changes, before any handler
    // of Froonty's could delay the break, so its own settings are held.
    _syncHold(m) {
        if (!this._gnome?.available)
            return;
        if (m.busy.gnome)
            applyHold(this._settings, this._gnome);
        else if (holdApplied(this._settings))
            restoreHold(this._settings, this._gnome);
    }

    // A due break shown only at a pause in typing: due types not waiting
    // are shown from now on; while some wait, a 2 s idle watch.
    _syncNatural(m) {
        const wait = m.naturalWait;
        for (const [t, end] of Object.entries(m.lastEnd ?? {})) {
            const due = end + (m.types[t]?.interval ?? Infinity);
            if (due <= m.now && !(t in wait))
                this._released[t] = due;
        }
        const waiting = Object.keys(wait).length > 0;
        if (waiting && !this._naturalWatch) {
            this._naturalWatch = this._deps.idle.addIdle(NATURAL_PAUSE_MS, () => this._onNaturalPause());
        } else if (!waiting && this._naturalWatch) {
            this._deps.idle.remove(this._naturalWatch);
            this._naturalWatch = 0;
        }
    }

    // The pause in typing: what waited is shown.
    _onNaturalPause() {
        this._deps.idle.remove(this._naturalWatch);
        this._naturalWatch = 0;
        if (!this.loaded)
            return;
        const m = this.model();
        for (const [t, until] of Object.entries(m.naturalWait))
            this._released[t] = until - this._settings.get_int('break-natural-pause-max-seconds');
        this._update();
    }
}
