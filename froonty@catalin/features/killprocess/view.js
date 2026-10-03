// SPDX-License-Identifier: GPL-3.0-or-later
// Kill Process tab (docs/features/kill-process.md): all of the user's
// processes, a filter, and a kill button per row.
//
//   [ Filter by name, command or PID   ] [CPU] [Memory] [Threads]
//   Your 256 processes
//   firefox          4242   12%   1.4 GiB   87   ⊘
//   sleep            5150  0.0%   1.0 MiB    1   [Kill “sleep”?] ✕
//
// Killing takes two clicks in the row: ⊘, then "Kill “name”?". Cancel
// (✕) takes ⊘'s place, so a double click on ⊘ cancels. A process that
// is still running FORCE_AFTER_S after it was asked to quit gets "Force
// quit" in that place. Protected processes (rules.js) have a lock instead.
//
// What is under the pointer stays put: while the pointer is on the list,
// a kill waits for its confirmation, or the keyboard has put the focus on
// a row, the rows keep their processes (their numbers still update) and
// are re-sorted only afterwards, so a click never lands on a process that
// has just moved there. A click never moves the focus into the list nor
// scrolls it; the keyboard does both (the focused row is scrolled into
// view, under the pointer too), and a row's buttons act only while some
// of the row is on screen.
//
// Only the rows on screen exist, and a few above and below them: a list
// of a thousand processes is a few dozen row actors, made once and reused
// as the list scrolls and re-sorts. A row keeps its process for as long
// as that process is among them, moving with it, so a refresh mostly
// updates numbers. Two spacers stand in for the rows above and below, so
// the scroll bar is right; every row is as tall as the others, so a
// process's place is its index times the row's height.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import St from 'gi://St';

import {gettext as _, ngettext} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Tooltip} from '../../core/tooltip.js';
import {countMatching, countText, rankProcesses} from './rules.js';

const DASH = '—';
// The name in "Kill “…”?", at most this long.
const CONFIRM_NAME = 18;
// The hover bubble's command line: lines of this width, at most this many.
const TOOLTIP_WIDTH = 64;
const TOOLTIP_LINES = 6;
// Rows made beyond each edge of the visible part, so a scroll shows rows
// that are ready.
const OVERSCAN = 4;
// Until the list has been laid out once: a row's height with the gap
// below it (the theme's 26 + 1 px), and how many rows fit (the default
// 440 px tab has room for about 14).
const FALLBACK_PITCH = 27;
const FALLBACK_ROWS = 14;
// The number columns, left to right; each is one of the sorts (rules.js SORTS).
const NUMBERS = ['cpu', 'memory', 'threads'];

const known = value => value !== null && value !== undefined;
const size = bytes => GLib.format_size_full(bytes, GLib.FormatSizeFlags.IEC_UNITS);
const shorten = (text, max) => text.length > max ? `${text.slice(0, max - 1)}…` : text;

// Whether the event being handled is a key's (Tab, Enter, Space) rather
// than a click's, or none: the keyboard may move the focus and the list,
// a click must not.
function byKeyboard() {
    const type = Clutter.get_current_event()?.type();
    return type === Clutter.EventType.KEY_PRESS || type === Clutter.EventType.KEY_RELEASE;
}

// Hard-wrapped (command lines are long paths with few spaces).
function wrap(text, width, lines) {
    const chunks = text.match(new RegExp(`[^]{1,${width}}`, 'g')) ?? [''];
    return chunks.length > lines
        ? [...chunks.slice(0, lines - 1), `${chunks[lines - 1].slice(0, width - 1)}…`].join('\n')
        : chunks.join('\n');
}

export class KillProcessView {
    constructor(service) {
        this._service = service;
        // On screen (setActive): nothing is sorted or filled while hidden.
        this._active = false;
        this._confirmKey = null;
        // Whether the keyboard (not a click) put the focus on a row.
        this._keyboardFocus = false;
        this._seenResult = null;
        this._sort = null;
        /** The processes listed, in order; the rows show a part of them. */
        this._shown = [];
        // The row actors, in list order: _rows[j] shows _shown[_first + j]
        // for j < _count, and the rest are hidden.
        this._rows = [];
        this._first = 0;
        this._count = 0;
        // The _shown the rows were last filled from.
        this._windowOf = null;
        // A row's height plus the gap below it, once measured.
        this._pitch = 0;
        this._renderLater = 0;
        // What the rows say, translated once here: the Shell's gettext for
        // extensions finds the extension from a stack trace at each call,
        // which a few dozen rows would otherwise pay at every refresh.
        this._texts = {
            percent: _('%s%%'),
            kill: _('Kill %s (process %d)'),
            confirm: _('Kill “%s”?'),
            confirmName: _('Confirm: kill %s (process %d)'),
            forceName: _('Force quit %s (process %d)'),
            force: _('Force quit'),
            cancel: _('Cancel'),
            states: {
                ended: _('Ended'),
                sending: _('Killing…'),
                ending: _('Asked to quit…'),
                stuck: _('Still running'),
                forcing: _('Force quitting…'),
            },
        };
        this._actions = {
            ask: row => this._ask(row),
            confirm: row => this._confirm(row),
            cancel: row => this._cancel(row),
            force: row => this._force(row),
            focus: row => this._onFocus(row),
        };

        // Content, plus an overlay layer (fixed positions, click-through)
        // for the hover bubble.
        this.actor = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });
        const content = new St.BoxLayout({
            style_class: 'froonty-killprocess',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
        });
        content.add_child(this._buildHeader());

        // How many processes there are, or how the latest kill went (until
        // the filter changes). One line that is always there: a line that
        // came and went would move the rows under the pointer.
        this._status = new St.Label({style_class: 'froonty-killprocess-status', x_expand: true});
        content.add_child(this._status);
        this._empty = new St.Label({style_class: 'froonty-killprocess-empty', x_expand: true});
        this._empty.clutter_text.line_wrap = true;
        content.add_child(this._empty);

        this._list = new St.BoxLayout({
            style_class: 'froonty-killprocess-list',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        // The rows above and below the ones that exist.
        this._top = new St.Widget({visible: false});
        this._bottom = new St.Widget({visible: false});
        this._list.add_child(this._top);
        this._list.add_child(this._bottom);
        this._scroll = new St.ScrollView({
            style_class: 'froonty-killprocess-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            overlay_scrollbars: true,
            track_hover: true,
            x_expand: true,
            y_expand: true,
        });
        this._scroll.add_child(this._list);
        // The pointer left the list: re-sort what it held in place.
        this._scroll.connect('notify::hover', () => this._sync());
        // Scrolled, or a new height: other rows are on screen.
        const adjustment = this._scroll.vadjustment;
        this._adjustmentIds = ['notify::value', 'notify::page-size'].map(signal =>
            adjustment.connect(signal, () => this._queueRender()));
        content.add_child(this._scroll);
        this.actor.add_child(content);

        this._tooltip = new Tooltip();
        const overlay = new St.Widget({x_expand: true, y_expand: true});
        overlay.add_child(this._tooltip.actor);
        this.actor.add_child(overlay);

        // Filled by setActive(true).
        this._serviceId = this._service.connect('changed', () => this._sync());
    }

    destroy() {
        this._active = false;
        this._service.disconnect(this._serviceId);
        for (const id of this._adjustmentIds)
            this._scroll.vadjustment.disconnect(id);
        this._cancelRender();
        this.actor.destroy();
    }

    /**
     * Shown: typing filters at once. Hidden: the filter and any
     * confirmation go, and nothing is sorted or filled until shown again
     * (the island may still be laid out while it collapses).
     */
    setActive(active) {
        this._active = active;
        if (active) {
            this._sync();
            this._filter.clutter_text.grab_key_focus();
            return;
        }
        this._tooltip.hide();
        this._confirmKey = null;
        this._filter.text = '';
        // A new visit starts at the top.
        this._scroll.vadjustment.value = 0;
        this._cancelRender();
    }

    _buildHeader() {
        const header = new St.BoxLayout({style_class: 'froonty-killprocess-header'});
        this._filter = new St.Entry({
            style_class: 'froonty-killprocess-filter',
            hint_text: _('Filter by name, command or PID'),
            can_focus: true,
            x_expand: true,
            primary_icon: new St.Icon({icon_name: 'edit-find-symbolic'}),
        });
        this._filter.clutter_text.connect('text-changed', () => {
            this._confirmKey = null;
            // Moving on: the count is news again.
            this._seenResult = this._service.lastResult;
            this._scroll.vadjustment.value = 0;
            this._sync(true);
        });
        header.add_child(this._filter);

        this._sortButtons = new Map();
        for (const [sort, label, name] of [
            ['cpu', _('CPU'), _('Sort by CPU load')],
            ['memory', _('Memory'), _('Sort by memory use')],
            ['threads', _('Threads'), _('Sort by number of threads')],
        ]) {
            const button = new St.Button({
                style_class: 'froonty-killprocess-sort',
                label,
                accessible_name: name,
                can_focus: true,
                track_hover: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            button.connect('clicked', () => this._service.setSort(sort));
            header.add_child(button);
            this._sortButtons.set(sort, button);
        }
        return header;
    }

    _ask(row) {
        if (!this._canAct(row) || row.process.ended || row.process.protected)
            return;
        const focus = this._focusFollows(row);
        this._confirmKey = row.process.key;
        this._sync();
        if (focus)
            row.focusConfirm();
    }

    _confirm(row) {
        const process = row.process;
        // Only the process this row asked about, and only if it still may be.
        if (!this._canAct(row) || process.key !== this._confirmKey || process.ended ||
            process.protected)
            return;
        this._confirmKey = null;
        this._service.kill(process);
        this._sync();
    }

    _cancel(row) {
        const focus = this._focusFollows(row);
        this._confirmKey = null;
        this._sync();
        if (focus)
            row.focusKill();
    }

    _force(row) {
        if (this._canAct(row))
            this._service.forceQuit(row.process);
    }

    // Whether a button of `row` may act: the row shows a process and some
    // of it is on screen. The rows just beyond the visible part exist too,
    // and Tab can reach them; a key pressed on one of those only scrolls
    // it into view, so nothing is asked about or killed unseen.
    _canAct(row) {
        if (!row.process)
            return false;
        if (this._onScreen(row))
            return true;
        if (byKeyboard())
            this._reveal(row);
        return false;
    }

    // Whether the focus should move to the button that takes the place of
    // the one used: when a key was pressed, or the focus is in the row
    // already (it would be lost with the button that hides). A click
    // elsewhere leaves it where it was, the filter usually: focus on a row
    // holds the list (see _held), which only the keyboard should do.
    _focusFollows(row) {
        const focus = this.actor.get_stage()?.get_key_focus() ?? null;
        return byKeyboard() || (focus !== null && row.contains(focus));
    }

    /** @param {boolean} [rerank] re-sort even under the pointer (filter typed) */
    _sync(rerank = false) {
        if (!this._active)
            return;
        const service = this._service;
        for (const [sort, button] of this._sortButtons)
            button.checked = sort === service.sort;
        if (service.sort !== this._sort) {
            // Another sort: its first processes, from the top.
            if (this._sort !== null)
                this._scroll.vadjustment.value = 0;
            this._sort = service.sort;
            rerank = true;
        }

        const processes = service.processes;
        if (processes === null) {
            this._showStatus(_('Reading your processes…'));
            this._shown = [];
            this._renderWindow();
            this._showEmpty('');
            return;
        }

        const filter = this._filter.text.trim();
        let matching;
        if (rerank || !this._held()) {
            this._shown = rankProcesses(processes, {sort: service.sort, filter});
            matching = this._shown.length;
        } else {
            // The same processes, with today's numbers; one that is gone
            // stays, marked as ended, until the list is re-sorted.
            const byKey = new Map(processes.map(process => [process.key, process]));
            this._shown = this._shown.map(process => byKey.get(process.key) ??
                (process.ended ? process : {...process, cpu: null, ended: true}));
            // The count is of today's processes, not of the rows held.
            matching = countMatching(processes, filter);
        }
        if (this._confirmKey !== null &&
            !this._shown.some(process => process.key === this._confirmKey && !process.ended))
            this._confirmKey = null;
        this._renderWindow();

        this._showStatus(countText(processes.length, matching, Boolean(filter), ngettext));
        // Only once nothing is listed: a line that came while rows are held
        // would move them under the pointer.
        this._showEmpty(filter && this._shown.length === 0
            ? _('None of your processes matches “%s”.').format(filter) : '');
    }

    // Whether the rows keep their processes: the pointer is on the list, a
    // kill waits for its confirmation, or the keyboard put the focus on a
    // row. Focus that a click left there does not count: the list would
    // stay unsorted, with no end, after the pointer left.
    _held() {
        if (this._shown.length === 0)
            return false;
        return this._scroll.hover || this._confirmKey !== null ||
            (this._keyboardFocus && this._focusedRow() !== null);
    }

    // The row that has the keyboard focus, or null.
    _focusedRow() {
        const focus = this.actor.get_stage()?.get_key_focus() ?? null;
        if (!focus || !this._list.contains(focus))
            return null;
        return this._rows.find(row => row.contains(focus)) ?? null;
    }

    // A scroll or a new height (both may come in the middle of a layout
    // pass): the rows are filled before the next frame instead. Not while
    // hidden: a collapsing island still changes the list's height.
    _queueRender() {
        if (!this._active || this._renderLater)
            return;
        this._renderLater = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._renderLater = 0;
            this._renderWindow();
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelRender() {
        if (this._renderLater)
            global.compositor.get_laters().remove(this._renderLater);
        this._renderLater = 0;
    }

    // Fills the rows with the processes around the visible part of the
    // list (see the file comment), and sizes the spacers for the others.
    _renderWindow() {
        const shown = this._shown;
        const total = shown.length;
        const adjustment = this._scroll.vadjustment;
        const pitch = this._pitch || FALLBACK_PITCH;
        const page = adjustment.page_size > 0 ? adjustment.page_size : FALLBACK_ROWS * pitch;
        const count = Math.min(total, Math.ceil(page / pitch) + 1 + 2 * OVERSCAN);
        const first = Math.max(0, Math.min(total - count,
            Math.floor(adjustment.value / pitch) - OVERSCAN));
        if (shown === this._windowOf && first === this._first && count === this._count)
            return;
        this._windowOf = shown;
        this._first = first;
        this._count = count;

        while (this._rows.length < count) {
            const row = new ProcessRow(this._actions, this._tooltip, this._texts);
            this._list.insert_child_below(row, this._bottom);
            this._rows.push(row);
        }
        const focused = this._focusedRow();
        const focusedKey = focused?.process?.key;
        const wanted = shown.slice(first, first + count);
        this._placeRows(wanted);
        this._rows.forEach((row, j) => {
            const process = wanted[j];
            if (process) {
                row.update(process, this._service.killState(process.key),
                    process.key === this._confirmKey, this._sort);
            } else {
                row.clear();
            }
        });
        // The focused row now shows another process: the focus goes back
        // to the filter rather than stay on a button for that one.
        if (focused && focused.process?.key !== focusedKey)
            this._filter.clutter_text.grab_key_focus();

        const gap = this._list.layout_manager?.spacing ?? 0;
        this._sizeSpacer(this._top, first * pitch - gap);
        this._sizeSpacer(this._bottom, (total - first - count) * pitch - gap);
        this._scroll.visible = total > 0;

        // The rows' real height, once the theme has laid one out.
        if (count > 0 && this._list.mapped) {
            const [, height] = this._rows[0].get_preferred_height(-1);
            if (height > 0 && height + gap !== this._pitch) {
                this._pitch = height + gap;
                this._windowOf = null;
                this._queueRender();
            }
        }
    }

    // Puts the rows in the order of `wanted` (processes), each process in
    // the row that already shows it if there is one; the rows left over
    // take the other processes, then the hidden ones go last. Scrolling by
    // a row moves one row actor, and a re-sort moves actors rather than
    // rewrite their texts.
    _placeRows(wanted) {
        const byKey = new Map();
        for (const row of this._rows) {
            if (row.process)
                byKey.set(row.process.key, row);
        }
        const placed = wanted.map(process => {
            const row = byKey.get(process.key) ?? null;
            byKey.delete(process.key);
            return row;
        });
        const taken = new Set(placed);
        const free = this._rows.filter(row => !taken.has(row));
        // The free rows go to the end first (those not there yet), so that
        // the rows that keep their processes keep their order too.
        let next = this._bottom;
        for (const row of [...free].reverse()) {
            if (row.get_next_sibling() !== next)
                this._list.set_child_below_sibling(row, next);
            next = row;
        }
        const order = placed.map(row => row ?? free.shift());
        let previous = this._top;
        for (const row of order) {
            if (row.get_previous_sibling() !== previous)
                this._list.set_child_above_sibling(row, previous);
            previous = row;
        }
        this._rows = [...order, ...free];
    }

    _sizeSpacer(spacer, height) {
        spacer.visible = height > 0;
        if (height > 0)
            spacer.height = height;
    }

    // The key focus moved to a button of `row`. Moved there by the
    // keyboard, it holds the list (see _held), and the row is scrolled
    // into view even under the pointer, so Tab walks the whole list and
    // never stops on a row out of sight. Moved there otherwise (a click),
    // the list moves only if the pointer is not on it.
    _onFocus(row) {
        this._keyboardFocus = byKeyboard();
        if (this._keyboardFocus || !this._scroll.hover)
            this._reveal(row);
    }

    // Where `row` is in the list, top and bottom, or null when it shows
    // nothing (see the file comment: a process's place is its index times
    // a row's height).
    _span(row) {
        const index = this._rows.indexOf(row);
        if (index < 0 || index >= this._count)
            return null;
        const pitch = this._pitch || FALLBACK_PITCH;
        const top = (this._first + index) * pitch;
        return {top, bottom: top + pitch};
    }

    // Whether some of `row` is in the visible part of the list.
    _onScreen(row) {
        const span = this._span(row);
        const {value, page_size: page} = this._scroll.vadjustment;
        return span !== null && page > 0 && span.bottom > value && span.top < value + page;
    }

    // Scrolls the list so that all of `row` is in view.
    _reveal(row) {
        const span = this._span(row);
        if (!span)
            return;
        const adjustment = this._scroll.vadjustment;
        if (span.top < adjustment.value)
            adjustment.value = span.top;
        else if (span.bottom > adjustment.value + adjustment.page_size)
            adjustment.value = span.bottom - adjustment.page_size;
    }

    // The latest kill's outcome while it is news, otherwise `summary`.
    _showStatus(summary) {
        const result = this._service.lastResult;
        const news = result && result !== this._seenResult ? resultText(result) : '';
        this._status.text = news || summary;
        if (news)
            this._status.add_style_class_name('froonty-killprocess-news');
        else
            this._status.remove_style_class_name('froonty-killprocess-news');
    }

    _showEmpty(text) {
        this._empty.text = text;
        this._empty.visible = Boolean(text);
    }
}

// What became of the latest kill, for the status line.
function resultText(result) {
    if (!result)
        return '';
    const {outcome, name, pid} = result;
    switch (outcome) {
    case 'ended':
        return _('“%s” (%d) has ended.').format(name, pid);
    case 'gone':
        return _('“%s” (%d) had already ended.').format(name, pid);
    case 'protected':
        return _('“%s” is part of your session; Froonty never kills it.').format(name);
    case 'not-yours':
    case 'invalid':
        return _('“%s” is not one of your processes; Froonty only kills yours.').format(name);
    case 'no-tool':
        return _('Killing needs /usr/bin/kill (procps), which is missing.');
    default:
        return _('Could not kill “%s” (%d).').format(name, pid);
    }
}

// One process: name and id, CPU, memory, threads, and what can be done
// with it. Reused for whichever process it shows (update()), and only
// what changed is set: a refresh touches a few labels, not every part.
const ProcessRow = GObject.registerClass(
class ProcessRow extends St.BoxLayout {
    /**
     * @param {object} actions ask, confirm, cancel, force and focus, each
     *   called with the row
     * @param {Tooltip} tooltip the view's hover bubble
     * @param {object} texts the view's translated texts
     */
    _init(actions, tooltip, texts) {
        super._init({style_class: 'froonty-killprocess-row', x_expand: true});
        /** The process shown (ProcessSampler.sample), or null. */
        this.process = null;
        this._kill = null;
        this._texts = texts;
        // Its parts by name, and the value each property was last set to.
        this._parts = {};
        this._values = new Map();
        const part = actor => {
            this._parts[actor.name] = actor;
            return actor;
        };

        const info = new St.BoxLayout({
            name: 'info',
            style_class: 'froonty-killprocess-info',
            reactive: true,
            track_hover: true,
            x_expand: true,
        });
        info.add_child(part(new St.Label({
            name: 'name',
            style_class: 'froonty-killprocess-name',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        })));
        info.add_child(part(new St.Label({
            name: 'pid',
            style_class: 'froonty-killprocess-pid',
            y_align: Clutter.ActorAlign.CENTER,
        })));
        tooltip.attach(info, () => this._bubble(), 'below');
        this.add_child(part(info));

        for (const name of NUMBERS) {
            this.add_child(part(new St.Label({
                name,
                style_class: `froonty-killprocess-number froonty-killprocess-${name}`,
                y_align: Clutter.ActorAlign.CENTER,
            })));
        }

        const state = new St.Label({
            name: 'state',
            style_class: 'froonty-killprocess-state',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const confirm = new St.Button({
            name: 'confirm',
            style_class: 'froonty-killprocess-confirm',
            can_focus: true,
            track_hover: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const force = new St.Button({
            name: 'force',
            style_class: 'froonty-killprocess-confirm froonty-killprocess-force',
            label: texts.force,
            can_focus: true,
            track_hover: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const lock = new St.Icon({
            name: 'lock',
            style_class: 'froonty-killprocess-lock',
            icon_name: 'changes-prevent-symbolic',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const kill = new St.Button({
            name: 'kill',
            style_class: 'froonty-icon-button froonty-killprocess-kill',
            can_focus: true,
            track_hover: true,
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({icon_name: 'process-stop-symbolic'}),
        });
        const cancel = new St.Button({
            name: 'cancel',
            style_class: 'froonty-icon-button froonty-killprocess-cancel',
            accessible_name: texts.cancel,
            can_focus: true,
            track_hover: true,
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({icon_name: 'window-close-symbolic'}),
        });

        kill.connect('clicked', () => actions.ask(this));
        confirm.connect('clicked', () => actions.confirm(this));
        cancel.connect('clicked', () => actions.cancel(this));
        force.connect('clicked', () => actions.force(this));
        // The keyboard focus came to the row: the list shows it.
        kill.connect('key-focus-in', () => actions.focus(this));
        confirm.connect('key-focus-in', () => actions.focus(this));
        cancel.connect('key-focus-in', () => actions.focus(this));
        force.connect('key-focus-in', () => actions.focus(this));
        // Left to right; the last one sits where ⊘ was (see the file comment).
        for (const actor of [state, confirm, force, lock, kill, cancel])
            this.add_child(part(actor));
    }

    _part(name) {
        return this._parts[name] ?? null;
    }

    // Sets a part's property (or style class, '.name'; '' is the row
    // itself), unless it already has that value.
    _set(name, property, value) {
        const id = `${name}:${property}`;
        if (this._values.get(id) === value)
            return;
        this._values.set(id, value);
        const actor = name ? this._parts[name] : this;
        if (!property.startsWith('.'))
            actor[property] = value;
        else if (value)
            actor.add_style_class_name(property.slice(1));
        else
            actor.remove_style_class_name(property.slice(1));
    }

    // A number column's text, formatted only when its value changed.
    _number(name, value, format) {
        const id = `${name}:value`;
        if (this._values.has(id) && this._values.get(id) === value)
            return;
        this._values.set(id, value);
        this._set(name, 'text', known(value) ? format(value) : DASH);
    }

    /** Shows no process (a row the window does not need now). */
    clear() {
        this.process = null;
        this._kill = null;
        this._set('', 'visible', false);
    }

    /**
     * @param {object} process from ProcessSampler.sample, `ended` when gone
     * @param {?object} kill the service's killState for it
     * @param {boolean} confirming its kill waits for confirmation
     * @param {string} sort the list's sort, whose column stands out
     */
    update(process, kill, confirming, sort) {
        this.process = process;
        this._kill = kill;
        const mode = process.ended ? 'ended'
            : process.protected ? 'protected'
            : confirming ? 'confirm'
            : kill?.phase ?? 'idle';
        this._set('', 'visible', true);

        // Texts that name the process: only when it is another process (or
        // it renamed itself).
        const texts = this._texts;
        if (this._values.get('key') !== process.key ||
            this._values.get('name:text') !== process.name) {
            this._values.set('key', process.key);
            const {name, pid} = process;
            this._set('name', 'text', name);
            this._set('pid', 'text', String(pid));
            this._set('kill', 'accessible_name', texts.kill.format(name, pid));
            this._set('confirm', 'label', texts.confirm.format(shorten(name, CONFIRM_NAME)));
            this._set('confirm', 'accessible_name', texts.confirmName.format(name, pid));
            this._set('force', 'accessible_name', texts.forceName.format(name, pid));
        }
        this._number('cpu', process.cpu, cpu =>
            texts.percent.format(cpu < 10 ? cpu.toFixed(1) : String(Math.round(cpu))));
        this._number('memory', process.ended ? null : process.memory, size);
        this._number('threads', process.ended ? null : process.threads, String);
        if (this._values.get('sort') !== sort) {
            this._values.set('sort', sort);
            for (const name of NUMBERS)
                this._set(name, '.froonty-killprocess-sorted', name === sort);
        }
        if (this._values.get('mode') === mode)
            return;
        this._values.set('mode', mode);

        this._set('', '.froonty-killprocess-ended', mode === 'ended');
        // An action needs the room; the numbers can wait.
        const numbers = mode !== 'confirm' && mode !== 'stuck';
        for (const name of NUMBERS)
            this._set(name, 'visible', numbers);
        const state = texts.states[mode] ?? '';
        this._set('state', 'text', state);
        this._set('state', 'visible', state !== '');
        this._set('lock', 'visible', mode === 'protected');
        this._set('kill', 'visible', mode === 'idle');
        this._set('confirm', 'visible', mode === 'confirm');
        this._set('cancel', 'visible', mode === 'confirm');
        this._set('force', 'visible', mode === 'stuck');
    }

    focusConfirm() {
        this._part('confirm').grab_key_focus();
    }

    focusKill() {
        this._part('kill').grab_key_focus();
    }

    // The whole command line, and why a process cannot be killed here.
    _bubble() {
        const process = this.process;
        if (!process)
            return null;
        const lines = [wrap(process.command, TOOLTIP_WIDTH, TOOLTIP_LINES),
            ngettext('Process %d, %d thread', 'Process %d, %d threads', process.threads)
                .format(process.pid, process.threads)];
        if (process.protected === 'shell')
            lines.push(_('GNOME Shell itself, which Froonty runs in: never killed from here.'));
        else if (process.protected)
            lines.push(_('Part of your session: killing it would end the session or break the desktop, so it is never killed from here.'));
        else if (this._kill?.phase === 'stuck')
            lines.push(_('It did not quit when asked. Force quit ends it at once; unsaved work is lost.'));
        return lines.join('\n');
    }
});
