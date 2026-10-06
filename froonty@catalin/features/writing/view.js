// SPDX-License-Identifier: GPL-3.0-or-later
// Writing tab (docs/features/writing.md §7):
//
//   [Claude Code][LanguageTool][Ollama]     engines switched on in Settings
//   Sends to Anthropic, through your Claude Code (Haiku · your plan's usage)
//   ┌ text box ───────────────────────────┐
//   └─────────────────────────────────────┘
//   [From clipboard] [Clear]        1,234 / 20,000
//   [Fix grammar][Shorten][Formal][Humanize] the chosen engine's actions
//   [Translate] from [Romanian] to [English]  (a language list opens below)
//   busy: "Rewriting with Claude Code…" [Cancel] · error
//   result: B2            [Copy]   each version, with its own Copy
//           text
//           C1            [Copy]
//           text
//           idioms (Translate) · LanguageTool's changes
//   [Another option]               link
//
// Engine text is shown as plain text (never Pango markup), and goes on the
// clipboard only when Copy (or Ctrl+C on a selection) is used. While
// Ollama streams, what it has written so far shows in the result area.
// Results are read-only but take the keyboard (readOnlyText.js). Renders
// WritingService state;
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
import {WrapLayout} from '../formulas/wrapLayout.js';
import {ACTIONS, ANY_LANGUAGE, LANGUAGES, languageName, measure} from './actions.js';
import {HINTS} from './hints.js';
import {makeNavigable} from './readOnlyText.js';
import {FROM_KEY, TO_KEY} from './service.js';

const ROW_SIZE = 4;
// On a row of its own, with its languages.
const TRANSLATE = 'translate';

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

// A read-only result text, a direct child of the scroll view's child box
// (so keepCursorVisible's coordinates hold).
function resultText(scroll) {
    const entry = new St.Entry({
        style_class: 'froonty-writing-text froonty-writing-result',
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
    text.editable = false;
    text.selectable = true;
    makeNavigable(entry, scroll);
    return entry;
}

// The text box: a multi-line St.Entry in a vertical scroll view, as the
// Notes editor.
function textArea(styleClass, hint) {
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
        // The index of the version whose Copy was clicked, or null.
        this._copied = null;

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

        const input = textArea('froonty-writing-input', _('Type or paste text (Ctrl+V)'));
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
            button.connect('clicked', () => {
                this._chooser.visible = false;
                this._service.run(action.id);
            });
            this._actionButtons.set(action.id, button);
        }
        this._main.add_child(this._actionsBox);
        this._buildTranslate();

        // Long hints wrap (hints.js).
        this._tooltip = new Tooltip({maxWidth: 360});
        this._buildStatus();

        // What each button does, and which models did best (hints.js).
        for (const [id, button] of this._actionButtons)
            this._tooltip.attach(button, () => _(HINTS[id]), 'below');
        this._tooltip.attach(this._againButton, () => _(HINTS.again), 'above');
        for (const button of [this._fromButton, this._toButton])
            this._tooltip.attach(button, () => _(HINTS.language), 'below');
        const overlay = new St.Widget({x_expand: true, y_expand: true});
        overlay.add_child(this._tooltip.actor);
        this.actor.add_child(overlay);

        this._serviceId = this._service.connect('changed', () => this._sync());
        this._settingsIds = [FROM_KEY, TO_KEY].map(key =>
            this._ctx.settings.connect(`changed::${key}`, () => this._sync()));
        this._sync();
    }

    destroy() {
        this._service.disconnect(this._serviceId);
        for (const id of this._settingsIds)
            this._ctx.settings.disconnect(id);
        // Kept out of the tree between engines: destroyed here.
        for (const button of this._actionButtons.values())
            button.destroy();
        this._translateRow.destroy();
        this._chooser.destroy();
        this.actor.destroy();
    }

    setActive(active) {
        if (!active) {
            this._tooltip.hide();
            this._chooser.visible = false;
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

        // The versions (each a header with its label and Copy, then its
        // text), the idioms and the changes, all in one scroll view.
        this._resultBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
        });
        this._resultScroll = new St.ScrollView({
            style_class: 'froonty-writing-scroll froonty-writing-result-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true,
            child: this._resultBox,
        });
        this._options = [];
        this._idioms = wrapping(new St.Label({style_class: 'froonty-writing-idioms', visible: false}));
        this._changes = wrapping(new St.Label({style_class: 'froonty-writing-changes', visible: false}));
        this._resultBox.add_child(this._idioms);
        this._resultBox.add_child(this._changes);
        this._main.add_child(this._resultScroll);

        const resultTools = new St.BoxLayout({style_class: 'froonty-writing-tools'});
        this._againButton = textButton('froonty-writing-small', _('Another option'));
        this._againButton.connect('clicked', () => this._service.again());
        this._attribution = new St.Button({
            style_class: 'froonty-writing-link',
            can_focus: true,
            track_hover: true,
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
        });
        this._attribution.connect('clicked', () => this._openAttribution());
        resultTools.add_child(this._againButton);
        resultTools.add_child(this._attribution);
        this._resultTools = resultTools;
        this._main.add_child(resultTools);
    }

    // The block of the i-th version: made when first needed, then kept.
    _option(i) {
        while (this._options.length <= i) {
            const index = this._options.length;
            const header = new St.BoxLayout({style_class: 'froonty-writing-option-header'});
            const label = new St.Label({
                style_class: 'froonty-writing-option-label',
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            const copy = textButton('froonty-writing-small froonty-writing-copy', _('Copy'));
            copy.connect('clicked', () => this._copy(index));
            header.add_child(label);
            header.add_child(copy);
            const entry = resultText(this._resultScroll);
            // Before the idioms and the changes.
            this._resultBox.insert_child_below(header, this._idioms);
            this._resultBox.insert_child_below(entry, this._idioms);
            this._options.push({header, label, copy, entry});
        }
        return this._options[i];
    }

    _copy(index) {
        const text = this._service.result?.options?.[index]?.text;
        if (!text)
            return;
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
        this._copied = index;
        this._sync();
    }

    _buildTranslate() {
        this._translateRow = new St.BoxLayout({
            style_class: 'froonty-writing-action-row froonty-writing-translate',
        });
        const word = text => new St.Label({
            style_class: 'froonty-writing-translate-word',
            text,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._translateWords = [word(_('from')), word(_('to'))];
        this._fromButton = textButton('froonty-writing-small froonty-writing-language', '');
        this._toButton = textButton('froonty-writing-small froonty-writing-language', '');
        this._fromButton.connect('clicked', () => this._toggleChooser(FROM_KEY));
        this._toButton.connect('clicked', () => this._toggleChooser(TO_KEY));
        this._chooser = new St.Widget({
            style_class: 'froonty-writing-chooser',
            layout_manager: new WrapLayout(),
            x_expand: true,
            visible: false,
        });
        this._chooserKey = null;
    }

    // The languages under the Translate row, for from or to; the choice
    // is kept (writing-translate-from/-to). The same button again closes
    // the list.
    _toggleChooser(key) {
        if (this._chooser.visible && this._chooserKey === key) {
            this._chooser.visible = false;
            return;
        }
        this._chooserKey = key;
        this._chooser.destroy_all_children();
        const settings = this._ctx.settings;
        const current = settings.get_string(key);
        const choices = key === FROM_KEY
            ? [{code: ANY_LANGUAGE, name: _('Any language')}, ...LANGUAGES] : LANGUAGES;
        for (const {code, name} of choices) {
            const button = textButton('froonty-writing-small froonty-writing-language-choice', name);
            if (code === current)
                button.add_style_pseudo_class('checked');
            button.connect('clicked', () => {
                settings.set_string(key, code);
                this._chooser.visible = false;
            });
            this._chooser.add_child(button);
        }
        this._chooser.visible = true;
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
                // Not ready: why; ready: what it is best at.
                this._tooltip.attach(button, () => {
                    const entry = this._service.enabledEngines.find(e => e.id === id);
                    if (!entry)
                        return null;
                    return entry.availability.ready ? _(HINTS[id])
                        : `${entry.title}: ${entry.availability.reason}`;
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
            // The buttons, the Translate row and the language list are kept
            // (destroy() destroys them); only the rows go.
            for (const button of this._actionButtons.values())
                button.get_parent()?.remove_child(button);
            for (const child of [this._translateRow, this._chooser])
                child.get_parent()?.remove_child(child);
            this._translateRow.remove_all_children();
            this._actionsBox.destroy_all_children();
            const rewrites = ids.filter(id => id !== TRANSLATE);
            for (let i = 0; i < rewrites.length; i += ROW_SIZE) {
                const row = new St.BoxLayout({style_class: 'froonty-writing-action-row'});
                for (const id of rewrites.slice(i, i + ROW_SIZE))
                    row.add_child(this._actionButtons.get(id));
                this._actionsBox.add_child(row);
            }
            if (ids.includes(TRANSLATE)) {
                const [from, to] = this._translateWords;
                for (const child of [this._actionButtons.get(TRANSLATE), from, this._fromButton,
                    to, this._toButton])
                    this._translateRow.add_child(child);
                this._actionsBox.add_child(this._translateRow);
                this._actionsBox.add_child(this._chooser);
            } else {
                this._chooser.visible = false;
            }
        }
        for (const id of ids) {
            this._actionButtons.get(id).reactive = sendable &&
                (id !== TRANSLATE || this._service.canTranslate);
        }
        const {from, to} = this._service.languages;
        setLabel(this._fromButton, from === ANY_LANGUAGE ? _('Any language') : languageName(from));
        setLabel(this._toButton, languageName(to));
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
        let options = [];
        if (result)
            options = result.options ?? [{label: '', text: result.text}];
        else if (busy)
            options = service.progress;
        this._resultScroll.visible = options.length > 0;
        if (!result)
            this._copied = null;
        options.forEach((option, i) => {
            const block = this._option(i);
            block.header.visible = block.entry.visible = true;
            setText(block.label, option.label ?? '');
            block.copy.visible = Boolean(result);
            setLabel(block.copy, this._copied === i ? _('Copied') : _('Copy'));
            setText(block.entry, option.text);
        });
        for (const block of this._options.slice(options.length)) {
            block.header.visible = block.entry.visible = false;
            setText(block.entry, '');
        }
        // A model's rewrite can be asked for again; LanguageTool's
        // corrections would come out the same.
        const resultEngine = engines.find(e => e.id === result?.engineId)?.engine;
        this._againButton.visible = Boolean(result && !result.partial && resultEngine?.prompted &&
            service.lastAction);
        this._againButton.reactive = !busy && availability.ready;
        const attribution = result?.attribution ?? null;
        this._attribution.visible = Boolean(attribution);
        setLabel(this._attribution, attribution?.label ?? '');
        this._resultTools.visible = this._againButton.visible || this._attribution.visible;
        setText(this._idioms, result ? this._idiomsText(result.idioms) : '');
        this._idioms.visible = Boolean(this._idioms.text);
        setText(this._changes, result ? this._changesText(result) : '');
        this._changes.visible = Boolean(this._changes.text);
    }

    // Translate's idioms: each phrase and its equivalent, then what it
    // means and the equivalent in use (when the model's example uses it).
    _idiomsText(idioms) {
        if (!idioms?.length)
            return '';
        const lines = [_('Idioms')];
        for (const {phrase, meaning, equivalent, example} of idioms) {
            lines.push(`“${phrase}” → ${equivalent}`);
            lines.push(example ? `    ${meaning} · ${_('e.g.')} “${example}”` : `    ${meaning}`);
        }
        return lines.join('\n');
    }

    // LanguageTool's corrections, one per line: “teh” → “the”: message.
    // A stopped run: that this is only part of the reply. A model's reply
    // that still looked like an answer to the text: a warning.
    _changesText(result) {
        if (result.partial)
            return _('Stopped before the end: this is what it wrote until then.');
        // service.js looksAnswered, twice.
        const answered = (result.options ?? []).filter(o => o.answered);
        if (answered.length) {
            const which = answered.map(o => o.label).filter(Boolean).join(', ');
            return (which ? _('%s may answer your text instead of rewording it.').format(which)
                : _('This may answer your text instead of rewording it.')) +
                ` ${_('Try Another option, or another model.')}`;
        }
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
