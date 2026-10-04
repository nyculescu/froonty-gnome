// SPDX-License-Identifier: GPL-3.0-or-later
// Formulas tab (docs/features/formulas.md §2):
//
//   ┌ LaTeX editor ─────────────────────────────────┐
//   └───────────────────────────────────────────────┘
//   ┌ preview (rendered), or MathJax's error ───────┐
//   └───────────────────────────────────────────────┘
//   [Display] [☆]        [$…$] [$$…$$] [Raw] [Into note]
//   Copied as $…$                                       status line
//   [Symbols] [Templates] [Recent] [Starred] [Guide]
//   ┌ the chosen panel: symbols (with a search), ───┐
//   │ templates, recent and starred formulas, guide │
//   └───────────────────────────────────────────────┘
//
// The preview is drawn by the renderer helper (renderer/client.js), never
// here: typing waits PREVIEW_DELAY_MS for a pause, then asks for a PNG on
// the 'preview' channel, so an answer for older text is dropped. Without
// MathJax fetched, the preview says how to fetch it, and everything else
// works. A symbol, template or guide example goes in at the editor's
// cursor (edit.js).

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {keepCursorVisible} from '../../core/textScroll.js';
import {Tooltip} from '../../core/tooltip.js';
import {copyText, errorText, insertSnippet, isFavourite, SLOT} from './edit.js';
import {GUIDE} from './guide.js';
import {FAVOURITES_KEY, RECENT_KEY} from './service.js';
import {searchSymbols, SECTIONS} from './symbols.js';
import {TEMPLATES} from './templates.js';
import {WrapLayout} from './wrapLayout.js';

export const PREVIEW_DELAY_MS = 250;
// The preview's 1em, relative to the renderer's 16 px.
const PREVIEW_SCALE = 1.25;
const DISPLAY_KEY = 'formulas-display';

const PANELS = [
    {id: 'symbols', label: 'Symbols'},
    {id: 'templates', label: 'Templates'},
    {id: 'recent', label: 'Recent'},
    {id: 'favourites', label: 'Starred'},
    {id: 'guide', label: 'Guide'},
];

const shown = snippet => snippet.replaceAll(SLOT, '');

function wrapping(label) {
    label.clutter_text.line_wrap = true;
    label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
    label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    return label;
}

function button(styleClass, label, accessibleName = label) {
    return new St.Button({
        style_class: `froonty-formulas-button ${styleClass}`,
        label,
        accessible_name: accessibleName,
        can_focus: true,
        track_hover: true,
    });
}

// A wrapping row of buttons (symbols, templates).
function flow() {
    return new St.Widget({
        style_class: 'froonty-formulas-flow',
        layout_manager: new WrapLayout(),
        x_expand: true,
    });
}

// A vertical scroll view; its child goes in a box (St.ScrollView needs a
// scrollable child).
function scrolled(child, styleClass = '') {
    if (!(child instanceof St.BoxLayout)) {
        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        box.add_child(child);
        child = box;
    }
    return new St.ScrollView({
        style_class: `froonty-formulas-scroll ${styleClass}`,
        hscrollbar_policy: St.PolicyType.NEVER,
        vscrollbar_policy: St.PolicyType.AUTOMATIC,
        overlay_scrollbars: true,
        x_expand: true,
        y_expand: true,
        child,
    });
}

const hex = color => `#${[color.red, color.green, color.blue]
    .map(c => c.toString(16).padStart(2, '0')).join('')}`;

export class FormulasView {
    constructor(ctx, service) {
        this._ctx = ctx;
        this._settings = ctx.settings;
        this._service = service;
        this._destroyed = false;
        this._previewTimer = 0;
        this._previewKey = null;
        this._rendered = null; // the text the preview shows, when it rendered
        this._panel = null;

        this.actor = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });
        this._main = new St.BoxLayout({
            style_class: 'froonty-formulas',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
        });
        this.actor.add_child(this._main);
        const overlay = new St.Widget({x_expand: true, y_expand: true});
        this._tooltip = new Tooltip();
        overlay.add_child(this._tooltip.actor);
        this.actor.add_child(overlay);

        this._buildEditor();
        this._buildPreview();
        this._buildTools();
        this._buildPanels();

        this._settingsIds = [
            this._settings.connect(`changed::${DISPLAY_KEY}`, () => this._schedulePreview(0)),
            this._settings.connect(`changed::${RECENT_KEY}`, () => this._listsChanged('recent')),
            this._settings.connect(`changed::${FAVOURITES_KEY}`, () => this._listsChanged('favourites')),
        ];
        this._settings.bind(DISPLAY_KEY, this._displayButton, 'checked', Gio.SettingsBindFlags.DEFAULT);

        // A draft survives the island being rebuilt (ctx.memory).
        this._memory = ctx.memory ? (ctx.memory.formulas ??= {draft: ''}) : {draft: ''};
        this._editor.text = this._memory.draft;
        this._selectPanel('symbols');
        this._syncTools();
    }

    destroy() {
        this._destroyed = true;
        if (this._previewTimer)
            GLib.source_remove(this._previewTimer);
        this._previewTimer = 0;
        for (const id of this._settingsIds)
            this._settings.disconnect(id);
        Gio.Settings.unbind(this._displayButton, 'checked');
        this.actor.destroy();
    }

    setActive(active) {
        if (!active) {
            this._tooltip.hide();
            // A formula that rendered is kept in the recent list when the
            // tab is left.
            if (this._rendered && this._rendered === this._editor.text)
                this._service.addRecent(this._rendered);
            return;
        }
        this._editor.clutter_text.grab_key_focus();
        // MathJax may have been fetched meanwhile (the client keeps what
        // it drew, so this is cheap).
        this._schedulePreview(0);
    }

    // Editor ---------------------------------------------------------------

    _buildEditor() {
        this._editor = new St.Entry({
            style_class: 'froonty-formulas-editor',
            hint_text: _('Type LaTeX, e.g. \\frac{a}{b} or \\alpha^2'),
            can_focus: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.START,
        });
        const text = this._editor.clutter_text;
        text.single_line_mode = false;
        text.activatable = false;
        text.line_wrap = true;
        text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        text.use_markup = false;
        text.connect('text-changed', () => this._onTextChanged());
        text.connect('cursor-changed', () => keepCursorVisible(this._editor, this._editorScroll));

        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            reactive: true,
        });
        box.add_child(this._editor);
        box.connect('button-press-event', () => {
            text.grab_key_focus();
            return Clutter.EVENT_PROPAGATE;
        });
        this._editorScroll = new St.ScrollView({
            style_class: 'froonty-formulas-editor-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
            child: box,
        });
        this._main.add_child(this._editorScroll);
    }

    _editorState() {
        const text = this._editor.clutter_text;
        return {text: text.text, start: text.selection_bound, end: text.cursor_position};
    }

    /** Inserts a snippet at the editor's cursor (edit.js), and focuses it. */
    insert(snippet) {
        const result = insertSnippet(this._editorState(), snippet);
        const text = this._editor.clutter_text;
        text.text = result.text;
        text.set_selection(result.start, result.end);
        text.grab_key_focus();
    }

    _setFormula(tex) {
        this._editor.text = tex;
        this._editor.clutter_text.set_selection(-1, -1);
        this._editor.clutter_text.grab_key_focus();
    }

    _onTextChanged() {
        this._memory.draft = this._editor.text;
        this._setStatus('');
        this._syncTools();
        this._schedulePreview(PREVIEW_DELAY_MS);
    }

    // Preview --------------------------------------------------------------

    _buildPreview() {
        this._image = new St.Widget({
            style_class: 'froonty-formulas-image',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._message = wrapping(new St.Label({
            style_class: 'froonty-formulas-message',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        }));
        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
        });
        box.add_child(this._image);
        box.add_child(this._message);
        this._previewBox = new St.ScrollView({
            style_class: 'froonty-formulas-preview',
            hscrollbar_policy: St.PolicyType.AUTOMATIC,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
            child: box,
        });
        this._main.add_child(this._previewBox);
        this._showMessage(_('The formula shows here.'), 'hint');
    }

    _showMessage(text, kind) {
        this._image.hide();
        this._image.content = null;
        this._message.text = text;
        for (const k of ['hint', 'error'])
            this._message.remove_style_class_name(`froonty-formulas-${k}`);
        this._message.add_style_class_name(`froonty-formulas-${kind}`);
        this._message.show();
    }

    _schedulePreview(delay) {
        if (this._previewTimer)
            GLib.source_remove(this._previewTimer);
        this._previewTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._previewTimer = 0;
            this._updatePreview();
            return GLib.SOURCE_REMOVE;
        });
    }

    async _updatePreview() {
        const tex = this._editor.text;
        this._rendered = null;
        if (!tex.trim()) {
            this._previewKey = null;
            this._showMessage(_('The formula shows here.'), 'hint');
            return;
        }
        const token = {};
        this._previewKey = token;
        const available = await this._service.available();
        if (this._destroyed || this._previewKey !== token)
            return;
        if (!available) {
            this._previewKey = null;
            this._showMessage(_('Formulas are drawn by MathJax, which is not installed yet. In Froonty’s source folder, run “make mathjax”, then “make install”.'), 'hint');
            return;
        }
        const display = this._settings.get_boolean(DISPLAY_KEY);
        const scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const color = this._previewBox.get_stage()
            ? hex(this._previewBox.get_theme_node().get_foreground_color()) : '#ffffff';
        const request = {tex, display, color, scale: PREVIEW_SCALE * scaleFactor};
        const key = JSON.stringify(request);
        this._previewKey = key;
        let result;
        try {
            result = await this._service.render(request, {channel: 'preview'});
        } catch (e) {
            if (this._destroyed || this._previewKey !== key || e.kind === 'superseded' ||
                e.kind === 'stopped' || !e.kind)
                return;
            this._showMessage(_(errorText(e.kind, e.message)), 'error');
            return;
        }
        // Text typed since: a newer request is on its way.
        if (this._destroyed || this._previewKey !== key)
            return;
        this._showImage(result);
        this._rendered = tex;
    }

    _showImage({png, width, height}) {
        const loader = new GdkPixbuf.PixbufLoader();
        let pixbuf;
        try {
            loader.write_bytes(png);
            loader.close();
            pixbuf = loader.get_pixbuf();
        } catch (e) {
            try {
                loader.close();
            } catch {}
            this._showMessage(_('The preview could not be shown.'), 'error');
            return;
        }
        const context = global.stage.context.get_backend().get_cogl_context();
        const content = St.ImageContent.new_with_preferred_size(width, height);
        content.set_bytes(context, pixbuf.read_pixel_bytes(),
            pixbuf.get_has_alpha() ? Cogl.PixelFormat.RGBA_8888 : Cogl.PixelFormat.RGB_888,
            pixbuf.width, pixbuf.height, pixbuf.rowstride);
        this._image.set_size(width, height);
        this._image.content = content;
        this._message.hide();
        this._image.show();
    }

    // Tools ----------------------------------------------------------------

    _buildTools() {
        const row = new St.BoxLayout({style_class: 'froonty-formulas-tools'});
        this._displayButton = button('froonty-formulas-toggle', _('Display'));
        this._displayButton.toggle_mode = true;
        this._tooltip.attach(this._displayButton, () => (this._displayButton.checked
            ? _('Preview as a formula on its own line ($$…$$)')
            : _('Preview as a formula inside a line ($…$)')));
        this._starButton = new St.Button({
            style_class: 'froonty-icon-button froonty-formulas-star',
            can_focus: true,
            track_hover: true,
            child: new St.Icon({icon_name: 'non-starred-symbolic'}),
        });
        this._starButton.connect('clicked', () => this._service.toggleFavourite(this._editor.text));
        this._tooltip.attach(this._starButton, () => this._starButton.accessible_name);
        row.add_child(this._displayButton);
        row.add_child(this._starButton);
        row.add_child(new St.Widget({x_expand: true}));

        this._copyButtons = [
            ['inline', '$…$', _('Copy as $…$, for inside a line of a note')],
            ['display', '$$…$$', _('Copy as $$…$$, for a line of its own')],
            ['raw', _('Raw'), _('Copy the LaTeX as it is')],
        ].map(([format, label, tip]) => {
            const copy = button('froonty-formulas-copy', label, tip);
            copy.connect('clicked', () => this._copy(format));
            this._tooltip.attach(copy, () => tip);
            row.add_child(copy);
            return copy;
        });
        this._noteButton = button('froonty-formulas-note', _('Into note'),
            _('Put the formula into the open note, as $…$ at its cursor'));
        this._noteButton.connect('clicked', () => this._insertIntoNote());
        this._tooltip.attach(this._noteButton, () => this._noteButton.accessible_name);
        row.add_child(this._noteButton);
        this._main.add_child(row);

        this._status = wrapping(new St.Label({style_class: 'froonty-formulas-status', visible: false}));
        this._main.add_child(this._status);
    }

    _syncTools() {
        const tex = this._editor.text.trim();
        for (const b of [...this._copyButtons, this._noteButton, this._starButton])
            b.reactive = Boolean(tex);
        const starred = Boolean(tex) && isFavourite(this._service.favourites, tex);
        this._starButton.child.icon_name = starred ? 'starred-symbolic' : 'non-starred-symbolic';
        this._starButton.accessible_name = starred ? _('Unstar this formula') : _('Star this formula');
        this._starButton.checked = starred;
    }

    _setStatus(text, error = false) {
        this._status.text = text;
        this._status.visible = Boolean(text);
        if (error)
            this._status.add_style_class_name('froonty-formulas-error');
        else
            this._status.remove_style_class_name('froonty-formulas-error');
    }

    _copy(format) {
        const tex = this._editor.text;
        if (!tex.trim())
            return;
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, copyText(tex, format));
        this._service.addRecent(tex);
        this._setStatus({
            inline: _('Copied as $…$.'),
            display: _('Copied as $$…$$.'),
            raw: _('Copied the LaTeX.'),
        }[format]);
    }

    _insertIntoNote() {
        const tex = this._editor.text;
        if (!tex.trim())
            return;
        if (!this._settings.get_boolean('notes-enabled')) {
            this._setStatus(_('The Notes tab is off. Turn it on in Settings → Notes.'), true);
            return;
        }
        const name = this._ctx.featureView?.('notes')?.insertText?.(copyText(tex, 'inline')) ?? null;
        if (name === null) {
            this._setStatus(_('No note is open. Open one in the Notes tab, then try again.'), true);
            return;
        }
        this._service.addRecent(tex);
        this._setStatus(_('Put into “%s”.').format(name));
    }

    // Panels ---------------------------------------------------------------

    _buildPanels() {
        const tabs = new St.BoxLayout({style_class: 'froonty-formulas-panels'});
        this._panelButtons = new Map();
        for (const panel of PANELS) {
            const b = button('froonty-formulas-panel-button', _(panel.label));
            b.toggle_mode = true;
            b.connect('clicked', () => this._selectPanel(panel.id));
            this._panelButtons.set(panel.id, b);
            tabs.add_child(b);
        }
        this._main.add_child(tabs);

        this._panelArea = new St.Widget({
            style_class: 'froonty-formulas-panel',
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });
        this._main.add_child(this._panelArea);
        this._panels = new Map();
        this._lists = new Map();
    }

    _selectPanel(id) {
        this._panel = id;
        for (const [panelId, b] of this._panelButtons)
            b.checked = panelId === id;
        if (!this._panels.has(id)) {
            const actor = {
                symbols: () => this._buildSymbols(),
                templates: () => this._buildTemplates(),
                recent: () => this._buildList('recent'),
                favourites: () => this._buildList('favourites'),
                guide: () => this._buildGuide(),
            }[id]();
            this._panels.set(id, actor);
            this._panelArea.add_child(actor);
        }
        for (const [panelId, actor] of this._panels)
            actor.visible = panelId === id;
        if (id === 'recent' || id === 'favourites')
            this._fillList(id);
    }

    _symbolButton(symbol) {
        const b = button('froonty-formulas-symbol', symbol.glyph, shown(symbol.insert));
        b.connect('clicked', () => this.insert(symbol.insert));
        this._tooltip.attach(b, () => (symbol.words
            ? `${shown(symbol.insert)} · ${symbol.words}` : shown(symbol.insert)));
        return b;
    }

    _buildSymbols() {
        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
        });
        this._search = new St.Entry({
            style_class: 'froonty-formulas-search',
            hint_text: _('Search symbols: alpha, approx, integral… (Enter inserts the first)'),
            can_focus: true,
            x_expand: true,
        });
        this._search.clutter_text.connect('text-changed', () => this._syncSearch());
        this._search.clutter_text.connect('activate', () => {
            const [first] = searchSymbols(this._search.text);
            if (!first)
                return;
            this._search.text = '';
            this.insert(first.insert);
        });
        box.add_child(this._search);

        // Every section, made once; a search shows its matches instead.
        this._sections = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        for (const section of SECTIONS) {
            this._sections.add_child(new St.Label({
                style_class: 'froonty-formulas-heading',
                text: _(section.title),
            }));
            const row = flow();
            for (const symbol of section.symbols)
                row.add_child(this._symbolButton(symbol));
            this._sections.add_child(row);
        }
        this._results = flow();
        this._noResults = new St.Label({
            style_class: 'froonty-formulas-hint',
            text: _('No symbol by that name.'),
            visible: false,
        });
        const content = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        content.add_child(this._sections);
        content.add_child(this._results);
        content.add_child(this._noResults);
        this._symbolScroll = scrolled(content);
        box.add_child(this._symbolScroll);
        this._syncSearch();
        return box;
    }

    _syncSearch() {
        const query = this._search.text.trim();
        this._results.destroy_all_children();
        const matches = query ? searchSymbols(query) : [];
        for (const symbol of matches)
            this._results.add_child(this._symbolButton(symbol));
        this._sections.visible = !query;
        this._results.visible = matches.length > 0;
        this._noResults.visible = Boolean(query) && matches.length === 0;
        this._symbolScroll.vadjustment.value = 0;
    }

    _buildTemplates() {
        const row = flow();
        for (const template of TEMPLATES) {
            const content = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                style_class: 'froonty-formulas-template-content',
            });
            content.add_child(new St.Label({
                style_class: 'froonty-formulas-template-glyph',
                text: template.glyph,
                x_align: Clutter.ActorAlign.CENTER,
            }));
            content.add_child(new St.Label({
                style_class: 'froonty-formulas-template-label',
                text: _(template.label),
                x_align: Clutter.ActorAlign.CENTER,
            }));
            const b = new St.Button({
                style_class: 'froonty-formulas-button froonty-formulas-template',
                accessible_name: _(template.label),
                can_focus: true,
                track_hover: true,
                child: content,
            });
            b.connect('clicked', () => this.insert(template.insert));
            this._tooltip.attach(b, () => shown(template.insert));
            row.add_child(b);
        }
        return scrolled(row);
    }

    _buildList(id) {
        const list = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'froonty-formulas-list',
            x_expand: true,
        });
        this._lists.set(id, list);
        return scrolled(list);
    }

    _listsChanged(id) {
        this._syncTools();
        if (this._panel === id)
            this._fillList(id);
        else
            this._lists.get(id)?.destroy_all_children();
    }

    _fillList(id) {
        const list = this._lists.get(id);
        list.destroy_all_children();
        const items = id === 'recent' ? this._service.recent : this._service.favourites;
        if (items.length === 0) {
            list.add_child(wrapping(new St.Label({
                style_class: 'froonty-formulas-hint',
                text: id === 'recent'
                    ? _('Formulas you copy or put into a note show here.')
                    : _('Star a formula (☆ above) to keep it here.'),
            })));
            return;
        }
        const favourites = this._service.favourites;
        for (const tex of items) {
            const row = new St.BoxLayout({style_class: 'froonty-formulas-item'});
            const open = new St.Button({
                style_class: 'froonty-formulas-item-text',
                accessible_name: tex,
                can_focus: true,
                track_hover: true,
                x_expand: true,
                child: new St.Label({text: tex.replace(/\s*\n\s*/g, ' '), x_align: Clutter.ActorAlign.START}),
            });
            open.child.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            open.connect('clicked', () => this._setFormula(tex));
            const starred = favourites.includes(tex);
            const star = new St.Button({
                style_class: 'froonty-icon-button froonty-formulas-star',
                accessible_name: starred ? _('Unstar this formula') : _('Star this formula'),
                can_focus: true,
                track_hover: true,
                child: new St.Icon({icon_name: starred ? 'starred-symbolic' : 'non-starred-symbolic'}),
            });
            star.connect('clicked', () => this._service.toggleFavourite(tex));
            row.add_child(open);
            row.add_child(star);
            if (id === 'recent') {
                const remove = new St.Button({
                    style_class: 'froonty-icon-button',
                    accessible_name: _('Remove from the recent formulas'),
                    can_focus: true,
                    track_hover: true,
                    child: new St.Icon({icon_name: 'window-close-symbolic'}),
                });
                remove.connect('clicked', () => this._service.removeRecent(tex));
                row.add_child(remove);
            }
            list.add_child(row);
        }
    }

    _buildGuide() {
        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'froonty-formulas-guide',
            x_expand: true,
        });
        for (const topic of GUIDE) {
            box.add_child(new St.Label({style_class: 'froonty-formulas-heading', text: _(topic.title)}));
            box.add_child(wrapping(new St.Label({
                style_class: 'froonty-formulas-guide-text',
                text: _(topic.text),
            })));
            const example = new St.Button({
                style_class: 'froonty-formulas-example',
                accessible_name: _('Try “%s”').format(topic.example),
                can_focus: true,
                track_hover: true,
                x_align: Clutter.ActorAlign.START,
                child: new St.Label({text: topic.example}),
            });
            example.connect('clicked', () => this._setFormula(topic.example));
            this._tooltip.attach(example, () => _('Put it into the editor'));
            box.add_child(example);
        }
        return scrolled(box);
    }
}
