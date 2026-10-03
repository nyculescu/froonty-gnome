// SPDX-License-Identifier: GPL-3.0-or-later
// Writing tab (docs/features/writing.md §7):
//
//   [Claude Code][LanguageTool][Ollama]     engines switched on in Settings
//   Sends to Anthropic, through your Claude Code (Haiku · your plan's usage)
//   ┌ text box ───────────────────────────┐
//   └─────────────────────────────────────┘
//   [From clipboard] [Clear]        1,234 / 20,000
//   [Paraphrase][Fix grammar][Shorten]      the chosen engine's actions
//   [Formal][Casual][Summarise]
//   busy: "Rewriting with Claude Code…" [Cancel] · error · result + [Copy]
//
// Engine text is shown as plain text (never Pango markup), and goes on the
// clipboard only when Copy is clicked. While Ollama streams, what it has
// written so far shows in the result area. Renders WritingService state;
// text is only replaced when it differs, so a 'changed' (each keystroke
// emits one) neither re-lays out a long result nor clears a selection in
// it.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {gettext as _, ngettext} from 'resource:///org/gnome/shell/extensions/extension.js';

import {keepCursorVisible} from '../../core/textScroll.js';
import {Tooltip} from '../../core/tooltip.js';
import {ACTIONS, measure} from './actions.js';

const ROW_SIZE = 3;

const group = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

// Clutter.Text lays itself out again on every set_text unless it is
// editable and the text is the same.
function setText(actor, text) {
    if (actor.text !== text)
        actor.text = text;
}

function setLabel(button, text) {
    if (button.label !== text)
        button.label = text;
}

function wrapping(label) {
    label.clutter_text.line_wrap = true;
    label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
    label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    return label;
}

function textButton(styleClass, text) {
    return new St.Button({
        style_class: `froonty-writing-button ${styleClass}`,
        label: text,
        can_focus: true,
        track_hover: true,
    });
}

// A multi-line St.Entry in a vertical scroll view, as the Notes editor.
function textArea(styleClass, hint, editable) {
    const entry = new St.Entry({
        style_class: `froonty-writing-text ${styleClass}`,
        hint_text: hint,
        can_focus: true,
        x_expand: true,
        y_align: Clutter.ActorAlign.START,
    });
    const text = entry.clutter_text;
    text.single_line_mode = false;
    text.activatable = false;
    text.line_wrap = true;
    text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
    text.use_markup = false;
    if (!editable) {
        text.editable = false;
        text.selectable = true;
        text.cursor_visible = false;
    }
    const box = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL,
        x_expand: true,
        y_expand: true,
        reactive: true,
    });
    box.add_child(entry);
    box.connect('button-press-event', () => {
        text.grab_key_focus();
        return Clutter.EVENT_PROPAGATE;
    });
    const scroll = new St.ScrollView({
        style_class: `froonty-writing-scroll ${styleClass}-scroll`,
        hscrollbar_policy: St.PolicyType.NEVER,
        vscrollbar_policy: St.PolicyType.AUTOMATIC,
        overlay_scrollbars: true,
        x_expand: true,
        y_expand: true,
        child: box,
    });
    return {entry, box, scroll};
}

export class WritingView {
    constructor(ctx, service) {
        this._ctx = ctx;
        this._service = service;
        this._syncing = false;
        this._copied = false;

        this.actor = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });
        this._main = new St.BoxLayout({
            style_class: 'froonty-writing',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
        });
        this.actor.add_child(this._main);
        this._buildEmpty();
        this.actor.add_child(this._empty);

        this._engineRow = new St.BoxLayout({style_class: 'froonty-writing-engines'});
        this._engineButtons = new Map();
        this._main.add_child(this._engineRow);
        this._destination = wrapping(new St.Label({style_class: 'froonty-writing-destination'}));
        this._main.add_child(this._destination);

        const input = textArea('froonty-writing-input', _('Type or paste text (Ctrl+V)'), true);
        this._input = input.entry;
        this._inputScroll = input.scroll;
        this._input.clutter_text.connect('text-changed', () => {
            if (!this._syncing)
                this._service.setInput(this._input.text);
        });
        // A scroll view does not follow the caret: typing or pasting past
        // the bottom of the box would go on out of sight.
        this._input.clutter_text.connect('cursor-changed',
            () => keepCursorVisible(this._input, this._inputScroll));
        this._main.add_child(this._inputScroll);

        const tools = new St.BoxLayout({style_class: 'froonty-writing-tools'});
        this._clipboardButton = textButton('froonty-writing-small', _('From clipboard'));
        this._clipboardButton.connect('clicked', () => this._service.fromClipboard());
        this._clearButton = textButton('froonty-writing-small', _('Clear'));
        this._clearButton.connect('clicked', () => {
            this._service.clear();
            this._focusInput();
        });
        this._counter = new St.Label({
            style_class: 'froonty-writing-counter',
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });
        tools.add_child(this._clipboardButton);
        tools.add_child(this._clearButton);
        tools.add_child(this._counter);
        this._main.add_child(tools);

        this._actionsBox = new St.BoxLayout({
            style_class: 'froonty-writing-actions',
            orientation: Clutter.Orientation.VERTICAL,
        });
        this._actionButtons = new Map();
        for (const action of ACTIONS) {
            const button = textButton('froonty-writing-action', _(action.label));
            button.connect('clicked', () => this._service.run(action.id));
            this._actionButtons.set(action.id, button);
        }
        this._main.add_child(this._actionsBox);

        this._buildStatus();

        this._tooltip = new Tooltip();
        const overlay = new St.Widget({x_expand: true, y_expand: true});
        overlay.add_child(this._tooltip.actor);
        this.actor.add_child(overlay);

        this._serviceId = this._service.connect('changed', () => this._sync());
        this._sync();
    }

    destroy() {
        this._service.disconnect(this._serviceId);
        for (const button of this._actionButtons.values())
            button.destroy();
        this.actor.destroy();
    }

    setActive(active) {
        if (!active) {
            this._tooltip.hide();
            return;
        }
        this._focusInput();
    }

    _focusInput() {
        if (this._main.visible)
            this._input.clutter_text.grab_key_focus();
    }

    _buildEmpty() {
        this._empty = new St.BoxLayout({
            style_class: 'froonty-writing-empty',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._emptyLabel = wrapping(new St.Label({
            style_class: 'froonty-writing-empty-text',
            x_align: Clutter.ActorAlign.CENTER,
        }));
        this._settingsButton = textButton('froonty-writing-settings', _('Open Settings → Writing'));
        this._settingsButton.x_align = Clutter.ActorAlign.CENTER;
        this._settingsButton.connect('clicked', () => this._ctx.openSettings?.('writing'));
        this._empty.add_child(this._emptyLabel);
        this._empty.add_child(this._settingsButton);
    }

    _buildStatus() {
        this._busy = new St.BoxLayout({style_class: 'froonty-writing-busy', visible: false});
        this._busy.add_child(new St.Icon({
            style_class: 'froonty-writing-spinner',
            icon_name: 'process-working-symbolic',
        }));
        this._busyLabel = new St.Label({
            style_class: 'froonty-writing-busy-text',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._busyLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._busy.add_child(this._busyLabel);
        this._cancelButton = textButton('froonty-writing-small', _('Cancel'));
        this._cancelButton.connect('clicked', () => this._service.cancel());
        this._busy.add_child(this._cancelButton);
        this._main.add_child(this._busy);

        this._error = wrapping(new St.Label({style_class: 'froonty-writing-error', visible: false}));
        this._main.add_child(this._error);
        this._notice = wrapping(new St.Label({style_class: 'froonty-writing-notice', visible: false}));
        this._main.add_child(this._notice);

        const result = textArea('froonty-writing-result', '', false);
        this._result = result.entry;
        this._resultScroll = result.scroll;
        this._changes = wrapping(new St.Label({style_class: 'froonty-writing-changes', visible: false}));
        result.box.add_child(this._changes);
        this._main.add_child(this._resultScroll);

        const resultTools = new St.BoxLayout({style_class: 'froonty-writing-tools'});
        this._copyButton = textButton('froonty-writing-copy', _('Copy'));
        this._copyButton.connect('clicked', () => this._copy());
        this._attribution = new St.Button({
            style_class: 'froonty-writing-link',
            can_focus: true,
            track_hover: true,
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
        });
        this._attribution.connect('clicked', () => this._openAttribution());
        resultTools.add_child(this._copyButton);
        resultTools.add_child(this._attribution);
        this._resultTools = resultTools;
        this._main.add_child(resultTools);
    }

    _copy() {
        const text = this._service.result?.text;
        if (!text)
            return;
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
        this._copied = true;
        this._copyButton.label = _('Copied');
    }

    // LanguageTool's conditions ask for a visible link to it.
    _openAttribution() {
        const url = this._service.result?.attribution?.url;
        if (!url)
            return;
        this._ctx.collapse?.();
        try {
            Gio.AppInfo.launch_default_for_uri(url, global.create_app_launch_context(0, -1));
        } catch (e) {
            console.warn(`Froonty: cannot open ${url}: ${e.message}`);
        }
    }

    _syncEngines(engines, selected, busy) {
        const ids = engines.map(e => e.id).join(',');
        if (ids !== this._engineIds) {
            this._engineIds = ids;
            this._engineRow.destroy_all_children();
            this._engineButtons.clear();
            for (const {id, title} of engines) {
                const button = new St.Button({
                    style_class: 'froonty-writing-engine',
                    label: title,
                    can_focus: true,
                    track_hover: true,
                    toggle_mode: true,
                });
                button.connect('clicked', () => {
                    const entry = this._service.enabledEngines.find(e => e.id === id);
                    if (entry?.availability.ready)
                        this._service.select(id);
                    // toggle_mode flipped it; the chosen engine decides.
                    this._sync();
                });
                this._tooltip.attach(button, () => {
                    const entry = this._service.enabledEngines.find(e => e.id === id);
                    return entry && !entry.availability.ready
                        ? `${entry.title}: ${entry.availability.reason}` : null;
                }, 'below');
                this._engineRow.add_child(button);
                this._engineButtons.set(id, button);
            }
        }
        for (const {id, availability} of engines) {
            const button = this._engineButtons.get(id);
            button.checked = id === selected;
            // Not while a request runs: the line above the box names where
            // that text went. (St sets 'insensitive' with reactive.)
            button.reactive = !busy;
            if (availability.ready && !busy)
                button.remove_style_pseudo_class('insensitive');
            else
                button.add_style_pseudo_class('insensitive');
        }
        // One engine is not a choice.
        this._engineRow.visible = engines.length > 1;
    }

    _syncActions(engine, sendable) {
        const ids = ACTIONS.map(a => a.id).filter(id => engine.actions.includes(id));
        const key = ids.join(',');
        if (key !== this._actionKey) {
            this._actionKey = key;
            // The buttons are kept (destroy() destroys them); only the rows go.
            for (const button of this._actionButtons.values())
                button.get_parent()?.remove_child(button);
            this._actionsBox.destroy_all_children();
            for (let i = 0; i < ids.length; i += ROW_SIZE) {
                const row = new St.BoxLayout({style_class: 'froonty-writing-action-row'});
                for (const id of ids.slice(i, i + ROW_SIZE))
                    row.add_child(this._actionButtons.get(id));
                this._actionsBox.add_child(row);
            }
        }
        for (const id of ids)
            this._actionButtons.get(id).reactive = sendable;
    }

    _emptyText(engines) {
        if (!engines.length)
            return _('No writing engine is turned on.');
        const reasons = engines.map(e => `${e.title}: ${e.availability.reason}`);
        return _('None of your writing engines is ready: %s.').format(reasons.join(' · '));
    }

    _sync() {
        const service = this._service;
        const engines = service.enabledEngines;
        const checking = engines.some(e => e.availability.checking);
        const anyReady = engines.some(e => e.availability.ready);
        const empty = !engines.length || (!checking && !anyReady);
        this._empty.visible = empty;
        this._main.visible = !empty;
        setText(this._emptyLabel, empty ? this._emptyText(engines) : '');
        if (empty) {
            this._tooltip.hide();
            return;
        }

        const engine = service.engine;
        const availability = service.availabilityOf(engine.id);
        const busy = service.state === 'busy';
        this._syncEngines(engines, engine.id, busy);
        // While a request runs, where that text went.
        const destination = busy && service.running ? service.running.destination
            : engine.destination(this._ctx.settings);
        setText(this._destination, busy || availability.ready || availability.checking
            ? destination : `${destination}\n${engine.title}: ${availability.reason}`);

        // Only replace the text when the service has another (From clipboard,
        // Clear), never while it matches what is being typed.
        if (this._input.text !== service.input) {
            this._syncing = true;
            this._input.text = service.input;
            this._syncing = false;
        }
        const {used, max, unit} = measure(service.input, engine.limit);
        setText(this._counter, unit === 'bytes'
            ? `${group(used)} / ${group(max)} ${_('bytes')}` : `${group(used)} / ${group(max)}`);
        if (used > max)
            this._counter.add_style_class_name('froonty-writing-over');
        else
            this._counter.remove_style_class_name('froonty-writing-over');
        const sendable = !busy && availability.ready && Boolean(service.input.trim()) && used <= max;
        this._syncActions(engine, sendable);
        this._clipboardButton.visible = this._ctx.settings.get_boolean('clipboard-enabled');
        this._clipboardButton.reactive = this._clearButton.reactive = !busy;

        this._busy.visible = busy;
        setText(this._busyLabel, busy ? service.busyText : '');

        const error = service.state === 'error' ? service.error : null;
        this._error.visible = Boolean(error);
        setText(this._error, error ? [error.message, error.hint].filter(Boolean).join('\n') : '');
        this._notice.visible = Boolean(service.notice);
        setText(this._notice, service.notice ?? '');

        // Done, or stopped with part of a reply; while busy, what has been
        // streamed so far (no Copy until it is done or stopped).
        const result = !busy && (service.state === 'done' || service.result?.partial)
            ? service.result : null;
        const partial = busy ? service.partialText : '';
        this._resultScroll.visible = Boolean(result || partial);
        this._resultTools.visible = Boolean(result);
        setText(this._result, result?.text ?? partial);
        if (!result)
            this._copied = false;
        setLabel(this._copyButton, this._copied ? _('Copied') : _('Copy'));
        const attribution = result?.attribution ?? null;
        this._attribution.visible = Boolean(attribution);
        setLabel(this._attribution, attribution?.label ?? '');
        setText(this._changes, result ? this._changesText(result) : '');
        this._changes.visible = Boolean(this._changes.text);
    }

    // LanguageTool's corrections, one per line: “teh” → “the”: message.
    // A stopped run: that this is only part of the reply.
    _changesText(result) {
        if (result.partial)
            return _('Stopped before the end: this is what it wrote until then.');
        if (!Array.isArray(result.changes))
            return '';
        const count = result.changes.length + (result.moreChanges ?? 0);
        const lines = [count
            ? ngettext('%d change', '%d changes', count).format(count)
            : _('No changes')];
        for (const change of result.changes)
            lines.push(`“${change.from}” → “${change.to}”: ${change.message}`);
        if (result.moreChanges)
            lines.push(_('and %d more').format(result.moreChanges));
        for (const note of result.notes ?? [])
            lines.push(`${_('Note')}: “${note.excerpt}”: ${note.message}`);
        return lines.join('\n');
    }
}
