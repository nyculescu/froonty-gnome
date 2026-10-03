// SPDX-License-Identifier: GPL-3.0-or-later
// Calendar tab: the events of the selected day, week or month
// (docs/features/calendar.md §B.4).
//
//   Today · Fri 2 Oct
//   ▌Standup                                  [Now]
//   ▌09:00 – 09:15 · Work (Google) · Room 1
//
// One card per event and day, in its calendar's colour (a bar and a 10%
// fill); past events dimmed, cancelled ones struck through, "Now" and
// "Next" marked. A card whose calendar has a web page opens that day
// there. Event text is always plain text, never markup.
//
// Scrolling: to the selected day (today when the tab opens) only when
// asked (the tab came on screen, another day or span was chosen); a live
// change keeps the scroll position. The clock's minute ticks update the
// cards' states in place.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {FALLBACK_COLOR, withAlpha} from './color.js';
import {addDays, dateKey, sameDate} from './range.js';

const EN_DASH = '–';
const clean = text => (text ?? '').replace(/\s+/g, ' ').trim();
const localDate = date => GLib.DateTime.new_local(date.y, date.m, date.d, 12, 0, 0);

/** "Today", "Tomorrow", "Yesterday", or "Fri 2 Oct". */
export function dayName(date, today) {
    if (sameDate(date, today))
        return _('Today');
    if (sameDate(date, addDays(today, 1)))
        return _('Tomorrow');
    if (sameDate(date, addDays(today, -1)))
        return _('Yesterday');
    return localDate(date).format('%a %-d %b');
}

/** A day group's heading: "Today · Fri 2 Oct", or "Mon 5 Oct". */
export function dayHeading(date, today) {
    const short = localDate(date).format('%a %-d %b');
    const name = dayName(date, today);
    return name === short ? short : `${name} · ${short}`;
}

/** An entry's time, as GNOME's event list words it (dateMenu.js _formatEventTime). */
export function timeText(entry, clock, rtl = false) {
    const time = (seconds, options) => clock.formatTime(seconds * 1000, options);
    switch (entry.kind) {
    case 'all-day':
    case 'middle':
        return _('All day');
    case 'starts':
        return `${time(entry.start)} ${EN_DASH} ${time(entry.end, {weekday: true})}`;
    case 'ends':
        return _('Until %s').format(time(entry.end));
    default: {
        if (entry.start === entry.end)
            return time(entry.start);
        const [first, last] = rtl ? [entry.end, entry.start] : [entry.start, entry.end];
        return `${time(first)} ${EN_DASH} ${time(last)}`;
    }
    }
}

/** "Work (Google)" for a calendar on the web, "Personal" otherwise. */
export function calendarName(calendar) {
    const label = calendar?.provider?.label;
    const name = clean(calendar?.name) || _('Calendar');
    return label ? `${name} (${label})` : name;
}

const identity = (entry, date) =>
    `${entry.calendarUid}\n${entry.item.key}\n${entry.start}\n${dateKey(date)}`;

export const Agenda = GObject.registerClass(
class Agenda extends St.BoxLayout {
    /**
     * @param {object} actions open(entry, date) → boolean
     * @param {object} clock formatTime(ms, options)
     */
    _init(actions, clock) {
        super._init({
            style_class: 'froonty-calendar-agenda',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
        });
        this._actions = actions;
        this._clock = clock;
        this._cards = [];
        this._anchor = null;
        this._anchorId = 0;
        this._laterId = 0;

        this._empty = new St.Label({
            style_class: 'froonty-calendar-empty',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: true,
        });
        this.add_child(this._empty);

        this._list = new St.BoxLayout({
            style_class: 'froonty-calendar-agenda-list',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this.scrollView = new St.ScrollView({
            style_class: 'froonty-calendar-agenda-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true,
        });
        this.scrollView.add_child(this._list);
        this.add_child(this.scrollView);
        this.connect('destroy', () => this._cancelScroll());
    }

    /** The cards shown, for tests: [{entry, date, actor}]. */
    get cards() {
        return this._cards;
    }

    /**
     * @param {object} agenda CalendarService.agenda()
     * @param {boolean} scroll bring the selected day to the top
     */
    update(agenda, scroll) {
        if (agenda.loading) {
            this._showEmpty(_('Loading…'));
            return false;
        }
        const focused = this._cards.find(card => card.actor.has_key_focus());
        const focusedId = focused ? identity(focused.entry, focused.date) : null;
        this._cancelScroll();
        this._list.destroy_all_children();
        this._cards = [];

        const headers = agenda.granularity !== 'day';
        let anchor = null;
        for (const day of agenda.days) {
            if (day.entries.length === 0)
                continue;
            if (headers) {
                const header = new St.Label({
                    style_class: 'froonty-calendar-day-header',
                    text: dayHeading(day.date, agenda.today),
                });
                this._list.add_child(header);
                if (!anchor && dateKey(day.date) >= dateKey(agenda.selected))
                    anchor = header;
            }
            for (const entry of day.entries) {
                const card = this._card(entry, day.date);
                this._list.add_child(card.actor);
                this._cards.push(card);
            }
        }
        if (agenda.truncated > 0) {
            this._list.add_child(new St.Label({
                style_class: 'froonty-calendar-more',
                text: _('and %d more: pick a day').format(agenda.truncated),
            }));
        }
        if (this._cards.length === 0) {
            this._showEmpty(_('No events'));
            return false;
        }
        this._empty.hide();
        this.scrollView.show();
        if (focusedId) {
            this._cards.find(card => identity(card.entry, card.date) === focusedId)
                ?.actor.grab_key_focus();
        }
        if (scroll) {
            const headersShown = this._list.get_children().filter(child =>
                child.has_style_class_name('froonty-calendar-day-header'));
            this._scrollTo(anchor ?? headersShown.at(-1) ?? null);
        }
        return true;
    }

    /**
     * The minute ticked: new states for the same cards, in place.
     *
     * @returns {boolean} false when the cards are not the same any more
     */
    refreshStates(agenda) {
        const fresh = agenda.days.flatMap(day => day.entries.map(entry => ({entry, date: day.date})));
        if (agenda.loading || fresh.length !== this._cards.length ||
            fresh.some(({entry, date}, i) =>
                identity(entry, date) !== identity(this._cards[i].entry, this._cards[i].date)))
            return false;
        const rtl = this.get_text_direction() === Clutter.TextDirection.RTL;
        fresh.forEach(({entry}, i) => {
            const card = this._cards[i];
            card.entry = entry;
            // The clock's format may have changed too.
            card.meta.text = this._metaText(entry, rtl);
            this._applyState(card, entry);
        });
        return true;
    }

    _showEmpty(text) {
        this._cancelScroll();
        this._list.destroy_all_children();
        this._cards = [];
        this._empty.text = text;
        this._empty.show();
        this.scrollView.hide();
    }

    _card(entry, date) {
        const provider = entry.calendar?.provider;
        const clickable = Boolean(provider?.dayUrl || provider?.homeUrl);
        const props = {style_class: 'froonty-calendar-card', x_expand: true};
        const actor = clickable
            ? new St.Button({...props, can_focus: true, track_hover: true, x_align: Clutter.ActorAlign.FILL})
            : new St.BoxLayout(props);
        const row = new St.BoxLayout({style_class: 'froonty-calendar-card-row', x_expand: true});
        // Only sanitized hex (color.js) reaches the style.
        const color = entry.calendar?.color ?? null;
        const bar = new St.Widget({
            style_class: 'froonty-calendar-card-bar',
            style: `background-color: ${color ?? FALLBACK_COLOR};`,
            y_expand: true,
        });
        actor.style = `background-color: ${color ? withAlpha(color, 0.1) : 'rgba(255,255,255,0.05)'};`;
        row.add_child(bar);

        const content = new St.BoxLayout({
            style_class: 'froonty-calendar-card-content',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        const top = new St.BoxLayout({style_class: 'froonty-calendar-card-top', x_expand: true});
        const title = new St.Label({
            style_class: 'froonty-calendar-card-title',
            text: clean(entry.item.title) || _('Untitled event'),
            x_expand: true,
        });
        top.add_child(title);
        const state = new St.Label({style_class: 'froonty-calendar-state', y_align: Clutter.ActorAlign.CENTER});
        top.add_child(state);
        content.add_child(top);

        const rtl = this.get_text_direction() === Clutter.TextDirection.RTL;
        const meta = new St.Label({
            style_class: 'froonty-calendar-card-meta',
            text: this._metaText(entry, rtl),
            x_expand: true,
        });
        content.add_child(meta);
        row.add_child(content);
        if (clickable)
            actor.set_child(row);
        else
            actor.add_child(row);

        const card = {entry, date, actor, bar, title, meta, state, provider, clickable};
        if (clickable)
            actor.connect('clicked', () => this._actions.open(card.entry, date));
        if (entry.item.cancelled)
            actor.add_style_class_name('froonty-calendar-card-cancelled');
        this._applyState(card, entry);
        return card;
    }

    _metaText(entry, rtl) {
        return [timeText(entry, this._clock, rtl), calendarName(entry.calendar),
            clean(entry.item.location)].filter(Boolean).join(' · ');
    }

    _applyState(card, entry) {
        const {actor, state} = card;
        if (entry.state === 'past')
            actor.add_style_class_name('froonty-calendar-card-past');
        else
            actor.remove_style_class_name('froonty-calendar-card-past');
        // St has no CSS opacity.
        actor.opacity = entry.state === 'past' || entry.item.cancelled ? 128 : 255;
        state.remove_style_class_name('froonty-calendar-state-now');
        state.remove_style_class_name('froonty-calendar-state-next');
        state.visible = entry.state === 'now' || entry.state === 'next';
        if (state.visible) {
            state.text = entry.state === 'now' ? _('Now') : _('Next');
            state.add_style_class_name(`froonty-calendar-state-${entry.state}`);
        }
        const parts = [clean(entry.item.title) || _('Untitled event'),
            timeText(entry, this._clock), calendarName(entry.calendar), clean(entry.item.location)];
        if (entry.item.cancelled)
            parts.push(_('cancelled'));
        if (state.visible)
            parts.push(state.text);
        if (card.clickable)
            parts.push(_('opens %s').format(card.provider.label));
        actor.accessible_name = parts.filter(Boolean).join(', ');
    }

    // Brings `target` to the top once laid out: its allocation is only
    // known after the next layout, and the scroll range with it, so the
    // scroll waits for that layout and is applied right after it, before
    // the frame is drawn.
    _scrollTo(target) {
        this._cancelScroll();
        const adjustment = this.scrollView.vadjustment;
        if (!target) {
            adjustment.value = 0;
            return;
        }
        this._anchor = target;
        this._anchorId = target.connect('notify::allocation', () => {
            if (this._laterId)
                return;
            this._laterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
                this._laterId = 0;
                const anchor = this._anchor;
                this._cancelScroll();
                if (anchor?.get_parent()) {
                    const y = anchor.get_allocation_box().y1;
                    adjustment.value = Math.max(0, Math.min(y, adjustment.upper - adjustment.page_size));
                }
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    _cancelScroll() {
        if (this._anchorId && this._anchor)
            this._anchor.disconnect(this._anchorId);
        this._anchorId = 0;
        this._anchor = null;
        if (this._laterId)
            global.compositor.get_laters().remove(this._laterId);
        this._laterId = 0;
    }
});
