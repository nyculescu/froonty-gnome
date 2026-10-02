// SPDX-License-Identifier: GPL-3.0-or-later
// Kill Process tab (docs/features/kill-process.md): the user's busiest
// processes, a filter, and a kill button per row.
//
//   [ Filter by name, command or PID          ] [CPU] [Memory]
//   Top 30 of your 256 processes
//   firefox          4242   12%   1.4 GiB   ⊘
//   sleep            5150  0.0%   1.0 MiB   [Kill “sleep”?] ✕
//
// Killing takes two clicks in the row: ⊘, then "Kill “name”?". Cancel
// (✕) takes ⊘'s place, so a double click on ⊘ cancels. A process that
// is still running FORCE_AFTER_S after it was asked to quit gets "Force
// quit" in that place. Protected processes (rules.js) have a lock instead.
//
// What is under the pointer stays put: while the pointer is on the list,
// or a kill waits for its confirmation, the rows keep their processes
// (their numbers still update) and are re-sorted only afterwards, so a
// click never lands on a process that has just moved there. Rows are
// made as needed and reused.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Tooltip} from '../../core/tooltip.js';
import {rankProcesses} from './rules.js';

/** The most rows the tab shows; the filter finds the others. */
export const ROW_LIMIT = 30;
const DASH = '—';
// The name in "Kill “…”?", at most this long.
const CONFIRM_NAME = 18;
// The hover bubble's command line: lines of this width, at most this many.
const TOOLTIP_WIDTH = 64;
const TOOLTIP_LINES = 6;

const known = value => value !== null && value !== undefined;
const size = bytes => GLib.format_size_full(bytes, GLib.FormatSizeFlags.IEC_UNITS);
const shorten = (text, max) => text.length > max ? `${text.slice(0, max - 1)}…` : text;

function cpuText(cpu) {
    if (!known(cpu))
        return DASH;
    return _('%s%%').format(cpu < 10 ? cpu.toFixed(1) : String(Math.round(cpu)));
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
        this._confirmKey = null;
        this._seenResult = null;
        this._sort = null;
        this._matching = 0;
        this._rows = [];
        this._actions = {
            ask: row => this._ask(row),
            confirm: row => this._confirm(row),
            cancel: row => this._cancel(row),
            force: row => this._service.forceQuit(row.process),
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
        content.add_child(this._scroll);
        this.actor.add_child(content);

        this._tooltip = new Tooltip();
        const overlay = new St.Widget({x_expand: true, y_expand: true});
        overlay.add_child(this._tooltip.actor);
        this.actor.add_child(overlay);

        this._serviceId = this._service.connect('changed', () => this._sync());
        this._sync();
    }

    destroy() {
        this._service.disconnect(this._serviceId);
        this.actor.destroy();
    }

    /** Shown: typing filters at once. Hidden: the filter and any confirmation go. */
    setActive(active) {
        if (active) {
            this._sync();
            this._filter.clutter_text.grab_key_focus();
            return;
        }
        this._tooltip.hide();
        this._confirmKey = null;
        this._filter.text = '';
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
            this._sync(true);
        });
        header.add_child(this._filter);

        this._sortButtons = new Map();
        for (const [sort, label, name] of [
            ['cpu', _('CPU'), _('Sort by CPU use')],
            ['memory', _('Memory'), _('Sort by memory use')],
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
        if (!row.process || row.process.ended || row.process.protected)
            return;
        this._confirmKey = row.process.key;
        this._sync();
        row.focusConfirm();
    }

    _confirm(row) {
        const process = row.process;
        // Only the process this row asked about, and only if it still may be.
        if (!process || process.key !== this._confirmKey || process.ended || process.protected)
            return;
        this._confirmKey = null;
        this._service.kill(process);
        this._sync();
    }

    _cancel(row) {
        this._confirmKey = null;
        this._sync();
        row.focusKill();
    }

    /** @param {boolean} [rerank] re-sort even under the pointer (filter typed) */
    _sync(rerank = false) {
        const service = this._service;
        for (const [sort, button] of this._sortButtons)
            button.checked = sort === service.sort;
        if (service.sort !== this._sort) {
            this._sort = service.sort;
            rerank = true;
        }

        const processes = service.processes;
        if (processes === null) {
            this._showStatus(_('Reading your processes…'));
            this._showRows([]);
            this._showEmpty('');
            return;
        }

        const filter = this._filter.text.trim();
        const visible = this._rows.filter(row => row.visible && row.process);
        const held = !rerank && visible.length > 0 &&
            (this._scroll.hover || this._confirmKey !== null);
        let shown;
        if (held) {
            // The same processes, with today's numbers; one that is gone
            // stays, marked as ended, until the list is re-sorted.
            const byKey = new Map(processes.map(process => [process.key, process]));
            shown = visible.map(row => byKey.get(row.process.key) ??
                {...row.process, cpu: null, ended: true});
        } else {
            const ranked = rankProcesses(processes, {sort: service.sort, filter, limit: ROW_LIMIT});
            shown = ranked.shown;
            this._matching = ranked.matching;
        }
        if (!shown.some(process => process.key === this._confirmKey && !process.ended))
            this._confirmKey = null;
        this._showRows(shown);

        const total = processes.length;
        if (filter)
            this._showStatus(_('%d of your %d processes match').format(this._matching, total));
        else if (total > ROW_LIMIT)
            this._showStatus(_('Top %d of your %d processes').format(ROW_LIMIT, total));
        else
            this._showStatus(_('Your %d processes').format(total));
        this._showEmpty(filter && this._matching === 0
            ? _('None of your processes matches “%s”.').format(filter) : '');
    }

    _showRows(shown) {
        while (this._rows.length < shown.length) {
            const row = new ProcessRow(this._actions, this._tooltip);
            this._list.add_child(row);
            this._rows.push(row);
        }
        this._rows.forEach((row, i) => {
            const process = shown[i] ?? null;
            row.visible = process !== null;
            if (process) {
                row.update(process, this._service.killState(process.key),
                    process.key === this._confirmKey);
            }
        });
        this._scroll.visible = shown.length > 0;
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

// One process: name and id, CPU, memory, and what can be done with it.
// Reused for whichever process it shows (update()); its parts are found
// by name, so it holds no references of its own to release.
const ProcessRow = GObject.registerClass(
class ProcessRow extends St.BoxLayout {
    /**
     * @param {object} actions ask, confirm, cancel and force, each called with the row
     * @param {Tooltip} tooltip the view's hover bubble
     */
    _init(actions, tooltip) {
        super._init({style_class: 'froonty-killprocess-row', x_expand: true});
        /** The process shown (ProcessSampler.sample), or null. */
        this.process = null;
        this._kill = null;

        const info = new St.BoxLayout({
            name: 'info',
            style_class: 'froonty-killprocess-info',
            reactive: true,
            track_hover: true,
            x_expand: true,
        });
        info.add_child(new St.Label({
            name: 'name',
            style_class: 'froonty-killprocess-name',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        info.add_child(new St.Label({
            name: 'pid',
            style_class: 'froonty-killprocess-pid',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        tooltip.attach(info, () => this._bubble(), 'below');
        this.add_child(info);

        for (const name of ['cpu', 'memory']) {
            this.add_child(new St.Label({
                name,
                style_class: `froonty-killprocess-number froonty-killprocess-${name}`,
                y_align: Clutter.ActorAlign.CENTER,
            }));
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
            label: _('Force quit'),
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
            accessible_name: _('Cancel'),
            can_focus: true,
            track_hover: true,
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({icon_name: 'window-close-symbolic'}),
        });

        kill.connect('clicked', () => actions.ask(this));
        confirm.connect('clicked', () => actions.confirm(this));
        cancel.connect('clicked', () => actions.cancel(this));
        force.connect('clicked', () => actions.force(this));
        // Left to right; the last one sits where ⊘ was (see the file comment).
        for (const actor of [state, confirm, force, lock, kill, cancel])
            this.add_child(actor);
    }

    _part(name) {
        return this.get_children().flatMap(child => [child, ...child.get_children()])
            .find(child => child.name === name) ?? null;
    }

    /**
     * @param {object} process from ProcessSampler.sample, `ended` when gone
     * @param {?object} kill the service's killState for it
     * @param {boolean} confirming its kill waits for confirmation
     */
    update(process, kill, confirming) {
        this.process = process;
        this._kill = kill;
        const mode = process.ended ? 'ended'
            : process.protected ? 'protected'
            : confirming ? 'confirm'
            : kill?.phase ?? 'idle';

        this._part('name').text = process.name;
        this._part('pid').text = String(process.pid);
        // An action needs the room; the numbers can wait.
        const numbers = mode !== 'confirm' && mode !== 'stuck';
        const cpu = this._part('cpu');
        const memory = this._part('memory');
        cpu.text = cpuText(process.cpu);
        memory.text = process.ended ? DASH : size(process.memory);
        cpu.visible = memory.visible = numbers;
        if (process.ended)
            this.add_style_class_name('froonty-killprocess-ended');
        else
            this.remove_style_class_name('froonty-killprocess-ended');

        const state = this._part('state');
        state.text = {
            ended: _('Ended'),
            sending: _('Killing…'),
            ending: _('Asked to quit…'),
            stuck: _('Still running'),
            forcing: _('Force quitting…'),
        }[mode] ?? '';
        state.visible = Boolean(state.text);
        this._part('lock').visible = mode === 'protected';
        this._part('kill').visible = mode === 'idle';
        this._part('kill').accessible_name = _('Kill %s (process %d)').format(process.name, process.pid);
        const confirm = this._part('confirm');
        confirm.visible = mode === 'confirm';
        confirm.label = _('Kill “%s”?').format(shorten(process.name, CONFIRM_NAME));
        confirm.accessible_name = _('Confirm: kill %s (process %d)').format(process.name, process.pid);
        this._part('cancel').visible = mode === 'confirm';
        const force = this._part('force');
        force.visible = mode === 'stuck';
        force.accessible_name = _('Force quit %s (process %d)').format(process.name, process.pid);
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
            _('Process %d').format(process.pid)];
        if (process.protected === 'shell')
            lines.push(_('GNOME Shell itself, which Froonty runs in: never killed from here.'));
        else if (process.protected)
            lines.push(_('Part of your session: killing it would end the session or break the desktop, so it is never killed from here.'));
        else if (this._kill?.phase === 'stuck')
            lines.push(_('It did not quit when asked. Force quit ends it at once; unsaved work is lost.'));
        return lines.join('\n');
    }
});
