// SPDX-License-Identifier: GPL-3.0-or-later
// Break tab (docs/features/break.md): urgency and GNOME's actions, why a
// cue is held or breaks are paused, the next breaks and the move bar,
// exercises (a card, a guided routine, eye and breathing exercises drawn
// by Froonty, a break idea), the sit/stand tracker, and today's totals
// with a 14-week chart, in one scrolled column. Actors are made once and
// updated in place; only the exercise box, the chart's data and the
// history rows are rebuilt, when they change.
//
// Every line comes from the service's model (service.js) and words.js.
// "Take now" collapses the island (GNOME dims it too); the rest keep it open.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {gettext as _, ngettext} from 'resource:///org/gnome/shell/extensions/extension.js';

import {levelCells, LEVEL_GLYPHS} from '../sysmon/level.js';
import {appName} from './busy.js';
import {ExerciseCard} from './card.js';
import {HistoryChart, METRICS, cellText, chartCells} from './chart.js';
import {DESK_HOUR_SECONDS} from './chartData.js';
import {LEVEL, MOVE_SEGMENTS, moveSegments} from './engine.js';
import {loadCatalog} from './exercises.js';
import {subjectIcon} from './icons.js';
import {loadIdeas, pickIdea} from './ideas.js';
import {REASONS} from './ledger.js';
import {MediaHold} from './mediaHold.js';
import {met} from './plan.js';
import {RoutinePlayer} from './routine.js';
import {nextMove, routine, routineSeconds} from './routines.js';
import {words} from './words.js';

const HISTORY_ROWS = 7;
const PAUSES = [30, 60, 120, 'tomorrow'];
const WORKOUT_MINUTES = [30, 45, 60, 90];
// Busy signals that mean others may see you: only discreet moves then.
const SEEN = ['microphone', 'screen-share'];

function label(styleClass = '', {wrap = false, expand = false} = {}) {
    const actor = new St.Label({style_class: styleClass, x_expand: expand || wrap,
        y_align: Clutter.ActorAlign.CENTER});
    if (wrap) {
        actor.clutter_text.set({
            line_wrap: true,
            line_wrap_mode: Pango.WrapMode.WORD_CHAR,
            ellipsize: Pango.EllipsizeMode.NONE,
        });
    }
    return actor;
}

function button(text, onClick, {styleClass = 'froonty-break-action', toggle = false} = {}) {
    const actor = new St.Button({
        style_class: styleClass,
        label: text,
        can_focus: true,
        track_hover: true,
        toggle_mode: toggle,
        y_align: Clutter.ActorAlign.CENTER,
    });
    actor.connect('clicked', () => onClick(actor));
    return actor;
}

const row = (...children) => {
    const box = new St.BoxLayout({style_class: 'froonty-break-row'});
    children.forEach(child => box.add_child(child));
    return box;
};

// A row of small buttons that wraps onto more lines.
function chips(...children) {
    const box = new St.Widget({
        style_class: 'froonty-break-chips',
        layout_manager: new Clutter.FlowLayout({column_spacing: 6, row_spacing: 6, homogeneous: false}),
        x_expand: true,
    });
    children.forEach(child => box.add_child(child));
    return box;
}

function setText(actor, text) {
    actor.visible = Boolean(text);
    if (actor.text !== text)
        actor.text = text ?? '';
}

// A fold-out button: an arrow and a title.
function expander(title, onClick) {
    const content = new St.BoxLayout({style_class: 'froonty-break-expander-content'});
    const icon = new St.Icon({icon_name: 'pan-end-symbolic'});
    content.add_child(icon);
    content.add_child(new St.Label({text: title, y_align: Clutter.ActorAlign.CENTER}));
    const actor = new St.Button({
        style_class: 'froonty-break-expander',
        can_focus: true,
        track_hover: true,
        x_expand: true,
        x_align: Clutter.ActorAlign.START,
        child: content,
    });
    actor.connect('clicked', () => onClick());
    return {actor, setOpen: open => {
        icon.icon_name = open ? 'pan-down-symbolic' : 'pan-end-symbolic';
    }};
}

export class BreakView {
    constructor(ctx, service) {
        this._ctx = ctx;
        this._service = service;
        this._w = words({_, ngettext});
        this._active = false;
        this._clockId = 0;
        this._moves = [];
        this._artFetched = false;
        this._ideas = {short: [], long: []};
        this._showStretch = false;
        // The stretch shown: kept until "Another" or the break changes.
        this._stretchId = null;
        this._eyesOpen = false;
        this._eyeChoice = null;
        this._breathe = false;
        this._routine = null;
        this._historyOpen = false;
        this._chartOpen = false;
        this._confirmForget = false;
        this._pauseOpen = false;
        this._workoutOpen = false;
        this._askReason = false;
        this._exerciseKey = null;
        this._historyKey = null;
        this._chartKey = null;
        this._chartDay = null;
        this._dirty = true;
        this.card = null;
        this._mediaHold = new MediaHold(ctx, service);

        this.actor = new St.BoxLayout({
            style_class: 'froonty-break',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
        });
        this._list = new St.BoxLayout({
            style_class: 'froonty-break-sections',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._scroll = new St.ScrollView({
            hscrollbar_policy: St.PolicyType.NEVER,
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true,
        });
        this._scroll.add_child(this._list);
        this.actor.add_child(this._scroll);

        this._buildOffer();
        this._buildStatus();
        this._buildNext();
        this._buildExercise();
        this._buildPosture();
        this._buildToday();
        this._notice = label('froonty-break-notice', {wrap: true});
        this._notice.text = this._w.notMedicalAdvice();
        this._list.add_child(this._notice);

        // While the tab is not on screen, only remember to update.
        this._serviceId = service.connect('changed', () => {
            if (this._active)
                this._sync();
            else
                this._dirty = true;
        });
        Promise.all([loadCatalog(), loadIdeas()]).then(([catalog, ideas]) => {
            if (!this.actor)
                return;
            this._moves = catalog.moves;
            this._artFetched = catalog.art;
            this._ideas = ideas;
            this._exerciseKey = null;
            this._sync();
        });
        this._sync();
    }

    destroy() {
        this.setActive(false);
        this._service.disconnect(this._serviceId);
        this._mediaHold.destroy();
        this.actor.destroy();
        this.actor = null;
    }

    /** Minute texts ("in 12 min") follow the clock while the tab is shown. */
    setActive(active) {
        this._active = active;
        if (active && !this._clockId)
            this._clockId = this._ctx.clock.connect('changed', () => this._sync());
        else if (!active && this._clockId)
            this._ctx.clock.disconnect(this._clockId);
        if (!active) {
            this._clockId = 0;
            // One-tap questions are for the moment they were asked.
            this._askReason = false;
            this._pauseOpen = false;
            this._workoutOpen = false;
            this._dirty = true;
        }
        if (active && this._dirty)
            this._sync();
        // With break-garmin on: today's activities (at most every 15 min).
        if (active)
            this._service.syncGarmin('tab');
    }

    _section(heading = null) {
        const box = new St.BoxLayout({
            style_class: 'froonty-break-section',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        if (heading)
            box.add_child(new St.Label({style_class: 'froonty-break-heading', text: heading}));
        this._list.add_child(box);
        return box;
    }

    _fmt(seconds) {
        return this._ctx.clock.formatTime(seconds * 1000);
    }

    // A time, with its weekday when it is not today ("Mon 09:00").
    _fmtWhen(seconds) {
        const day = t => GLib.DateTime.new_from_unix_local(Math.floor(t)).format('%F');
        return this._ctx.clock.formatTime(seconds * 1000,
            {weekday: day(seconds) !== day(Date.now() / 1000)});
    }

    // ------------------------------------------------------------ build

    _buildOffer() {
        this._offer = this._section();
        this._offerText = label('', {wrap: true});
        this._offerButton = button(_('Turn on eye and movement breaks'),
            () => this._service.turnOnGnomeBreaks());
        this._offerButton.x_align = Clutter.ActorAlign.START;
        this._offerDetail = label('froonty-break-dim', {wrap: true});
        [this._offerText, this._offerButton, this._offerDetail].forEach(a => this._offer.add_child(a));
    }

    _buildStatus() {
        this._status = this._section();
        this._meter = new St.BoxLayout({style_class: 'froonty-break-meter', y_align: Clutter.ActorAlign.START});
        for (let i = 0; i < LEVEL_GLYPHS.length; i++)
            this._meter.add_child(new St.Label());
        this._statusText = label('froonty-break-status', {wrap: true});
        this._status.add_child(row(this._meter, this._statusText));
        this._suggested = label('froonty-break-dim', {wrap: true});
        this._status.add_child(this._suggested);

        this.takeButton = button(this._w.takeLabel(), () => {
            if (this._service.model().features.pauseMedia)
                this._mediaHold.take();
            this._service.take();
            this._ctx.collapse();
        });
        this.delayButton = button('', () => {
            this._service.delay();
            this._askWhy();
        });
        this.skipButton = button('', () => {
            this._service.skip();
            this._askWhy();
        });
        this._actions = row(this.takeButton, this.delayButton, this.skipButton);
        this._actions.add_style_class_name('froonty-break-actions');
        this._status.add_child(this._actions);

        // "Why?" after a skip or a delay: one tap, or none.
        this._reasonText = label('froonty-break-dim');
        this._reasonText.text = _('Why?');
        this.reasonButtons = REASONS.map(r => button(this._w.reason(r), () => {
            this._service.addReason(r);
            this._askReason = false;
            this._sync();
        }, {styleClass: 'froonty-break-chip'}));
        const notNow = button('✕', () => {
            this._askReason = false;
            this._sync();
        }, {styleClass: 'froonty-break-chip'});
        notNow.accessible_name = _('Don’t say why');
        this._reasons = chips(this._reasonText, ...this.reasonButtons, notNow);
        this._status.add_child(this._reasons);

        this._hint = label('froonty-break-dim', {wrap: true});
        this._delayHidden = label('froonty-break-dim', {wrap: true});
        this._skipHidden = label('froonty-break-dim', {wrap: true});
        this._busyText = label('froonty-break-dim', {wrap: true});
        this._watchingText = label('froonty-break-dim', {wrap: true});
        this._reminders = label('froonty-break-dim', {wrap: true});
        [this._hint, this._delayHidden, this._skipHidden, this._busyText, this._watchingText, this._reminders]
            .forEach(a => this._status.add_child(a));

        // Paused, or outside working hours, and the Pause menu.
        this._pausedText = label('', {wrap: true});
        this.resumeButton = button(_('Resume'), () => this._service.resume());
        this._pausedRow = row(this._pausedText, this.resumeButton);
        this._status.add_child(this._pausedRow);
        this.pauseButton = button(_('Pause…'), () => {
            this._pauseOpen = !this._pauseOpen;
            this._sync();
        });
        this.pauseButton.x_align = Clutter.ActorAlign.START;
        this.pauseChoices = PAUSES.map(p => button(
            p === 'tomorrow' ? _('Until tomorrow') : this._w.duration(p * 60),
            () => {
                this._pauseOpen = false;
                this._service.pause(p);
            }, {styleClass: 'froonty-break-chip'}));
        this._pauseRow = chips(...this.pauseChoices);
        this._status.add_child(this.pauseButton);
        this._status.add_child(this._pauseRow);

        // "Was that a workout?" after a long away.
        this._askText = label('', {wrap: true});
        this.workoutYesButton = button(_('Yes'), () => this._service.confirmWorkout(),
            {styleClass: 'froonty-break-chip'});
        this.workoutNoButton = button(_('No'), () => this._service.dismissWorkout(),
            {styleClass: 'froonty-break-chip'});
        this._ask = row(this._askText, this.workoutYesButton, this.workoutNoButton);
        this._status.add_child(this._ask);
    }

    _askWhy() {
        this._askReason = this._service.model().features.skipReasons;
        this._sync();
    }

    _buildNext() {
        this._next = this._section(_('Next'));
        this._nextRows = {};
        for (const subject of ['eyesight', 'movement', 'long-rest']) {
            const icon = new St.Icon({style_class: 'froonty-break-row-icon', gicon: subjectIcon(subject)});
            const name = label('froonty-break-name');
            const detail = label('froonty-break-dim', {expand: true});
            const when = label('froonty-break-when');
            const box = row(icon, name, detail, when);
            this._next.add_child(box);
            this._nextRows[subject] = {box, name, detail, when};
        }
        this._nextFallback = label('', {wrap: true});
        this._next.add_child(this._nextFallback);

        // The move bar: a watch's bar, one segment more per step.
        this._moveIcon = new St.Icon({style_class: 'froonty-break-row-icon', gicon: subjectIcon('movement')});
        this._moveName = label('froonty-break-name');
        this._moveName.text = _('Move bar');
        this._moveBar = new St.BoxLayout({style_class: 'froonty-break-move-bar', x_expand: true,
            y_align: Clutter.ActorAlign.CENTER});
        this._moveSegments = [];
        for (let i = 0; i < MOVE_SEGMENTS; i++) {
            const segment = new St.Widget({style_class: i === 0 ? 'froonty-break-move-first' : 'froonty-break-move-segment',
                x_expand: i === 0});
            this._moveBar.add_child(segment);
            this._moveSegments.push(segment);
        }
        this._moveRow = row(this._moveIcon, this._moveName, this._moveBar);
        this._moveText = label('froonty-break-dim', {wrap: true});
        this._next.add_child(this._moveRow);
        this._next.add_child(this._moveText);
    }

    _buildExercise() {
        this._exercise = this._section(_('Exercise'));
        this._exerciseBox = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        this._exercise.add_child(this._exerciseBox);
        this._ideaText = label('froonty-break-idea', {wrap: true});
        this.ideaButton = button(_('Another idea'), () => this._service.nextIdea());
        this._ideaRow = row(this._ideaText, this.ideaButton);
        this._exercise.add_child(this._ideaRow);
        this._artNote = label('froonty-break-credit', {wrap: true});
        this._exercise.add_child(this._artNote);
    }

    _buildPosture() {
        this._posture = this._section(_('Sit / stand'));
        const toggle = new St.BoxLayout({style_class: 'froonty-break-toggle'});
        this.sittingButton = button(_('Sitting'), () => this._service.setPosture('sitting'),
            {styleClass: 'froonty-break-toggle-button', toggle: true});
        this.standingButton = button(_('Standing'), () => this._service.setPosture('standing'),
            {styleClass: 'froonty-break-toggle-button', toggle: true});
        this.sittingButton.accessible_name = _('Sitting');
        this.standingButton.accessible_name = _('Standing');
        toggle.add_child(this.sittingButton);
        toggle.add_child(this.standingButton);
        this._progressText = label('froonty-break-progress', {wrap: true});
        this._posture.add_child(row(toggle, this._progressText));

        this._bar = new St.Widget({
            style_class: 'froonty-break-bar',
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
        });
        // A scale, not a width: no relayout while the bar is drawn.
        this._barFill = new St.Widget({style_class: 'froonty-break-bar-fill', x_expand: true, y_expand: true});
        this._barFill.set_pivot_point(0, 0.5);
        this._bar.add_child(this._barFill);
        this._posture.add_child(this._bar);

        this._switchText = label('', {wrap: true});
        this.notNowButton = button(_('Not now'), () => this._service.notNow());
        this._posture.add_child(row(this._switchText, this.notNowButton));
        this.minimumButton = button('', b => this._service.setMinimumToday(b.checked),
            {styleClass: 'froonty-break-action', toggle: true});
        this.minimumButton.x_align = Clutter.ActorAlign.START;
        this._posture.add_child(this.minimumButton);
        this._targetText = label('froonty-break-dim', {wrap: true});
        this._evidence = label('froonty-break-dim', {wrap: true});
        this._evidence.text = _('2 h is a starting minimum from a 2015 expert statement; light walking counts.');
        this._posture.add_child(this._targetText);
        this._posture.add_child(this._evidence);
    }

    _buildToday() {
        this._today = this._section(_('Today'));
        this._todayLine1 = label('', {wrap: true});
        this._todayLine2 = label('', {wrap: true});
        this._todayLine3 = label('froonty-break-dim', {wrap: true});
        [this._todayLine1, this._todayLine2, this._todayLine3].forEach(a => this._today.add_child(a));

        // Workouts: a line, Undo, and "I worked out" with a few lengths.
        this._workoutText = label('froonty-break-dim', {wrap: true});
        this.workoutUndoButton = button(_('Undo'), () => this._service.clearWorkout());
        this._today.add_child(row(this._workoutText, this.workoutUndoButton));
        this.workoutButton = button(_('I worked out…'), () => {
            this._workoutOpen = !this._workoutOpen;
            this._sync();
        });
        this.workoutButton.x_align = Clutter.ActorAlign.START;
        this.workoutChoices = WORKOUT_MINUTES.map(minutes => button(this._w.duration(minutes * 60), () => {
            this._workoutOpen = false;
            this._service.logWorkout(minutes);
        }, {styleClass: 'froonty-break-chip'}));
        this._workoutRow = chips(...this.workoutChoices);
        this._today.add_child(this.workoutButton);
        this._today.add_child(this._workoutRow);

        // The 14-week chart.
        const chart = expander(_('14 weeks'), () => {
            this._chartOpen = !this._chartOpen;
            this._sync();
        });
        this._chartButton = chart.actor;
        this._setChartOpen = chart.setOpen;
        this._today.add_child(this._chartButton);
        this.metricButtons = METRICS.map(metric => {
            const b = button(this._metricName(metric), () => {
                this._ctx.settings.set_string('break-chart-metric', metric);
            }, {styleClass: 'froonty-break-chip', toggle: true});
            b.metric = metric;
            return b;
        });
        this._metricRow = chips(...this.metricButtons);
        this.chart = new HistoryChart({
            onSelect: day => {
                this._chartDay = day;
                this._syncChartDetail();
            },
            describe: cell => this._cellText(cell),
        });
        this._chartDetail = label('froonty-break-history', {wrap: true});
        this._chartBox = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true,
            style_class: 'froonty-break-chart-box'});
        [this._metricRow, this.chart, this._chartDetail].forEach(a => this._chartBox.add_child(a));
        this._today.add_child(this._chartBox);

        const history = expander(_('Last 7 days'), () => {
            this._historyOpen = !this._historyOpen;
            this._sync();
        });
        this._historyButton = history.actor;
        this._setHistoryOpen = history.setOpen;
        this.forgetButton = button(_('Forget history…'), () => {
            this._confirmForget = true;
            this._sync();
        });
        this._today.add_child(row(this._historyButton, this.forgetButton));

        this._confirmText = label('', {wrap: true});
        this.confirmForgetButton = button(_('Forget'), () => {
            this._confirmForget = false;
            this._service.forgetHistory();
        });
        this._keepButton = button(_('Keep'), () => {
            this._confirmForget = false;
            this._sync();
        });
        this._confirm = row(this._confirmText, this.confirmForgetButton, this._keepButton);
        this._today.add_child(this._confirm);
        this._historyList = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        this._today.add_child(this._historyList);
    }

    _metricName(metric) {
        return {
            kept: _('Breaks taken'),
            screen: _('At the computer'),
            stretch: _('Longest stretch'),
            standing: _('Standing'),
            moves: _('Hours moved'),
        }[metric];
    }

    // ------------------------------------------------------------ sync

    _sync() {
        if (!this.actor)
            return;
        this._dirty = false;
        const m = this._service.model();
        // Until the day so far is read from its file, nothing to show.
        for (const section of [this._offer, this._status, this._next, this._exercise, this._posture, this._today])
            section.visible = m.loaded;
        if (!m.loaded)
            return;
        const gnomeOn = m.available && m.selected.length > 0;
        const paused = m.paused.paused;
        const longRestUrgent = m.level.reason === 'long-rest';

        this._syncOffer(m);
        this._status.visible = gnomeOn || longRestUrgent || paused || m.busy.reasons.length > 0 ||
            Boolean(m.workout.ask);
        if (this._status.visible)
            this._syncStatus(m);
        this._next.visible = gnomeOn || (m.available && m.prefs.longRest) || m.move.enabled;
        if (this._next.visible)
            this._syncNext(m);
        this._exercise.visible = m.exercises && (gnomeOn || paused || m.prefs.longRest);
        if (this._exercise.visible)
            this._syncExercise(m);
        this._posture.visible = m.posture.enabled;
        if (this._posture.visible)
            this._syncPosture(m);
        this._syncToday(m);
    }

    _syncOffer(m) {
        const w = this._w;
        // Breaks Froonty paused are not "off".
        this._offer.visible = !m.available || (m.selected.length === 0 && !m.paused.paused);
        if (!this._offer.visible)
            return;
        if (!m.available) {
            this._offerText.text = _('GNOME’s break reminders are not available here.');
            this._offerButton.visible = false;
            this._offerDetail.visible = false;
            return;
        }
        let text = _('GNOME’s break reminders are off. Froonty shows and drives them; GNOME does the timing.');
        if (m.pillReminders)
            text += ` ${_('Froonty will remind you in the island; GNOME’s break notifications will be off while Froonty runs.')}`;
        this._offerText.text = text;
        this._offerButton.visible = true;
        this._offerButton.reactive = m.selectedWritable;
        this._offerButton.can_focus = m.selectedWritable;
        const eyes = m.types.eyesight;
        const move = m.types.movement;
        const detail = eyes && move
            ? _('Eyes every %s for %s; movement every %s for %s (change in Settings → Break).').format(
                w.duration(eyes.interval), w.duration(eyes.duration),
                w.duration(move.interval), w.duration(move.duration))
            : '';
        setText(this._offerDetail, m.selectedWritable ? detail : _('Locked by the administrator'));
    }

    _syncStatus(m) {
        const w = this._w;
        const level = m.level.level;
        const cells = this._meter.get_children();
        levelCells((level + 1) / LEVEL_GLYPHS.length).forEach(({glyph, styleClass}, i) => {
            cells[i].text = glyph;
            cells[i].style_class = styleClass;
        });
        this._meter.accessible_name = w.meterName(level);
        this._statusText.text = w.status(m.level, {
            since: m.screenSinceLongRest, length: m.prefs.longRestLength,
        });
        setText(this._suggested, level >= LEVEL.SOON ? w.suggested(m.suggestion) : '');

        const a = m.actions;
        this.takeButton.visible = a.take;
        this.delayButton.visible = a.delay;
        this.skipButton.visible = a.skip;
        this.delayButton.label = w.delayLabel(a.delaySeconds);
        this.skipButton.label = w.skipLabel(a.skipBoth);
        this._actions.visible = a.take || a.delay || a.skip;
        this._reasons.visible = this._askReason && m.features.skipReasons;
        const due = a.take || a.delay || a.skip || a.skipHidden;
        setText(this._hint, w.hint(a));
        setText(this._delayHidden, due ? w.delayHidden(a.delayHidden) : '');
        setText(this._skipHidden, due ? w.skipHidden(a.skipHidden) : '');
        setText(this._busyText, m.cueHeld || m.busyGraceUntil ? w.busy(m.busy, m.busyGraceUntil, s => this._fmt(s)) : '');
        setText(this._watchingText, w.watching([...new Set(m.busy.watching.map(i => appName(i.app) ?? _('a window')))]));
        setText(this._reminders, m.pillReminders && m.selected.length ? w.reminders(m.takeover) : '');

        const paused = m.paused.paused;
        setText(this._pausedText, w.paused(m.paused, s => this._fmtWhen(s)));
        this._pausedRow.visible = paused;
        this.resumeButton.label = m.paused.reason === 'hours' ? _('Remind me anyway') : _('Resume');
        const canPause = m.features.pauseButton && !paused && m.available && m.selected.length > 0;
        this.pauseButton.visible = canPause;
        this._pauseRow.visible = canPause && this._pauseOpen;

        const ask = m.workout.ask;
        this._ask.visible = Boolean(ask);
        if (ask)
            this._askText.text = w.workoutAsk(ask, s => this._fmt(s));
    }

    _syncNext(m) {
        const w = this._w;
        const fmt = s => this._fmt(s);
        for (const [subject, r] of Object.entries(this._nextRows)) {
            if (subject === 'long-rest') {
                r.box.visible = m.prefs.longRest;
                r.name.text = _('Long rest');
                r.detail.text = _('%s after %s').format(w.duration(m.prefs.longRestLength),
                    w.duration(m.prefs.longRestAfter));
                r.when.text = m.screenSinceLongRest >= m.prefs.longRestAfter
                    ? _('due') : _('%s so far').format(w.duration(m.screenSinceLongRest));
                continue;
            }
            const t = m.types[subject];
            const selected = m.lastEnd ? subject in m.lastEnd : false;
            r.box.visible = Boolean(t) && selected && !m.fallback;
            if (!r.box.visible)
                continue;
            r.name.text = subject === 'eyesight' ? _('Eyes') : _('Movement');
            r.detail.text = _('every %s, %s').format(w.duration(t.interval), w.duration(t.duration));
            const due = m.lastEnd[subject] + t.interval;
            const left = due - m.now;
            r.when.text = left > 0
                ? _('%s (in %s)').format(fmt(due), w.duration(left))
                : left > -60 ? _('due now') : _('%s overdue').format(w.duration(-left));
        }
        // Without GNOME's per-type times: the next break only.
        setText(this._nextFallback, m.fallback && m.nextType
            ? _('Next break: %s at %s').format(w.typeName(m.nextType).toLowerCase(), fmt(m.nextDue)) : '');

        const move = m.move;
        this._moveRow.visible = move.enabled;
        if (move.enabled) {
            const segments = m.present ? moveSegments(move) : 0;
            this._moveSegments.forEach((segment, i) => {
                if (i < segments)
                    segment.add_style_pseudo_class('checked');
                else
                    segment.remove_style_pseudo_class('checked');
            });
            this._moveBar.accessible_name = segments
                ? ngettext('Move bar: %d segment of %d', 'Move bar: %d segments of %d', segments)
                    .format(segments, MOVE_SEGMENTS)
                : _('Move bar: empty');
        }
        setText(this._moveText, move.enabled ? w.move(move, m.present ? moveSegments(move) : 0) : '');
    }

    // ------------------------------------------------------------ exercises

    // Seen by others (a call, screen sharing): quiet moves only.
    _discreet(m) {
        return m.busy.reasons.some(r => SEEN.includes(r));
    }

    _pickOptions(m) {
        return {
            posture: m.posture.enabled ? m.posture.mode : 'sitting',
            discreet: this._discreet(m),
            recent: m.exercise.recent,
            seed: m.exerciseNext,
        };
    }

    _byKind(kind) {
        return this._moves.filter(mv => mv.kind === kind);
    }

    _syncExercise(m) {
        const lv = m.level;
        const f = m.features;
        const eyesDue = lv.type === 'eyesight' && lv.level >= LEVEL.DUE;
        const movementNear = lv.type === 'movement' && lv.level >= LEVEL.SOON;
        const longRest = lv.reason === 'long-rest';
        // "Show a stretch" lasts until a break comes near.
        if (eyesDue || movementNear || longRest)
            this._showStretch = false;
        const stretching = movementNear || longRest || this._showStretch;
        if (!stretching)
            this._stretchId = null;
        else if (!this._stretchId || !this._moves.some(mv => mv.id === this._stretchId))
            this._stretchId = nextMove(this._moves, this._pickOptions(m))?.id ?? null;

        let key;
        if (this._routine)
            key = 'routine';
        else if (this._breathe && f.breathing)
            key = `breathe:${f.breathingPattern}`;
        else if (eyesDue || this._eyeChoice)
            key = `eyes:${f.eyeExercises}:${this._eyesOpen}:${this._eyeChoice}:${m.types.eyesight?.duration}`;
        else if (stretching)
            key = `stretch:${this._stretchId}:${f.routines}:${f.animate}:${longRest}`;
        else
            key = `buttons:${f.routines}:${f.eyeExercises}:${f.breathing}`;

        this._syncIdea(m, eyesDue, movementNear || longRest);
        this._artNote.visible = this._moves.length > 0 && !this._artFetched && key.startsWith('stretch');
        this._artNote.text = _('Better pictures: run “make break-art” in Froonty’s folder, then reinstall.');

        if (key === this._exerciseKey)
            return;
        this._exerciseKey = key;
        if (key !== 'routine')
            this._exerciseBox.destroy_all_children();
        this.card = null;
        this.showStretchButton = null;
        this.routineButton = null;

        if (key === 'routine')
            return;
        if (key.startsWith('breathe:'))
            this._showBreathing(m);
        else if (key.startsWith('eyes:'))
            this._showEyes(m);
        else if (key.startsWith('stretch:'))
            this._showStretchCard(m, longRest);
        else
            this._showButtons(m);
    }

    _addCard(move, options = {}) {
        this.card = new ExerciseCard(move, {animate: this._service.model().features.animate, ...options});
        this._exerciseBox.add_child(this.card);
        this._service.markShown([move.id]);
        return this.card;
    }

    _showStretchCard(m, longRest) {
        const move = this._moves.find(mv => mv.id === this._stretchId);
        if (move) {
            this._addCard(move, {onAnother: () => {
                // The one shown is recent now: the next pick differs.
                this._stretchId = null;
                this._service.nextExercise();
            }});
        }
        if (m.features.routines)
            this._exerciseBox.add_child(this._routineButton(m, longRest));
    }

    _routineSteps(m, longRest) {
        const seconds = longRest ? m.prefs.longRestLength : m.types.movement?.duration ?? 300;
        return routine(this._moves.filter(mv => mv.kind !== 'eyes'), {
            kind: longRest ? 'long-rest' : 'movement',
            seconds,
            ...this._pickOptions(m),
            breathing: m.features.breathing,
            breathingPattern: m.features.breathingPattern,
        });
    }

    _routineButton(m, longRest) {
        const steps = this._routineSteps(m, longRest);
        const text = ngettext('Start a routine (%d move, %s)', 'Start a routine (%d moves, %s)', steps.length)
            .format(steps.length, this._w.duration(routineSeconds(steps)));
        this.routineButton = button(text, () => this._startRoutine(steps));
        this.routineButton.x_align = Clutter.ActorAlign.START;
        this.routineButton.visible = steps.length > 0;
        return this.routineButton;
    }

    _startRoutine(steps) {
        if (!steps.length)
            return;
        this._exerciseBox.destroy_all_children();
        this._routine = new RoutinePlayer(steps, {
            animate: this._service.model().features.animate,
            onShown: ids => this._service.markShown(ids),
            onEnd: () => {
                this._routine = null;
                this._exerciseKey = null;
                this._exerciseBox.destroy_all_children();
                this._service.nextExercise();
            },
        });
        this._exerciseKey = 'routine';
        this._exerciseBox.add_child(this._routine.actor);
    }

    _showEyes(m) {
        const f = m.features;
        const duration = m.types.eyesight?.duration ?? 20;
        const eyes = this._byKind('eyes');
        const far = eyes.find(mv => mv.id === 'far-look');
        if (f.eyeExercises && far && !this._eyeChoice) {
            this._addCard({...far, seconds: duration});
        } else if (!this._eyeChoice) {
            this._exerciseBox.add_child(Object.assign(label('', {wrap: true}), {
                text: _('Look at something at least 6 m (20 ft) away for %s, and blink.')
                    .format(this._w.duration(duration)),
            }));
        }
        if (!f.eyeExercises)
            return;
        const fold = expander(_('Eye exercises (comfort only)'), () => {
            this._eyesOpen = !this._eyesOpen;
            if (!this._eyesOpen)
                this._eyeChoice = null;
            this._sync();
        });
        fold.setOpen(this._eyesOpen);
        this._exerciseBox.add_child(fold.actor);
        if (!this._eyesOpen)
            return;
        const choices = eyes.filter(mv => mv.id !== 'far-look').map(mv => {
            const b = button(mv.title, () => {
                this._eyeChoice = mv.id;
                this._sync();
            }, {styleClass: 'froonty-break-chip', toggle: true});
            b.checked = this._eyeChoice === mv.id;
            return b;
        });
        if (f.breathing) {
            choices.push(button(_('Breathe'), () => {
                this._breathe = true;
                this._sync();
            }, {styleClass: 'froonty-break-chip'}));
        }
        this._exerciseBox.add_child(chips(...choices));
        const chosen = eyes.find(mv => mv.id === this._eyeChoice);
        if (chosen)
            this._addCard(chosen);
    }

    _showBreathing(m) {
        const id = m.features.breathingPattern === 'slow' ? 'breath-slow' : 'breath-box';
        const move = this._moves.find(mv => mv.id === id);
        if (move)
            this._addCard(move);
        const done = button(_('Done'), () => {
            this._breathe = false;
            this._sync();
        });
        done.x_align = Clutter.ActorAlign.START;
        this._exerciseBox.add_child(done);
    }

    // Nothing near: exercises on request.
    _showButtons(m) {
        const f = m.features;
        this.showStretchButton = button(_('Show a stretch'), () => {
            this._showStretch = true;
            this._sync();
        });
        const buttons = [this.showStretchButton];
        if (f.routines && this._moves.length)
            buttons.push(this._routineButton(m, false));
        if (f.eyeExercises) {
            buttons.push(button(_('Eye exercises'), () => {
                this._eyesOpen = true;
                this._eyeChoice = 'follow-eight';
                this._sync();
            }));
        }
        if (f.breathing) {
            buttons.push(button(_('Breathe'), () => {
                this._breathe = true;
                this._sync();
            }));
        }
        this._exerciseBox.add_child(chips(...buttons));
    }

    // One idea: a short one for eye breaks and quiet moments, a long one
    // for movement breaks and long rests.
    _syncIdea(m, eyes, moving) {
        const list = moving ? this._ideas.long : this._ideas.short;
        const idea = m.features.ideas && (eyes || moving || m.level.level >= LEVEL.SOON || this._showStretch)
            ? pickIdea(list, m.exercise.idea) : null;
        this._ideaRow.visible = Boolean(idea);
        if (idea) {
            this._ideaText.text = idea.title
                ? _('Idea: %s. %s').format(idea.title, idea.text) : _('Idea: %s').format(idea.text);
        }
    }

    // ------------------------------------------------------------ posture

    _syncPosture(m) {
        const w = this._w;
        const p = m.posture;
        const standing = p.mode === 'standing';
        this.sittingButton.checked = !standing;
        this.standingButton.checked = standing;
        const target = p.targetSeconds;
        const percent = target ? Math.round(100 * p.standingSeconds / target) : 0;
        this._progressText.text = p.workoutCredit
            ? _('Standing %s of %s (%d%%, with your workout)').format(
                w.duration(p.standingSeconds), w.duration(target), percent)
            : _('Standing %s of %s (%d%%)').format(
                w.duration(p.standingSeconds), w.duration(target), percent);
        this._barFill.scale_x = Math.min(1, target ? p.standingSeconds / target : 0);
        this._bar.accessible_name = this._progressText.text;

        const cue = m.cue?.kind === 'posture' ? m.cue.posture : null;
        const fmt = s => this._fmt(s);
        let text = '';
        if (cue === 'stand')
            text = _('Time to stand up.');
        else if (cue === 'sit')
            text = _('Time to sit down.');
        else if (!p.reminders)
            text = '';
        else if (standing)
            text = _('Sit down at %s').format(fmt(m.now + p.standAfter - p.modeActiveSeconds));
        else if (p.standingSeconds >= target)
            text = _('Today’s standing target is met.');
        else
            text = _('Stand up at %s').format(fmt(m.now + p.sitAfter - p.modeActiveSeconds));
        setText(this._switchText, text);
        this.notNowButton.visible = Boolean(cue);

        this.minimumButton.label = _('Just the minimum today (%s)').format(w.duration(p.plan.base * 60));
        this.minimumButton.checked = p.minimumChosen;
        let targetText = _('Target %s').format(w.duration(target));
        if (m.workout.eased)
            targetText = _('Target %s (the minimum: you worked out today)').format(w.duration(target));
        else if (p.minimumToday)
            targetText = _('Target %s (just the minimum today)').format(w.duration(target));
        else if (p.building)
            targetText = _('Target %s (building up; +%s after meeting it 4 of 5 days)')
                .format(w.duration(target), w.duration(p.plan.step * 60));
        else if (p.plan.buildup && target < p.plan.ceiling)
            targetText = _('Target %s (builds up by %s after you meet it on 4 of 5 days)')
                .format(w.duration(target), w.duration(p.plan.step * 60));
        this._targetText.text = targetText;
    }

    // ------------------------------------------------------------ today

    _syncToday(m) {
        const w = this._w;
        const d = m.today;
        this._todayLine1.text = _('At the computer %s · longest stretch %s').format(
            w.duration(d.activeSeconds), w.duration(d.longestStretchSeconds));
        // Only what happened: "3 taken, 1 delayed", or "none yet".
        const counts = c => [
            c.taken && _('%d taken').format(c.taken),
            c.skipped && _('%d skipped').format(c.skipped),
            c.delayed && _('%d delayed').format(c.delayed),
        ].filter(Boolean).join(', ') || _('none yet');
        let line = _('Eye breaks %s · movement %s').format(counts(d.eyesight), counts(d.movement));
        if (d.longRests)
            line += ` · ${ngettext('%d long rest', '%d long rests', d.longRests).format(d.longRests)}`;
        this._todayLine2.text = line;

        // Moved hours, busy time, why skipped.
        const deskHours = d.hourActive.filter(s => s >= DESK_HOUR_SECONDS).length;
        const moved = d.hourActive.filter((s, h) => s >= DESK_HOUR_SECONDS && d.hourMoved[h]).length;
        const extra = [];
        if (m.move.enabled && deskHours)
            extra.push(w.movedHours(moved, deskHours));
        if (d.busySeconds >= 60)
            extra.push(_('busy without typing %s').format(w.duration(d.busySeconds)));
        const busyBreaks = d.eyesight.busy + d.movement.busy;
        if (busyBreaks) {
            extra.push(ngettext('%d break GNOME counted during a call or a video',
                '%d breaks GNOME counted during a call or a video', busyBreaks).format(busyBreaks));
        }
        const why = REASONS.filter(r => d.reasons[r]).map(r => `${w.reason(r).toLowerCase()} ${d.reasons[r]}`);
        if (why.length)
            extra.push(_('why: %s').format(why.join(', ')));
        setText(this._todayLine3, extra.join(' · '));

        const workout = m.workout;
        const garminLines = [];
        if (m.garmin.enabled) {
            if (workout.garmin.length)
                garminLines.push(w.garminActivities(workout.garmin));
            if (workout.intensity)
                garminLines.push(w.intensity(workout.intensity));
            if (m.garmin.error)
                garminLines.push(w.garminError(m.garmin.error));
        }
        setText(this._workoutText, workout.enabled
            ? [w.workout(workout), ...garminLines].filter(Boolean).join(' · ') : '');
        this.workoutUndoButton.visible = workout.enabled && workout.manualMinutes > 0;
        this.workoutButton.visible = workout.enabled;
        this._workoutRow.visible = workout.enabled && this._workoutOpen;

        const history = this._service.history;
        this._historyButton.visible = history.length > 0;
        this.forgetButton.visible = history.length > 0 || d.activeSeconds > 0;
        this._setHistoryOpen(this._historyOpen);
        this._historyButton.accessible_name = this._historyOpen ? _('Hide the last 7 days') : _('Show the last 7 days');
        this._confirm.visible = this._confirmForget;
        const days = history.length + (d.activeSeconds >= 1 ? 1 : 0);
        this._confirmText.text = ngettext('Forget %d day of history?', 'Forget %d days of history?',
            days).format(days);

        this._syncChart(m, history);

        const key = this._historyOpen ? JSON.stringify(history.slice(0, HISTORY_ROWS)) : '';
        if (key === this._historyKey)
            return;
        this._historyKey = key;
        this._historyList.destroy_all_children();
        if (!this._historyOpen)
            return;
        for (const day of history.slice(0, HISTORY_ROWS))
            this._historyList.add_child(Object.assign(label('froonty-break-history', {wrap: true}), {text: this._historyRow(day)}));
    }

    _syncChart(m, history) {
        const on = m.features.chart && (history.length > 0 || m.today.activeSeconds > 0);
        this._chartButton.visible = on;
        this._setChartOpen(this._chartOpen);
        this._chartBox.visible = on && this._chartOpen;
        if (!this._chartBox.visible)
            return;
        const metric = METRICS.includes(m.features.chartMetric) ? m.features.chartMetric : 'kept';
        for (const b of this.metricButtons)
            b.checked = b.metric === metric;
        // The day's minute-by-minute totals are not redrawn every minute.
        const key = JSON.stringify([metric, m.today.day, history.length, history[0]?.day,
            Math.floor(m.today.activeSeconds / 600)]);
        this._chartRecords = new Map([...history, m.today].map(d => [d.day, d]));
        this._chartMetric = metric;
        if (key !== this._chartKey) {
            this._chartKey = key;
            this.chart.setData(chartCells(history, m.today, metric));
        }
        this._syncChartDetail();
    }

    _cellText(cell) {
        const record = this._chartRecords?.get(cell.day) ?? null;
        return cellText(cell, record, this._chartMetric, {_, ngettext, duration: this._w.duration});
    }

    _syncChartDetail() {
        const day = this._chartDay;
        const record = day ? this._chartRecords?.get(day) : null;
        setText(this._chartDetail, record ? this._historyRow(record)
            : day ? _('Nothing recorded that day.') : _('Select a day for its totals.'));
    }

    // "Thu 1 Oct · 6 h 12 min · breaks 18 taken, 5 skipped or delayed · standing 2 h 5 min of 2 h, met"
    _historyRow(day) {
        const w = this._w;
        const [y, mo, d] = day.day.split('-').map(Number);
        const date = GLib.DateTime.new_local(y, mo, d, 12, 0, 0).format('%a %-d %b');
        const taken = day.eyesight.taken + day.movement.taken;
        const missed = day.eyesight.skipped + day.eyesight.delayed + day.movement.skipped + day.movement.delayed;
        const parts = [date, w.duration(day.activeSeconds),
            _('breaks %d taken, %d skipped or delayed').format(taken, missed)];
        if (day.targetSeconds > 0) {
            const standing = day.standingSeconds + (day.workoutCreditSeconds ?? 0);
            parts.push((met(day) ? _('standing %s of %s, met') : _('standing %s of %s, not met'))
                .format(w.duration(standing), w.duration(day.targetSeconds)));
        }
        if (day.workoutMinutes)
            parts.push(_('workout %s').format(w.duration(day.workoutMinutes * 60)));
        return parts.join(' · ');
    }
}
