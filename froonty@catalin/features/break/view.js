// SPDX-License-Identifier: GPL-3.0-or-later
// Break tab (docs/features/break.md): urgency and GNOME's actions, the next
// breaks, an exercise card, the sit/stand tracker and today's totals, in
// one scrolled column. Actors are made once and updated in place; only the
// exercise card and the history rows are rebuilt, when they change.
//
// Every line comes from the service's model (service.js) and words.js.
// "Take now" collapses the island (GNOME dims it too); the rest keep it open.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {gettext as _, ngettext} from 'resource:///org/gnome/shell/extensions/extension.js';

import {levelCells, LEVEL_GLYPHS} from '../sysmon/level.js';
import {ExerciseCard} from './card.js';
import {LEVEL} from './engine.js';
import {eyeExercises, loadExercises, stretches} from './exercises.js';
import {subjectIcon} from './icons.js';
import {met} from './plan.js';
import {words} from './words.js';

const HISTORY_ROWS = 7;

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

function setText(actor, text) {
    actor.visible = Boolean(text);
    if (actor.text !== text)
        actor.text = text ?? '';
}

export class BreakView {
    constructor(ctx, service) {
        this._ctx = ctx;
        this._service = service;
        this._w = words({_, ngettext});
        this._active = false;
        this._clockId = 0;
        this._exercises = [];
        this._showStretch = false;
        this._eyesOpen = false;
        this._historyOpen = false;
        this._confirmForget = false;
        this._exerciseKey = null;
        this._historyKey = null;
        this._dirty = true;
        this.card = null;

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
            style_class: 'froonty-break-scroll',
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
        loadExercises().then(list => {
            if (!this.actor)
                return;
            this._exercises = list;
            this._exerciseKey = null;
            this._sync();
        });
        this._sync();
    }

    destroy() {
        this.setActive(false);
        this._service.disconnect(this._serviceId);
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
        if (!active)
            this._clockId = 0;
        if (active && this._dirty)
            this._sync();
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
            this._service.take();
            this._ctx.collapse?.();
        });
        this.delayButton = button('', () => this._service.delay());
        this.skipButton = button('', () => this._service.skip());
        this._actions = row(this.takeButton, this.delayButton, this.skipButton);
        this._actions.add_style_class_name('froonty-break-actions');
        this._status.add_child(this._actions);
        this._hint = label('froonty-break-dim', {wrap: true});
        this._delayHidden = label('froonty-break-dim', {wrap: true});
        this._reminders = label('froonty-break-dim', {wrap: true});
        [this._hint, this._delayHidden, this._reminders].forEach(a => this._status.add_child(a));
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
    }

    _buildExercise() {
        this._exercise = this._section(_('Exercise'));
        this._exerciseBox = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        this._exercise.add_child(this._exerciseBox);
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
            {styleClass: 'froonty-break-action froonty-break-minimum', toggle: true});
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
        this._today.add_child(this._todayLine1);
        this._today.add_child(this._todayLine2);

        const expanderContent = new St.BoxLayout({style_class: 'froonty-break-expander-content'});
        this._historyIcon = new St.Icon({icon_name: 'pan-end-symbolic'});
        expanderContent.add_child(this._historyIcon);
        expanderContent.add_child(new St.Label({text: _('Last 7 days'), y_align: Clutter.ActorAlign.CENTER}));
        this._historyButton = new St.Button({
            style_class: 'froonty-break-expander',
            can_focus: true,
            track_hover: true,
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
            child: expanderContent,
        });
        this._historyButton.connect('clicked', () => {
            this._historyOpen = !this._historyOpen;
            this._sync();
        });
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

    // ------------------------------------------------------------ sync

    _sync() {
        if (!this.actor)
            return;
        this._dirty = false;
        const m = this._service.model();
        const w = this._w;
        // Until the day so far is read from its file, nothing to show.
        for (const section of [this._offer, this._status, this._next, this._exercise, this._posture, this._today])
            section.visible = m.loaded;
        if (!m.loaded)
            return;
        const gnomeOn = m.available && m.selected.length > 0;
        const longRestUrgent = m.level.reason === 'long-rest';

        this._syncOffer(m);
        this._status.visible = gnomeOn || longRestUrgent;
        if (this._status.visible)
            this._syncStatus(m);
        this._next.visible = gnomeOn || (m.available && m.prefs.longRest);
        if (this._next.visible)
            this._syncNext(m);
        this._exercise.visible = m.exercises && gnomeOn;
        if (this._exercise.visible)
            this._syncExercise(m);
        this._posture.visible = m.posture.enabled;
        if (this._posture.visible)
            this._syncPosture(m);
        this._syncToday(m);
        this._notice.text = w.notMedicalAdvice();
    }

    _syncOffer(m) {
        const w = this._w;
        this._offer.visible = !m.available || m.selected.length === 0;
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
        setText(this._hint, w.hint(a));
        setText(this._delayHidden, a.skip ? w.delayHidden(a.delayHidden) : '');
        setText(this._reminders, m.pillReminders && m.selected.length ? w.reminders(m.takeover) : '');
    }

    _syncNext(m) {
        const w = this._w;
        const fmt = seconds => this._ctx.clock.formatTime(seconds * 1000);
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
    }

    _syncExercise(m) {
        const lv = m.level;
        const list = stretches(this._exercises);
        let key;
        if (lv.type === 'eyesight' && lv.level >= LEVEL.DUE && !this._showStretch)
            key = `eyes:${this._eyesOpen}`;
        else if ((lv.type === 'movement' && lv.level >= LEVEL.SOON) || this._showStretch)
            key = list.length ? `stretch:${list[m.exerciseNext % list.length].id}` : 'none';
        else
            key = 'button';
        if (key === this._exerciseKey)
            return;
        this._exerciseKey = key;
        this._exerciseBox.destroy_all_children();
        this.card = null;
        this.showStretchButton = null;

        if (key.startsWith('stretch:')) {
            this.card = new ExerciseCard(list[m.exerciseNext % list.length], {
                onAnother: () => this._service.nextExercise(),
            });
            this._exerciseBox.add_child(this.card);
        } else if (key.startsWith('eyes:')) {
            const duration = m.types.eyesight?.duration ?? 20;
            this._exerciseBox.add_child(Object.assign(label('', {wrap: true}), {
                text: _('Look at something at least 6 m (20 ft) away for %s, and blink.')
                    .format(this._w.duration(duration)),
            }));
            const content = new St.BoxLayout({style_class: 'froonty-break-expander-content'});
            content.add_child(new St.Icon({icon_name: this._eyesOpen ? 'pan-down-symbolic' : 'pan-end-symbolic'}));
            content.add_child(new St.Label({text: _('Eye exercises (comfort only)'), y_align: Clutter.ActorAlign.CENTER}));
            const expander = new St.Button({style_class: 'froonty-break-expander', can_focus: true,
                track_hover: true, x_align: Clutter.ActorAlign.START, child: content});
            expander.connect('clicked', () => {
                this._eyesOpen = !this._eyesOpen;
                this._sync();
            });
            this._exerciseBox.add_child(expander);
            if (this._eyesOpen) {
                for (const exercise of eyeExercises(this._exercises))
                    this._exerciseBox.add_child(new ExerciseCard(exercise));
            }
        } else if (key === 'button') {
            this.showStretchButton = button(_('Show a stretch'), () => {
                this._showStretch = true;
                this._sync();
            });
            this.showStretchButton.x_align = Clutter.ActorAlign.START;
            this._exerciseBox.add_child(this.showStretchButton);
        }
    }

    _syncPosture(m) {
        const w = this._w;
        const p = m.posture;
        const standing = p.mode === 'standing';
        this.sittingButton.checked = !standing;
        this.standingButton.checked = standing;
        const target = p.targetSeconds;
        const percent = target ? Math.round(100 * p.standingSeconds / target) : 0;
        this._progressText.text = _('Standing %s of %s (%d%%)').format(
            w.duration(p.standingSeconds), w.duration(target), percent);
        this._barFill.scale_x = Math.min(1, target ? p.standingSeconds / target : 0);
        this._bar.accessible_name = this._progressText.text;

        const cue = m.cue?.kind === 'posture' ? m.cue.posture : null;
        const fmt = seconds => this._ctx.clock.formatTime(seconds * 1000);
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
        this.minimumButton.checked = p.minimumToday;
        let targetText = _('Target %s').format(w.duration(target));
        if (p.minimumToday)
            targetText = _('Target %s (just the minimum today)').format(w.duration(target));
        else if (p.building)
            targetText = _('Target %s (building up; +%s after meeting it 4 of 5 days)')
                .format(w.duration(target), w.duration(p.plan.step * 60));
        else if (p.plan.buildup && target < p.plan.ceiling)
            targetText = _('Target %s (builds up by %s after you meet it on 4 of 5 days)')
                .format(w.duration(target), w.duration(p.plan.step * 60));
        this._targetText.text = targetText;
    }

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

        const history = this._service.history;
        this._historyButton.visible = history.length > 0;
        this.forgetButton.visible = history.length > 0 || d.activeSeconds > 0;
        this._historyIcon.icon_name = this._historyOpen ? 'pan-down-symbolic' : 'pan-end-symbolic';
        this._historyButton.accessible_name = this._historyOpen ? _('Hide the last 7 days') : _('Show the last 7 days');
        this._confirm.visible = this._confirmForget;
        const days = history.length + (d.activeSeconds >= 1 ? 1 : 0);
        this._confirmText.text = ngettext('Forget %d day of history?', 'Forget %d days of history?',
            days).format(days);

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
            parts.push((met(day) ? _('standing %s of %s, met') : _('standing %s of %s, not met'))
                .format(w.duration(day.standingSeconds), w.duration(day.targetSeconds)));
        }
        return parts.join(' · ');
    }
}
