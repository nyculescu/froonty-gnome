// SPDX-License-Identifier: GPL-3.0-or-later
// Flow based rendered Markdown view for the Notes island. Block pictures are
// ordinary children in the vertical layout, so following text can never
// occupy the same area as a table, image, or diagram. Pictures keep their
// own width; a wider one scrolls sideways.
//
// Edits in place, the note staying rendered:
// - A click (not a drag) on text opens the part under it (editUnits.js: a
//   paragraph, heading, list item, task's text or code fence; a failed
//   block's source) in a field holding its Markdown, caret near the click.
//   Enter starts a new line; Ctrl+Enter or a click elsewhere writes it
//   back as one undoable edit; Escape (view.handleEscape) drops it. The
//   formatting shortcuts (Ctrl+B, …; formatActions.js) edit the field's
//   Markdown, as the bar's buttons do the source.
// - Right-click code (a fenced block's lines, an inline `span`) → Copy code
//   (the code alone, without fences or backticks) and Edit code (the field,
//   on the part holding it).
// - Right-click a table → Edit table: a grid of its cells; rows and columns
//   are added or removed at the focused cell; Done writes the table
//   (table.js), Cancel drops it.
// - Right-click a diagram → Copy Mermaid code (its code, without the fence
//   lines) and Edit Mermaid code: the code (Enter a new line, Ctrl+Enter
//   Done) beside its picture, drawn again once typing pauses
//   (mermaidEdit.js), or either alone (Code | Split | Preview, kept for the
//   session); Done writes the code back between its fence lines.
// While a field, table or diagram is open the view is not rebuilt under it
// (its offsets stay those of the text it opened on); closing it rebuilds.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GdkPixbuf from 'gi://GdkPixbuf';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {keepCursorVisible} from '../../../core/textScroll.js';
import {codeAt, editUnitAt} from '../editUnits.js';
import {formatEdit, formatShortcut} from '../formatActions.js';
import {DiagramDraft, LAYOUTS, mermaidLayout, setMermaidLayout, withFenceSource} from '../mermaidEdit.js';
import {toggleTask} from '../render.js';
import {clipboardImage, fitRenderSize, resizeWithAspect} from '../renderSizes.js';
import {sourceColumn} from '../sourceColumn.js';
import {addColumn, addRow, parseTable, removeColumn, removeRow, serializeTable, setCell} from '../table.js';
import {imageFile, readImage} from './imageFile.js';

const escapeMarkup = text => GLib.markup_escape_text(text, -1);
const BUTTONS = Clutter.ModifierType.BUTTON1_MASK | Clutter.ModifierType.BUTTON2_MASK |
    Clutter.ModifierType.BUTTON3_MASK;
const ENTER = [Clutter.KEY_Return, Clutter.KEY_KP_Enter, Clutter.KEY_ISO_Enter];

// Decoded pictures by their PNG bytes: the render cache (blocks.js) keeps
// one object per picture, so a rebuild does not decode it again.
const contents = new WeakMap();

// PNG bytes as actor content of their own size; null if unreadable. Also
// used for the formulas' pictures.
export function pngContent(bytes, width, height) {
    const loader = new GdkPixbuf.PixbufLoader();
    try {
        loader.write_bytes(new GLib.Bytes(bytes));
        loader.close();
        const pixbuf = loader.get_pixbuf();
        const context = global.stage.context.get_backend().get_cogl_context();
        const content = St.ImageContent.new_with_preferred_size(width, height);
        content.set_bytes(context, pixbuf.read_pixel_bytes(),
            pixbuf.get_has_alpha() ? Cogl.PixelFormat.RGBA_8888 : Cogl.PixelFormat.RGB_888,
            pixbuf.width, pixbuf.height, pixbuf.rowstride);
        return content;
    } catch (e) {
        try { loader.close(); } catch {}
        return null;
    }
}

// A rendered picture's content (null if unreadable): {png, pixelWidth,
// pixelHeight}, a render entry's.
function contentOf(block) {
    if (!contents.has(block.png))
        contents.set(block.png, pngContent(block.png, block.pixelWidth, block.pixelHeight));
    return contents.get(block.png);
}

// Pango markup for one line's inline Markdown, or its plain text when its
// markers cross (`**a _b** c_`), which Pango would reject.
function inlineMarkup(text) {
    // Code spans first, so markers in code are not formatting.
    const markup = text.split(/(`[^`\n]+`)/).map((part, i) => i % 2
        ? `<tt>${escapeMarkup(part.slice(1, -1))}</tt>` : emphasis(escapeMarkup(part))).join('');
    try {
        Pango.parse_markup(markup, -1, '');
        return markup;
    } catch {
        return escapeMarkup(text);
    }
}

function emphasis(markup) {
    return markup
        .replace(/\*\*(\S(?:.*?\S)?)\*\*/g, '<b>$1</b>')
        .replace(/__(\S(?:.*?\S)?)__/g, '<b>$1</b>')
        .replace(/~~(\S(?:.*?\S)?)~~/g, '<s>$1</s>')
        .replace(/(?<![\w*])\*(\S(?:.*?\S)?)\*(?![\w*])/g, '<i>$1</i>')
        .replace(/(?<![\w_])_(\S(?:.*?\S)?)_(?![\w_])/g, '<i>$1</i>')
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<u>$1</u>');
}

// What shows in place of a block being drawn.
function pendingText(kind) {
    switch (kind) {
    case 'table':
        return _('Rendering table…');
    case 'image':
        return _('Rendering image…');
    default:
        return _('Rendering diagram…');
    }
}

// What shows in place of a block that could not be drawn; `reason` is the
// helper's (English).
function failureText(kind, reason) {
    switch (kind) {
    case 'table':
        return _('Could not render table: %s').format(reason);
    case 'image':
        return _('Could not render image: %s').format(reason);
    default:
        return _('Could not render diagram: %s').format(reason);
    }
}

// A small button of an editor (a table's, a diagram's).
function controlButton(label, name, action) {
    const button = new St.Button({
        style_class: 'froonty-notes-table-button',
        label,
        accessible_name: name,
        can_focus: true,
    });
    button.connect('clicked', action);
    return button;
}

// `child` in a horizontal scroller: a picture or table wider than the note
// scrolls sideways. Its own mouse scrolling is off, so the wheel still
// scrolls the note; sideways scrolls (a touchpad, a tilted wheel) move it.
function sidewaysScroller(child) {
    const box = new St.BoxLayout();
    box.add_child(child);
    const scroll = new St.ScrollView({
        hscrollbar_policy: St.PolicyType.EXTERNAL,
        vscrollbar_policy: St.PolicyType.NEVER,
        overlay_scrollbars: true,
        enable_mouse_scrolling: false,
        x_expand: true,
        child: box,
    });
    // A bar only for a block wider than the note (AUTOMATIC showed one
    // under every picture). EXTERNAL, not NEVER: that would make the
    // scroller as wide as the block, and the island grow to fit it.
    // Set after the layout that changed the widths: one set during a
    // layout is not laid out, so the bar did not show (the Mermaid editor).
    const adjustment = scroll.hadjustment;
    let pending = 0;
    adjustment.connect('changed', () => {
        pending ||= GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            pending = 0;
            const policy = adjustment.upper - adjustment.page_size > 1
                ? St.PolicyType.AUTOMATIC : St.PolicyType.EXTERNAL;
            if (scroll.hscrollbar_policy !== policy)
                scroll.hscrollbar_policy = policy;
            return GLib.SOURCE_REMOVE;
        });
    });
    scroll.connect('destroy', () => {
        if (pending)
            GLib.source_remove(pending);
    });
    scroll.connect('scroll-event', (_actor, event) => {
        let delta = 0;
        switch (event.get_scroll_direction()) {
        case Clutter.ScrollDirection.LEFT:
            delta = -1;
            break;
        case Clutter.ScrollDirection.RIGHT:
            delta = 1;
            break;
        case Clutter.ScrollDirection.SMOOTH: {
            const [dx, dy] = event.get_scroll_delta();
            if (Math.abs(dx) > Math.abs(dy))
                delta = dx;
            break;
        }
        }
        if (!delta)
            return Clutter.EVENT_PROPAGATE;
        scroll.hadjustment.adjust_for_scroll_event(delta);
        return Clutter.EVENT_STOP;
    });
    return scroll;
}

export class IslandMarkdownPreview {
    /**
     * @param {St.Entry} entry the note's source editor
     * @param {object} options
     * @param {Function} options.onResize (itemKey, size) a picture was resized
     * @param {Function} options.contextMenu (source, params) → a menu (ui/contextMenu.js)
     * @param {Function} options.folder () → the note folder (Gio.File), or null
     * @param {Function} options.edit (start, end, text) replaces that part
     *   (UTF-16 offsets) of the note text as one undoable edit
     * @param {Function} options.pasteImage (key event) → null, or a Promise
     *   of the Markdown reference of an image pasted into the note folder
     * @param {Function} options.showFile (Gio.File) shows it in Files
     * @param {Function} options.drawDiagram (source) → a promise of the
     *   picture of a diagram ({png, width, height, warnings}), as the note's
     *   are drawn; rejects with the reason
     * @param {Tooltip} options.tooltip lists a partly drawn block's problems
     */
    constructor(entry, {onResize, contextMenu, folder, edit, pasteImage, showFile, drawDiagram, tooltip}) {
        this._entry = entry;
        this._onResize = onResize;
        this._contextMenu = contextMenu;
        this._folder = folder;
        this._edit = edit;
        this._pasteImage = pasteImage;
        this._showFile = showFile;
        this._drawDiagram = drawDiagram;
        this._tooltip = tooltip;
        this.widget = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: false,
            // Clutter gives key events (Ctrl+Z) only to reactive actors.
            reactive: true,
            style_class: 'froonty-notes-editor',
        });
        this.widget.visible = false;
        this._editable = true;
        this._wrap = true;
        // The texts, given the selection colours of the note's (stylesheet.css)
        // as they change. The hidden editor's are never set: it is not styled.
        this._runs = [];
        this._selection = null;
        // The open field, table or diagram, else null: {kind: 'text' |
        // 'table' | 'mermaid', start, end, source (the part of the note it
        // edits), actor, value() (its Markdown now)}.
        this._open = null;
        // What the view was built from, for clicks: {text, pictures}.
        this._built = {text: '', pictures: []};
        // _later()'s timeouts, gone with the view.
        this._timers = new Set();
        this.widget.connect('style-changed', () => {
            if (!this.widget.get_stage())
                return;
            const node = this.widget.get_theme_node();
            const [hasBackground, background] = node.lookup_color('selection-background-color', false);
            const [hasForeground, foreground] = node.lookup_color('selected-color', false);
            this._selection = hasBackground && hasForeground ? {background, foreground} : null;
            this._runs.forEach(text => this._colorSelection(text));
        });
        // A click elsewhere in the view (a picture, a gap) closes an open
        // field, as a click on text does by taking the key focus. Seen as
        // it is captured: on GNOME Shell 50 texts take presses through
        // gestures of their own, so no button-press-event comes up from them.
        this.widget.connect('captured-event', (_widget, event) => {
            if (event.type() === Clutter.EventType.BUTTON_PRESS && this._open?.kind === 'text' &&
                !this._open.actor.contains(global.stage.get_event_actor(event)))
                this.widget.grab_key_focus();
            return Clutter.EVENT_PROPAGATE;
        });
        this.widget.connect('destroy', () => this._timers.forEach(id => GLib.source_remove(id)));
    }

    _colorSelection(text) {
        if (!this._selection)
            return;
        text.selection_color = this._selection.background;
        text.selected_text_color = this._selection.foreground;
    }

    /** Whether a field, table or diagram is open (its keys are its own: no Ctrl+Z). */
    get editing() {
        return this._open !== null;
    }

    /** Writes an open field, table or diagram into the note (before the note changes). */
    finish() {
        this._close(true);
    }

    /** Drops an open field, table or diagram (Escape); true if one was open. */
    cancel() {
        return this._close(false);
    }

    setEditable(editable) {
        editable = Boolean(editable);
        if (editable === this._editable)
            return;
        this._editable = editable;
        this.update(this._text ?? '', this._pictures ?? []);
    }

    setWrap(wrap) {
        wrap = Boolean(wrap);
        if (wrap === this._wrap)
            return;
        this._wrap = wrap;
        this.update(this._text ?? '', this._pictures ?? []);
    }

    update(text, pictures) {
        this._text = text;
        this._pictures = pictures;
        if (!this._open)
            this._rebuild();
    }

    _rebuild() {
        const text = this._text ?? '';
        const pictures = this._pictures ?? [];
        this._built = {text, pictures};
        this._tooltip.hide();
        this.widget.destroy_all_children();
        this._runs = [];

        const open = this._open;
        let at = 0;
        for (const block of pictures) {
            this._addText(text.slice(at, block.start), at);
            if (open?.start === block.start && open.end === block.end)
                this.widget.add_child(open.actor);
            else
                this._addPicture(block);
            at = block.end;
        }
        this._addText(text.slice(at), at);
    }

    _addText(source, sourceOffset) {
        if (!source)
            return;
        const open = this._open;
        // The label's lines, {markup, line}: line ({start, source}: where the
        // line is in the note, and its Markdown) maps a click to the part it
        // edits; null for the gap of blank lines.
        let run = [];
        let inFence = false;
        let start = sourceOffset;
        for (const line of source.split('\n')) {
            const lineStart = start;
            start += line.length + 1;
            if (open && lineStart >= open.start && lineStart + line.length <= open.end) {
                // The open field, in place of its lines.
                if (lineStart === open.start) {
                    this._addRun(run);
                    run = [];
                    this.widget.add_child(open.actor);
                }
                continue;
            }
            const entry = {start: lineStart, source: line};
            if (/^\s*```/.test(line)) {
                inFence = !inFence;
                continue;
            }
            if (inFence) {
                run.push({markup: `<tt>${escapeMarkup(line)}</tt>`, line: entry});
                continue;
            }
            // Blank lines between paragraphs make one gap.
            if (!line.trim()) {
                if (run.at(-1)?.line)
                    run.push({markup: '', line: null});
                continue;
            }
            const task = /^(\s*[-*+]\s+\[([ xX])\]\s+)(.*)$/.exec(line);
            if (task) {
                this._addRun(run);
                run = [];
                this._addTask(task, lineStart);
                continue;
            }
            const heading = /^(#{1,6})\s+(.*)$/.exec(line);
            let markup;
            if (heading) {
                const size = Math.round(Math.max(1, 1.45 - heading[1].length * 0.07) * 100);
                markup = `<span weight="bold" size="${size}%">${inlineMarkup(heading[2])}</span>`;
            } else if (/^\s*>/.test(line)) {
                markup = `<span style="italic" foreground="#888">${
                    inlineMarkup(line.replace(/^\s*>\s?/, ''))}</span>`;
            } else {
                markup = inlineMarkup(line.replace(/^(\s*)[-*+]\s+/, '$1•  ')
                    .replace(/^(\s*)(\d+[.)])\s+/, '$1$2  '));
            }
            run.push({markup, line: entry});
        }
        this._addRun(run);
    }

    // The lines between two tasks, pictures or fields, as one text: a
    // selection can then span them.
    _addRun(run) {
        if (run.length && !run.at(-1).line)
            run.pop();
        if (run.length) {
            this.widget.add_child(this._selectableLabel(run.map(item => item.markup).join('\n'),
                {y_align: Clutter.ActorAlign.START, style: 'margin: 0; padding: 0;'},
                run.map(item => item.line)));
        }
    }

    // Read-only but selectable: drag, double or triple click, Ctrl+A,
    // then Ctrl+C or right click > Copy. With `lines` (one per line of
    // the text, see _addText), a click opens the part under it.
    _selectableLabel(markup, params, lines = null) {
        const label = new St.Label({x_expand: true, ...params});
        const text = label.clutter_text;
        text.line_wrap = this._wrap;
        text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        text.ellipsize = Pango.EllipsizeMode.NONE;
        text.set_markup(markup);
        text.reactive = true;
        text.selectable = true;
        this._colorSelection(text);
        this._runs.push(text);
        const copy = () => {
            const selected = text.get_selection();
            if (selected)
                St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, selected);
        };
        // Clutter.Text ignores every key while it is not editable.
        text.connect('key-press-event', (_text, event) => {
            if (!(event.get_state() & Clutter.ModifierType.CONTROL_MASK))
                return Clutter.EVENT_PROPAGATE;
            const symbol = event.get_key_symbol();
            if (symbol === Clutter.KEY_a || symbol === Clutter.KEY_A) {
                text.set_selection(0, -1);
                return Clutter.EVENT_STOP;
            }
            if (symbol === Clutter.KEY_c || symbol === Clutter.KEY_C || symbol === Clutter.KEY_Insert) {
                copy();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        // Captured: before Clutter.Text's own gestures, which take the
        // press (no button-press-event comes) and would drop the selection.
        text.connect('captured-event', (_text, event) => {
            if (event.type() !== Clutter.EventType.BUTTON_PRESS ||
                event.get_button() !== Clutter.BUTTON_SECONDARY || this._open)
                return Clutter.EVENT_PROPAGATE;
            const point = lines && this._pointAt(text, lines, event);
            const code = point ? codeAt(this._built.text, point.offset) : null;
            const selected = text.get_selection();
            if (!selected && code === null)
                return Clutter.EVENT_PROPAGATE;
            // Edit code acts once the menu is gone, as Edit table does.
            let edit = null;
            const menu = this._contextMenu(label, {onClosed: () => edit && this._later(edit)});
            if (selected) {
                menu.addAction(_('Copy'), () => {
                    copy();
                    menu.close();
                });
            }
            if (code !== null) {
                menu.addAction(_('Copy code'), () => {
                    St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, code);
                    menu.close();
                });
                const part = this._editable ? this._partAt(point) : null;
                if (part) {
                    menu.addAction(_('Edit code'), () => {
                        edit = () => this._openText(part, Math.max(0, point.offset - part.start));
                        menu.close();
                    });
                }
            }
            menu.open();
            return Clutter.EVENT_STOP;
        });
        if (lines)
            this._openOnClick(text, lines);
        return label;
    }

    // A click without a drag opens the part under it, once the button is
    // up and the double-click time over with nothing selected: a drag, or
    // a double click (a word), selects, as before. Clutter.Text's gestures
    // take the pointer (no button events reach it): the press is seen as
    // it is captured, and _later() waits for the release.
    _openOnClick(text, lines) {
        let alive = true;
        text.connect('destroy', () => (alive = false));
        text.connect('captured-event', (_text, event) => {
            if (event.type() !== Clutter.EventType.BUTTON_PRESS ||
                event.get_button() !== Clutter.BUTTON_PRIMARY || !this._editable)
                return Clutter.EVENT_PROPAGATE;
            const point = this._pointAt(text, lines, event);
            const part = point && this._partAt(point);
            if (part) {
                // Rebuilt meanwhile (an open field was written): opened anyway.
                this._later(() => {
                    if (!alive || !text.get_selection())
                        this._openText(part, Math.max(0, point.offset - part.start));
                }, Clutter.Settings.get_default().double_click_time);
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    // The line of `lines` (see _addText) under `event`'s pointer on `text`,
    // and the note offset there: {line, offset}; null on a gap.
    _pointAt(text, lines, event) {
        const [, x, y] = text.transform_stage_point(...event.get_coords());
        const before = [...text.text].slice(0, text.coords_to_position(x, y)).join('');
        const row = before.split('\n').length - 1;
        const line = lines[row];
        if (!line)
            return null;
        const column = [...before.slice(before.lastIndexOf('\n') + 1)].length;
        return {line, offset: line.start + sourceColumn(line.source, text.text.split('\n')[row], column)};
    }

    // The part a field opens on at `point` ({start, end, source}), or null.
    _partAt({line, offset}) {
        const {text: note, pictures} = this._built;
        const unit = line.unit ?? editUnitAt(note, offset, pictures);
        return unit && {...unit, source: note.slice(unit.start, unit.end)};
    }

    // Runs `fn` after `delay` ms, once the click under way is over: the
    // rebuild it causes must not destroy the actor a button is held on.
    _later(fn, delay = 30) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            const [, , mods] = global.get_pointer();
            if (mods & BUTTONS)
                return GLib.SOURCE_CONTINUE;
            this._timers.delete(id);
            fn();
            return GLib.SOURCE_REMOVE;
        });
        this._timers.add(id);
    }

    // Where `part` ({start, end, source}) is in the note text now: the same
    // place, else (the text changed around it) where its source first is;
    // -1 when it is gone.
    _find({start, end, source}) {
        const text = this._text ?? '';
        return text.slice(start, end) === source ? start : text.indexOf(source);
    }

    // `part` in a field, the caret `caret` UTF-16 units into it; an open
    // field or table is written first.
    _openText(part, caret) {
        this._close(true);
        const start = this._find(part);
        if (start < 0 || !this._editable || !this.widget.mapped)
            return;
        const field = new St.Entry({
            style_class: 'froonty-notes-field',
            text: part.source,
            can_focus: true,
            x_expand: true,
        });
        const text = field.clutter_text;
        text.single_line_mode = false;
        text.activatable = false;
        text.line_wrap = true;
        text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        text.connect('key-press-event', (_text, event) => this._onFieldKey(field, event));
        // Clicking away writes it, after that click like opening.
        text.connect('key-focus-out', () => this._later(() => {
            if (this._open?.actor === field && !text.has_key_focus())
                this._close(true);
        }));
        this._open = {kind: 'text', start, end: start + part.source.length, source: part.source,
            actor: field, value: () => field.text};
        this._rebuild();
        text.grab_key_focus();
        const position = [...part.source.slice(0, caret)].length;
        text.set_selection(position, position);
    }

    // Ctrl+Enter writes the field (Enter: a new line, Clutter.Text's own);
    // a formatting shortcut edits its text and selection (Ctrl+Shift+M, MD,
    // goes on to the view); a pasted image goes in as its Markdown reference.
    _onFieldKey(field, event) {
        if (ENTER.includes(event.get_key_symbol()) &&
            event.get_state() & Clutter.ModifierType.CONTROL_MASK) {
            this._close(true);
            return Clutter.EVENT_STOP;
        }
        const shortcut = formatShortcut(event.get_key_symbol(), event.get_key_code(), event.get_state());
        if (shortcut && shortcut !== 'markdown') {
            const text = field.clutter_text;
            // -1 means "end of text" for both.
            const position = p => (p < 0 ? [...text.text].length : p);
            const result = formatEdit(shortcut)({
                text: text.text,
                start: position(text.selection_bound),
                end: position(text.cursor_position),
            });
            text.text = result.text;
            text.set_selection(result.start, result.end);
            return Clutter.EVENT_STOP;
        }
        const pasted = this._pasteImage(event);
        if (!pasted)
            return Clutter.EVENT_PROPAGATE;
        pasted.then(reference => {
            if (!reference || this._open?.actor !== field)
                return;
            const text = field.clutter_text;
            text.delete_selection();
            text.insert_text(reference, text.cursor_position);
        });
        return Clutter.EVENT_STOP;
    }

    // Closes the open field or table, writing it into the note if `commit`;
    // the view is rebuilt. True if one was open.
    _close(commit) {
        const open = this._open;
        if (!open)
            return false;
        this._open = null;
        const before = this._text;
        const value = commit ? open.value() : open.source;
        if (value !== open.source) {
            const start = this._find(open);
            if (start >= 0)
                this._edit(start, start + open.source.length, value);
            else
                console.warn('Froonty notes: the edited part changed meanwhile; the edit was not saved');
        }
        // An edit rebuilt the view (update()); else it is rebuilt here.
        if (this._text === before)
            this._rebuild();
        // The keys (Ctrl+Z) stay with the view, unless the focus went elsewhere.
        const focus = global.stage.key_focus;
        if (this.widget.mapped && (!focus || this.widget.contains(focus)))
            this.widget.grab_key_focus();
        return true;
    }

    _addTask(match, lineOffset) {
        const indent = match[1].search(/[-*+]/);
        const row = new St.BoxLayout({
            x_expand: true,
            style: `margin: 0 0 0 ${Math.max(0, indent) * 8}px; padding: 0;`,
        });
        const boxOffset = lineOffset + match[1].indexOf('[');
        const checked = match[2].toLowerCase() === 'x';
        const button = new St.Button({
            reactive: this._editable,
            can_focus: this._editable,
            label: checked ? '✓' : '',
            style: checked
                ? 'width: 22px; height: 22px; padding: 0; margin: 0 7px 0 0; border: 2px solid #a9330c; border-radius: 4px; background-color: #d54b17; color: white;'
                : 'width: 22px; height: 22px; padding: 0; margin: 0 7px 0 0; border: 2px solid #444; border-radius: 4px; background-color: #fffdf0; color: #222;',
        });
        button.connect('clicked', () => {
            const text = this._entry.clutter_text.text;
            // toggleTask counts code points, boxOffset UTF-16 units.
            const replacement = toggleTask(text, [...text.slice(0, boxOffset)].length);
            if (replacement !== null)
                this._entry.clutter_text.text = replacement;
            // The button is gone with the rebuild; the keys (Ctrl+Z) stay here.
            this.widget.grab_key_focus();
        });
        row.add_child(button);
        const textStart = lineOffset + match[1].length;
        if (this._open?.start === textStart && this._open.end === textStart + match[3].length) {
            row.add_child(this._open.actor);
        } else {
            row.add_child(this._selectableLabel(inlineMarkup(match[3]), {
                y_align: Clutter.ActorAlign.CENTER,
                style: checked ? 'color: #888; text-decoration: line-through;' : '',
            }, [{start: textStart, source: match[3]}]));
        }
        this.widget.add_child(row);
    }

    _addPicture(block) {
        if (block.state === 'pending') {
            this.widget.add_child(new St.Label({
                text: pendingText(block.kind),
                style_class: 'froonty-notes-block-status',
            }));
            return;
        }
        const content = block.state === 'ready' ? contentOf(block) : null;
        if (!content) {
            this._addFailure(block, block.error ?? _('the picture could not be read'));
            return;
        }
        // Its own size (an image's within 360 × 320, blocks.js), or the size
        // it was given.
        const {width, height} = fitRenderSize(block.displaySize, block) ??
            {width: block.width, height: block.height};
        const frame = new St.Widget({layout_manager: new Clutter.FixedLayout(),
            width, height, style: 'margin: 2px 0;'});
        const picture = new St.Widget({width, height, reactive: true});
        picture.content = content;
        picture.set_content_gravity(Clutter.ContentGravity.RESIZE_ASPECT);
        // Right-click, on the picture or its grip (all of a small one's
        // middle): a gesture, as on the note tabs (tabs.js).
        const menuOnRightClick = actor => {
            const rightClick = new Clutter.ClickGesture({
                required_button: Clutter.BUTTON_SECONDARY,
                recognize_on_press: true,
            });
            rightClick.connect('recognize', () => {
                if (!this._open)
                    this._pictureMenu(picture, block);
            });
            actor.add_action(rightClick);
        };
        menuOnRightClick(picture);
        frame.add_child(picture);
        this.widget.add_child(sidewaysScroller(frame));
        // Partly drawn: what was left out, the first in a line, all in its tooltip.
        if (block.warnings.length) {
            const problems = new St.Label({
                text: _('Not drawn: %s').format(block.warnings[0]),
                style_class: 'froonty-notes-block-warning',
                reactive: true,
                track_hover: true,
            });
            this._tooltip.attach(problems, () => block.warnings.join('\n'));
            this.widget.add_child(problems);
        }
        const handle = new St.Button({
            label: '◢',
            style: 'min-width: 20px; min-height: 20px; padding: 0; border-radius: 4px; ' +
                'background-color: rgba(40,40,40,0.72); color: white; font-size: 12px;',
            reactive: true, can_focus: true,
            accessible_name: _('Resize rendered item'),
        });
        handle.set_cursor_type(Clutter.CursorType.SE_RESIZE);
        menuOnRightClick(handle);
        frame.add_child(handle);
        handle.set_size(20, 20);
        handle.set_position(width - 20, height - 20);
        let current = {width, height};
        let start, origin;
        const drag = new Clutter.PanGesture({
            begin_threshold: 0,
            required_button: Clutter.BUTTON_PRIMARY,
        });
        drag.connect('recognize', () => {
            start = {...current};
            origin = drag.get_begin_centroid_abs();
        });
        // Stage coordinates and actor sizes are the same units.
        drag.connect('pan-update', () => {
            const point = drag.get_centroid_abs();
            current = resizeWithAspect(start, point.x - origin.x, point.y - origin.y);
            frame.set_size(current.width, current.height);
            picture.set_size(current.width, current.height);
            handle.set_position(current.width - 20, current.height - 20);
        });
        // A click without a drag saves nothing.
        drag.connect('end', () => {
            if (current.width !== start.width || current.height !== start.height)
                this._onResize(block.itemKey, current);
        });
        handle.add_action(drag);
    }

    // A block that could not be drawn: why, and its Markdown so nothing is
    // hidden (selectable; a click opens it in a field, to mend it).
    _addFailure(block, reason) {
        const status = new St.Label({
            text: failureText(block.kind, reason),
            style_class: 'froonty-notes-block-status',
        });
        status.clutter_text.line_wrap = true;
        status.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        status.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this.widget.add_child(status);
        const unit = {start: block.start, end: block.end};
        let start = block.start;
        const lines = this._built.text.slice(block.start, block.end).split('\n');
        this.widget.add_child(this._selectableLabel(
            lines.map(line => `<tt>${escapeMarkup(line)}</tt>`).join('\n'),
            {style_class: 'froonty-notes-block-source'},
            lines.map(line => {
                const item = {unit, start, source: line};
                start += line.length + 1;
                return item;
            })));
    }

    _pictureMenu(picture, block) {
        // An item acts once the menu is gone (onClosed, then after the click):
        // Edit table rebuilds the view, the menu's source with it.
        let chosen = null;
        const menu = this._contextMenu(picture, {onClosed: () => chosen && this._later(chosen)});
        const add = (label, action) => menu.addAction(label, () => {
            chosen = action;
            menu.close();
        });
        if (block.kind === 'image') {
            add(_('Copy as PNG'), () => this._copyPicture(block));
            const file = imageFile(block, this._folder());
            if (file) {
                add(_('Open file location'), () => this._showFile(file));
                // The file's own bytes and type. Only one type: St.Clipboard
                // offers a single one, so Files cannot paste it as a file.
                add(_('Copy original'), () => readImage(file).then(({bytes, mime}) =>
                    St.Clipboard.get_default().set_content(St.ClipboardType.CLIPBOARD,
                        mime, new GLib.Bytes(bytes)))
                    .catch(error => console.warn(`Froonty notes: could not copy ${file.get_path()}: ${error.message}`)));
            }
        } else {
            add(_('Copy as JPEG'), () => this._copyPicture(block));
            if (block.kind === 'table') {
                add(_('Copy as Markdown'), () =>
                    St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, block.source));
            }
            if (block.kind === 'mermaid') {
                add(_('Copy Mermaid code'), () =>
                    St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, block.source));
            }
            if (block.kind === 'table' && this._editable)
                add(_('Edit table'), () => this._openTable(block));
            else if (block.kind === 'mermaid' && this._editable)
                add(_('Edit Mermaid code'), () => this._openMermaid(block));
        }
        menu.open();
    }

    _copyPicture(block) {
        try {
            const copied = clipboardImage(block.png, block.kind);
            St.Clipboard.get_default().set_content(St.ClipboardType.CLIPBOARD,
                copied.mime, new GLib.Bytes(copied.bytes));
        } catch (error) {
            console.warn(`Froonty notes: could not copy rendered block: ${error.message}`);
        }
    }

    // Edit table: the table block `part` as a grid of cells.
    _openTable(part) {
        this._close(true);
        const start = this._find(part);
        let model;
        try {
            model = parseTable(part.source);
        } catch {
            return;
        }
        if (start < 0 || !this._editable)
            return;
        const open = {kind: 'table', start, end: start + part.source.length, source: part.source,
            model, cell: null, changed: false};
        // Done without a change writes nothing (not even the alignment).
        open.value = () => (open.changed ? serializeTable(open.model) : open.source);
        open.actor = this._tableEditor(open);
        this._open = open;
        this._rebuild();
        open.fill(-1, 0);
    }

    // The grid (header row first) in a sideways scroller; under it, buttons
    // that add or remove a row or column at the focused cell (else at the
    // end), then Cancel and Done. Enter in a cell is Done.
    _tableEditor(open) {
        const grid = new St.Widget({
            style_class: 'froonty-notes-table-grid',
            layout_manager: new Clutter.GridLayout(),
        });
        // Rebuilt after each change of shape, focusing cell (`row`, `column`);
        // row -1 is the header.
        open.fill = (row, column) => {
            grid.destroy_all_children();
            const {header, rows} = open.model;
            [header, ...rows].forEach((cells, r) => header.forEach((_title, c) => {
                // Pipes show plain; serializeTable() escapes them again.
                const cell = new St.Entry({
                    style_class: r ? 'froonty-notes-cell' : 'froonty-notes-cell froonty-notes-cell-header',
                    text: (cells[c] ?? '').replaceAll('\\|', '|'),
                    can_focus: true,
                });
                cell.clutter_text.connect('text-changed', () => {
                    open.model = setCell(open.model, r - 1, c, cell.text);
                    open.changed = true;
                });
                cell.clutter_text.connect('key-focus-in', () => (open.cell = {row: r - 1, column: c}));
                cell.clutter_text.connect('activate', () => this._close(true));
                grid.layout_manager.attach(cell, c, r, 1, 1);
                if (r - 1 === row && c === column)
                    cell.clutter_text.grab_key_focus();
            }));
        };
        // The focused cell, still in the table, else the last.
        const focused = () => {
            const {header, rows} = open.model;
            const cell = open.cell ?? {row: rows.length - 1, column: header.length - 1};
            return {row: Math.min(cell.row, rows.length - 1), column: Math.min(cell.column, header.length - 1)};
        };
        const change = (edit, row, column) => {
            open.model = edit(open.model);
            open.changed = true;
            open.fill(row, column);
        };
        const button = (box, label, name, action) => box.add_child(controlButton(label, name, action));
        const shape = new St.BoxLayout({style_class: 'froonty-notes-table-controls'});
        button(shape, _('+ Row'), _('Add a row'), () => {
            const {row, column} = focused();
            change(model => addRow(model, row + 1), row + 1, column);
        });
        button(shape, _('− Row'), _('Remove the row'), () => {
            const {row, column} = focused();
            if (row >= 0)
                change(model => removeRow(model, row), Math.min(row, open.model.rows.length - 2), column);
        });
        button(shape, _('+ Column'), _('Add a column'), () => {
            const {row, column} = focused();
            change(model => addColumn(model, column + 1), row, column + 1);
        });
        button(shape, _('− Column'), _('Remove the column'), () => {
            const {row, column} = focused();
            if (open.model.header.length > 1)
                change(model => removeColumn(model, column), row, Math.min(column, open.model.header.length - 2));
        });
        const editor = this._editorBox();
        editor.add_child(sidewaysScroller(grid));
        editor.add_child(shape);
        editor.add_child(this._finishControls());
        return editor;
    }

    // An editor of a block (a table, a diagram), in its place.
    _editorBox() {
        return new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'froonty-notes-table-editor',
            x_expand: true,
        });
    }

    // Cancel and Done, at the right.
    _finishControls() {
        const finish = new St.BoxLayout({style_class: 'froonty-notes-table-controls'});
        finish.add_child(new St.Widget({x_expand: true}));
        finish.add_child(controlButton(_('Cancel'), _('Cancel'), () => this._close(false)));
        finish.add_child(controlButton(_('Done'), _('Done'), () => this._close(true)));
        return finish;
    }

    // Edit Mermaid code: the diagram `block`'s code beside its picture.
    _openMermaid(block) {
        const fence = this._built.text.slice(block.start, block.end);
        this._close(true);
        const start = this._find({start: block.start, end: block.end, source: fence});
        if (start < 0 || !this._editable)
            return;
        const open = {kind: 'mermaid', start, end: start + fence.length, source: fence, code: block.source};
        // Unchanged code writes nothing.
        open.value = () => (open.code === block.source ? fence : withFenceSource(fence, open.code));
        open.actor = this._mermaidEditor(open);
        this._open = open;
        this._rebuild();
        open.focus();
    }

    // Code | Split | Preview; under it the code (monospace, wrapped) and
    // its picture side by side, or either alone; then Cancel and Done. The
    // picture is drawn again once typing pauses; a narrow one scrolls
    // sideways, and under it is why it could not be drawn, or what it
    // left out (all of it in the tooltip).
    _mermaidEditor(open) {
        const field = new St.Entry({
            style_class: 'froonty-notes-field',
            style: 'font-family: monospace;',
            text: open.code,
            can_focus: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.START,
        });
        const code = field.clutter_text;
        code.single_line_mode = false;
        code.activatable = false;
        // Code keeps its lines: long ones scroll sideways, the caret in view.
        code.line_wrap = false;
        const codePane = sidewaysScroller(field);
        code.connect('cursor-changed', () => keepCursorVisible(field, codePane));
        // Enter is Clutter.Text's own (a new line); Ctrl+Enter is Done.
        code.connect('key-press-event', (_text, event) => {
            if (!ENTER.includes(event.get_key_symbol()) ||
                !(event.get_state() & Clutter.ModifierType.CONTROL_MASK))
                return Clutter.EVENT_PROPAGATE;
            this._close(true);
            return Clutter.EVENT_STOP;
        });

        const picture = new St.Widget({visible: false});
        picture.set_content_gravity(Clutter.ContentGravity.RESIZE_ASPECT);
        const status = new St.Label({
            text: pendingText('mermaid'),
            style_class: 'froonty-notes-block-status',
            reactive: true,
            track_hover: true,
        });
        status.clutter_text.line_wrap = true;
        status.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        let warnings = [];
        this._tooltip.attach(status, () => warnings.join('\n'));
        const preview = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        preview.add_child(sidewaysScroller(picture));
        preview.add_child(status);
        // A failure keeps the last picture, faded.
        const show = ({picture: drawn, error}) => {
            const content = drawn
                ? contentOf({png: drawn.png, pixelWidth: drawn.width, pixelHeight: drawn.height}) : null;
            if (content) {
                picture.content = content;
                picture.set_size(drawn.width, drawn.height);
                picture.visible = true;
            }
            picture.opacity = content ? 255 : 128;
            warnings = content ? drawn.warnings : [];
            const reason = content ? null : error ?? _('the picture could not be read');
            status.text = reason ? failureText('mermaid', reason) : _('Not drawn: %s').format(warnings[0] ?? '');
            status.style_class = reason ? 'froonty-notes-block-status' : 'froonty-notes-block-warning';
            status.visible = Boolean(reason || warnings.length);
        };
        const draft = new DiagramDraft(source => this._drawDiagram(source), show);
        code.connect('text-changed', () => {
            open.code = field.text;
            draft.set(open.code);
        });
        field.connect('destroy', () => draft.destroy());
        draft.set(open.code, true);

        const panes = new St.BoxLayout({x_expand: true, style: 'spacing: 6px;'});
        // Halves of the width, side by side; one alone takes all of it.
        panes.layout_manager.homogeneous = true;
        panes.add_child(codePane);
        panes.add_child(preview);
        const names = {code: _('Code'), split: _('Split'), preview: _('Preview')};
        const switcher = new St.BoxLayout({style_class: 'froonty-notes-table-controls'});
        const choose = layout => {
            setMermaidLayout(layout);
            codePane.visible = layout !== 'preview';
            preview.visible = layout !== 'code';
            switcher.get_children().forEach((button, i) => {
                button.checked = LAYOUTS[i] === layout;
                // Lit as the formatting bar's toggles are (stylesheet.css).
                button.style = button.checked
                    ? 'color: #ffffff; background-color: rgba(53, 132, 228, 0.75);' : null;
            });
        };
        for (const layout of LAYOUTS)
            switcher.add_child(controlButton(names[layout], names[layout], () => choose(layout)));
        choose(mermaidLayout());
        // The code takes the keys; shown alone, the picture leaves them to Done.
        const finish = this._finishControls();
        open.focus = () => (codePane.visible ? code : finish.get_last_child()).grab_key_focus();

        const editor = this._editorBox();
        editor.add_child(switcher);
        editor.add_child(panes);
        editor.add_child(finish);
        return editor;
    }
}
