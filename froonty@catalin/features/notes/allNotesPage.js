// SPDX-License-Identifier: GPL-3.0-or-later
// "All notes": a page of the settings window (GTK 4 + libadwaita; nothing
// from the Shell side) to search every note, filter by labels, and read or
// edit them. A note tab's context menu opens it; so does Settings → Notes →
// All notes. It is a subpage: the back arrow leads to the settings.
//
//   ┌ ← [+]          All notes · 12 notes ────────────────────────────┐
//   │ [Search notes          ] │ ● Plan            q4 · work [Labels]│
//   │ (work 3) (q4 1) (home 2) │ ─────────────────────────────────── │
//   │ [All|Any]        Clear   │ # Q4 plan                           │
//   │ ● Plan             16:03 │ Ship the café menu by Friday        │
//   │   Ship the café menu…    │                                     │
//   │   q4 · work              │                                     │
//   │ ● Groceries      29 Sep  │                                     │
//   └──────────────────────────┴─────────────────────────────────────┘
//
// Search words must all match (name, text or labels); selected labels
// narrow further: all of them by default, any of them as an option
// (notes-label-match). Without a search the newest notes come first; with
// one, name matches, then label matches, then text matches.
//
// Which page the window shows follows the settings-window-view key, which
// the Shell sets before it opens or raises the window; the page sets it
// when the user navigates, and back to "settings" when the window closes.
//
// The open note follows a small marker in the notes folder, in either
// direction, read again after every library refresh (the folder monitor,
// or its 2 s fallback, sees it change). `notes-last` is the fallback for
// folders without that marker.
//
// Create, rename and Trash stay in the island.

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';

import {
    gettext as _,
    ngettext,
} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {NotePane} from './allNotesNote.js';
import * as Labels from './labels.js';
import {NotesLibrary} from './library.js';
import * as Names from './names.js';
import {moveRenderSizes} from './renderSizes.js';
import {markup, searchNotes} from './search.js';

const VIEW_KEY = 'settings-window-view';
const MATCH_KEY = 'notes-label-match';
const LAST_KEY = 'notes-last';
const MAX_ROWS = 300;

// Colours of the dots (features/notes/colors.js; stylesheet.css has the
// island's), chips, the formatting bar (lit toggles in accent, as in the
// island) and the editor's search marks. One provider per process.
const CSS = `
.froonty-dot { min-width: 10px; min-height: 10px; border-radius: 5px;
    box-shadow: inset 0 0 0 1px alpha(currentColor, 0.2); }
.froonty-dot-yellow { background-color: #fff3a8; }
.froonty-dot-green { background-color: #cdefc4; }
.froonty-dot-pink { background-color: #ffcfe3; }
.froonty-dot-purple { background-color: #e2d3fb; }
.froonty-dot-blue { background-color: #cfe4ff; }
.froonty-dot-gray { background-color: #e4e4e4; }
.froonty-dot-charcoal { background-color: #3b3b3b; }
.froonty-label-chip { padding: 2px 10px; border-radius: 999px; min-height: 0; }
.froonty-label-chip .froonty-chip-count { margin-left: 4px; }
.froonty-format-button { min-width: 24px; min-height: 24px; padding: 2px 6px; }
.froonty-format-text { font-size: 0.85em; font-weight: bold; }
.froonty-format-button:checked { background-color: var(--accent-bg-color);
    color: var(--accent-fg-color); }
.froonty-format-button:checked:hover {
    background-color: color-mix(in srgb, var(--accent-bg-color) 85%, white); }
checkbutton.froonty-task-check { padding: 0; }
checkbutton.froonty-task-check > check {
    min-width: 14px; min-height: 14px; padding: 0;
    border: 2px solid #555; border-radius: 4px; background: #fffdf0; }
checkbutton.froonty-task-check:checked > check {
    border-color: #b63a10; background: #d54b17; color: white; }
button.froonty-render-resize {
    min-width: 20px; min-height: 20px; padding: 0; border-radius: 4px;
    background: alpha(#222, 0.72); color: white; font-size: 12px; }
`;
let cssAdded = false;

function addCss() {
    if (cssAdded)
        return;
    cssAdded = true;
    const provider = new Gtk.CssProvider();
    provider.load_from_string(CSS);
    Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), provider,
        Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
}

// "16:03" today, "29 Sep" this year, else "29 Sep 2025".
function formatDate(ms) {
    const time = GLib.DateTime.new_from_unix_local(Math.floor(ms / 1000));
    const now = GLib.DateTime.new_now_local();
    if (time.get_year() === now.get_year() && time.get_day_of_year() === now.get_day_of_year())
        return time.format('%R');
    return time.format(time.get_year() === now.get_year() ? '%e %b' : '%e %b %Y').trim();
}

/**
 * Adds the All notes page to the settings window: shown when the
 * settings-window-view key says 'all-notes' (also when the window opens).
 *
 * @param {Adw.PreferencesWindow} window
 * @param {Gio.Settings} settings
 * @param {Adw.NavigationView} navigationView the settings window's pages
 */
export function attachAllNotes(window, settings, navigationView) {
    let page = null;
    let pushed = false;
    const show = () => {
        if (pushed)
            return;
        page ??= new AllNotesPage(window, settings, () => (pushed = false));
        navigationView.push(page.navigationPage);
        pushed = true;
    };
    const hide = () => {
        if (pushed)
            navigationView.pop();
    };
    const sync = () => (settings.get_string(VIEW_KEY) === 'all-notes' ? show() : hide());
    const ids = [
        settings.connect(`changed::${VIEW_KEY}`, sync),
        settings.connect('changed::notes-folder', () => page?.folderChanged()),
    ];
    window.connect('notify::is-active', () => {
        if (!window.is_active)
            page?.flush();
        else if (pushed)
            page?.activated();
    });
    // After the preferences service's own handler, which forgets the
    // window: never stop the close.
    window.connect('close-request', () => {
        for (const id of ids)
            settings.disconnect(id);
        page?.close();
        if (settings.get_string(VIEW_KEY) === 'all-notes')
            settings.set_string(VIEW_KEY, 'settings');
        return false;
    });

    if (settings.get_string(VIEW_KEY) === 'all-notes') {
        window.set_default_size(900, 640);
        show();
    }
}

class AllNotesPage {
    constructor(window, settings, onHidden) {
        this._window = window;
        this._settings = settings;
        this._query = '';
        this._selected = new Map(); // label key → label (chips that are on)
        this._chipsShown = null;
        this._picked = false;
        // Shared selected note, and a note to open once it is listed.
        this._islandNote = null;
        this._follow = null;
        this._selectionSerial = 0;
        this._selectionPending = false;
        this._selectionWrite = Promise.resolve();
        this._folded = new Map(); // search.js keeps folded texts here
        addCss();

        this._library = new NotesLibrary({
            settings,
            dataDir: Gio.File.new_for_path(
                GLib.build_filenamev([GLib.get_user_data_dir(), 'froonty'])),
        });
        this._pane = new NotePane(this._library, settings, {
            onConflict: (name, copy) => {
                this._toast(_('“%s” changed elsewhere. Your version was kept as “%s”.')
                    .format(name, copy));
                this._selectRow(copy);
            },
            onRescued: (name, copy) => {
                this._toast(_('“%s” could not be saved in the previous folder. Your text was kept here as “%s”.')
                    .format(name, copy));
                this._picked = true;
                this._open(copy);
            },
            onError: message => this._toast(message),
            onRename: (name, text) => this._rename(name, text),
        });
        this._build();

        this._library.connect('changed', (_library, change) => this._onLibraryChanged(change));
        this._library.connect('renamed', (_library, from, to) => this._pane.renamed(from, to));
        this._library.connect('removed', (_library, name) => this._pane.removed(name));
        this._library.connect('refreshed', () => this._followSharedSelection());
        this._lastId = settings.connect('changed::notes-last', () => {
            if (this._library.running)
                this._followIsland();
        });

        const page = this.navigationPage;
        page.connect('showing', () => {
            const ready = this._library.start();
            // Another folder since it was last shown: the old note goes.
            this._pane.followFolder();
            ready.finally(() => this._followPreferredSelection());
        });
        page.connect('shown', () => {
            if (this._settings.get_string(VIEW_KEY) !== 'all-notes')
                this._settings.set_string(VIEW_KEY, 'all-notes');
            this._search.grab_focus();
        });
        page.connect('hiding', () => this.flush());
        page.connect('hidden', () => {
            this._library.stop();
            onHidden();
            if (this._settings.get_string(VIEW_KEY) === 'all-notes')
                this._settings.set_string(VIEW_KEY, 'settings');
        });
    }

    flush() {
        return Promise.all([this._pane.flush(), this._selectionWrite]);
    }

    close() {
        this.flush();
        this._pane.stop();
        this._library.stop();
        this._settings.disconnect(this._lastId);
    }

    /** Another notes folder: the page starts over there (now or when shown). */
    folderChanged() {
        this._picked = false;
        this._follow = null;
        if (!this._library.running)
            return; // start() sees the new folder when the page is shown
        this._library.restart().finally(() => this._followPreferredSelection());
        this._pane.followFolder();
    }

    /** The window was raised (e.g. from a note tab's context menu). */
    activated() {
        if (this._library.running)
            this._library.refresh().finally(() => this._followPreferredSelection());
        else
            this._followIsland(true);
    }

    async _followSharedSelection() {
        const store = this._library.store;
        if (!this._library.running || !store || this._selectionPending)
            return false;
        const name = await store.readCurrentNote();
        if (!this._library.running || store !== this._library.store || this._selectionPending || !name ||
            !this._library.notes.has(name))
            return false;
        if (name !== this._islandNote) {
            this._islandNote = name;
            this._follow = name;
        }
        this._applyFollow();
        return true;
    }

    async _followPreferredSelection() {
        if (this._selectionPending)
            return;
        if (!await this._followSharedSelection() && !this._selectionPending)
            this._followIsland(true);
    }

    // The island moved to another note since the window last looked:
    // open that one, as when the page first opened.
    _followIsland(force = false) {
        if (this._selectionPending)
            return;
        const last = this._settings.get_string(LAST_KEY);
        if (!last || (!force && (!this._picked || last === this._islandNote)))
            return;
        this._islandNote = last;
        this._follow = last;
        this._applyFollow();
    }

    _applyFollow() {
        const name = this._follow;
        if (name === null || !this._library.notes.has(name))
            return; // not listed yet: after the next refresh
        this._follow = null;
        if (name !== this._pane.name)
            this._open(name);
    }

    // Opens a note in the pane and selects its row; if the open note could
    // not be saved, it stays, and so does its row.
    async _open(name) {
        const serial = ++this._selectionSerial;
        this._selectionPending = Boolean(name);
        this._selectRow(name);
        try {
            if (name)
                await this._publishSelection(name);
            const shown = await this._pane.show(name);
            if (shown === false) {
                this._selectRow(this._pane.name);
                if (this._pane.name)
                    await this._publishSelection(this._pane.name);
            }
        } finally {
            if (serial === this._selectionSerial)
                this._selectionPending = false;
        }
    }

    // A note named after the time, as the island's "+" makes, opened (the
    // island follows) with the search and labels cleared so it is listed.
    // The island's service adds it to its order when the folder changes.
    async _create() {
        const store = this._library.store;
        if (!store)
            return;
        try {
            const name = Names.uniqueName(Names.timestampName(GLib.DateTime.new_now_local()),
                [...this._library.notes.keys()]);
            await store.create(name);
            this._search.text = '';
            this._query = '';
            this._clearLabels();
            this._picked = true;
            this._follow = name;
            await this._library.refresh();
            this._applyFollow();
        } catch (e) {
            this._toast(_('Could not create a note: %s').format(e.message));
        }
    }

    // As the island's rename (service.js), from this process: the file, its
    // labels, its pictures' sizes, and its place and colour. The island
    // reads those again on each refresh, so the new name goes in first,
    // beside the old one: the renamed file is never a note it does not
    // know yet (which would lose its place). Its next save drops the old.
    async _rename(from, text) {
        const store = this._library.store;
        const to = Names.cleanName(text);
        if (!store || to === from)
            return;
        if (!to) {
            this._toast(_('“%s” cannot be a note’s name').format(text.trim()));
            return;
        }
        // Refused before anything changes (store.rename refuses it too).
        if (to.toLowerCase() !== from.toLowerCase() &&
            [...this._library.notes.keys()].some(name => name.toLowerCase() === to.toLowerCase())) {
            this._toast(_('A note named “%s” already exists').format(to));
            return;
        }
        try {
            await this._pane.flush();
            const meta = await store.readMeta();
            if (meta.state !== 'unreadable') {
                const {order, colors} = meta.meta;
                const at = order.indexOf(from);
                await store.writeMeta({...meta.meta,
                    order: at < 0 ? [...order, to] : order.toSpliced(at + 1, 0, to),
                    colors: Object.hasOwn(colors, from) ? {...colors, [to]: colors[from]} : colors});
            }
            // Before the file: the island, missing the old name, takes this.
            await this._publishSelection(to);
            try {
                await store.rename(from, to);
            } catch (e) {
                await this._publishSelection(from);
                throw e;
            }
            this._pane.renamed(from, to);
            if (this._library.labelsState !== 'unreadable' &&
                (this._library.labelsOf(from).length || this._library.labelsOf(to).length))
                await store.updateLabels(data => Labels.withRename(data, from, to));
            await moveRenderSizes(store.folder, from, to);
            await this._library.refresh();
            this._selectRow(to);
        } catch (e) {
            this._toast(_('Could not rename “%s”: %s').format(from, e.message));
        }
    }

    _clearLabels() {
        this._selected.clear();
        this._chipsShown = null;
        this._renderChips();
        this._render();
    }

    _publishSelection(name) {
        this._islandNote = name;
        if (this._settings.get_string(LAST_KEY) !== name)
            this._settings.set_string(LAST_KEY, name);
        const store = this._library.store;
        if (store) {
            this._selectionWrite = this._selectionWrite.then(() => store.writeCurrentNote(name)).catch(e =>
                this._toast(_('Could not sync the selected note: %s').format(e.message)));
        }
        return this._selectionWrite;
    }

    _build() {
        this.navigationPage = new Adw.NavigationPage({tag: 'all-notes', title: _('All notes')});
        const bin = new Adw.BreakpointBin({width_request: 360, height_request: 300});
        this._split = new Adw.OverlaySplitView({
            sidebar_width_fraction: 0.38,
            min_sidebar_width: 260,
            max_sidebar_width: 380,
        });
        const narrow = new Adw.Breakpoint({condition: Adw.BreakpointCondition.parse('max-width: 600sp')});
        narrow.add_setter(this._split, 'collapsed', true);
        bin.add_breakpoint(narrow);

        this._title = new Adw.WindowTitle({title: _('All notes')});
        const header = new Adw.HeaderBar({title_widget: this._title});
        const sidebarButton = new Gtk.ToggleButton({
            icon_name: 'sidebar-show-symbolic',
            tooltip_text: _('Notes list'),
        });
        this._split.bind_property('show-sidebar', sidebarButton, 'active',
            GObject.BindingFlags.BIDIRECTIONAL | GObject.BindingFlags.SYNC_CREATE);
        this._split.bind_property('collapsed', sidebarButton, 'visible',
            GObject.BindingFlags.SYNC_CREATE);
        header.pack_end(sidebarButton);
        const newButton = new Gtk.Button({icon_name: 'list-add-symbolic', tooltip_text: _('New note')});
        newButton.connect('clicked', () => this._create());
        header.pack_start(newButton);
        this._banner = new Adw.Banner();

        const toolbar = new Adw.ToolbarView();
        toolbar.add_top_bar(header);
        toolbar.add_top_bar(this._banner);
        toolbar.set_content(this._split);
        this._toasts = new Adw.ToastOverlay({child: toolbar});
        bin.set_child(this._toasts);
        this.navigationPage.set_child(bin);

        this._split.set_sidebar(this._buildSidebar());
        this._split.set_content(this._pane.widget);

        // Ctrl+F: the search, wherever the focus is on the page.
        const shortcuts = new Gtk.ShortcutController({scope: Gtk.ShortcutScope.LOCAL});
        shortcuts.add_shortcut(new Gtk.Shortcut({
            trigger: Gtk.ShortcutTrigger.parse_string('<Control>f'),
            action: Gtk.CallbackAction.new(() => {
                this._search.grab_focus();
                return true;
            }),
        }));
        bin.add_controller(shortcuts);
    }

    _buildSidebar() {
        const sidebar = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});

        this._search = new Gtk.SearchEntry({
            placeholder_text: _('Search notes'),
            search_delay: 150,
            margin_start: 8,
            margin_end: 8,
            margin_top: 8,
            margin_bottom: 4,
        });
        this._search.connect('search-changed', () => {
            this._query = this._search.text;
            this._render();
            this._pane.highlight(this._query);
        });
        this._search.connect('activate', () => this._onSearchActivate());
        this._search.connect('stop-search', () => (this._search.text = ''));
        const keys = new Gtk.EventControllerKey();
        keys.connect('key-pressed', (_controller, keyval) => {
            if (keyval !== Gdk.KEY_Down)
                return false;
            const row = this._list.get_row_at_index(0);
            if (row?.activatable) {
                this._list.select_row(row);
                row.grab_focus();
            }
            return true;
        });
        this._search.add_controller(keys);
        sidebar.append(this._search);

        // Labels: a chip each (with how many notes have it), All/Any, Clear.
        this._labelRow = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
            margin_start: 8,
            margin_end: 8,
            margin_top: 4,
            margin_bottom: 4,
            visible: false,
        });
        this._chips = new Adw.WrapBox({child_spacing: 6, line_spacing: 6});
        this._mode = new Adw.ToggleGroup({visible: false});
        this._mode.add(new Adw.Toggle({name: 'all', label: _('All')}));
        this._mode.add(new Adw.Toggle({name: 'any', label: _('Any')}));
        this._settings.bind(MATCH_KEY, this._mode, 'active-name', Gio.SettingsBindFlags.DEFAULT);
        this._mode.connect('notify::active-name', () => this._render());
        this._clear = new Gtk.Button({label: _('Clear'), css_classes: ['flat'], visible: false});
        this._clear.connect('clicked', () => this._clearLabels());
        const modeRow = new Gtk.Box({spacing: 6});
        modeRow.append(this._mode);
        modeRow.append(new Gtk.Box({hexpand: true}));
        modeRow.append(this._clear);
        this._labelRow.append(this._chips);
        this._labelRow.append(modeRow);
        sidebar.append(this._labelRow);

        this._list = new Gtk.ListBox({
            selection_mode: Gtk.SelectionMode.SINGLE,
            css_classes: ['navigation-sidebar'],
        });
        this._placeholder = new Adw.StatusPage({
            icon_name: 'edit-find-symbolic',
            css_classes: ['compact'],
        });
        this._list.set_placeholder(this._placeholder);
        this._list.connect('row-selected', (_list, row) => {
            if (this._syncingRow || !row?._noteName)
                return;
            this._follow = null; // the user's choice
            this._picked = true;
            this._open(row._noteName);
            if (this._split.collapsed)
                this._split.show_sidebar = false;
        });
        this._search.set_key_capture_widget(this._list);
        sidebar.append(new Gtk.ScrolledWindow({
            vexpand: true,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            child: this._list,
        }));
        return sidebar;
    }

    // Enter in the search: into the note, at the first match. That is the
    // open note while it is listed; otherwise the first result, which is
    // opened (never typing into a note the search hides).
    async _onSearchActivate() {
        if (this._search.text !== this._query) {
            // Enter before the search delay ran out.
            this._query = this._search.text;
            this._render();
            this._pane.highlight(this._query);
        }
        if (this._pane.name === null || !this._rowOf(this._pane.name)) {
            const first = this._list.get_row_at_index(0);
            if (!first?._noteName)
                return;
            this._follow = null;
            this._selectRow(first._noteName);
            if (await this._pane.show(first._noteName) !== true) {
                this._selectRow(this._pane.name);
                return;
            }
        }
        this._pane.focusEditor();
    }

    _onLibraryChanged(change) {
        const library = this._library;
        this._pane.libraryChanged(change);
        this._banner.title = library.error
            ? _('The notes folder could not be read: %s').format(library.error)
            : [
                library.labelsState === 'unreadable'
                    ? _('Labels could not be read (.froonty-labels.json)') : '',
                library.metaState === 'unreadable'
                    ? _('Note colours could not be read (.froonty.json)') : '',
            ].filter(Boolean).join(' · ');
        this._banner.revealed = Boolean(this._banner.title);

        // Only the open note changed, by our own saving: rows hold still.
        const writer = this._pane.writer;
        const open = this._pane.name;
        const ours = !change.structure && change.names.length > 0 &&
            change.names.every(name => name === open) && writer &&
            (writer.dirty || writer.busy || library.notes.get(open)?.text === writer.base);
        if (!ours) {
            this._renderChips();
            this._render();
        }

        // First load: the note last used in the island, else the newest.
        if (!this._picked && !library.error) {
            this._picked = true;
            const last = this._settings.get_string(LAST_KEY);
            // showing() may already have queued the island's current note
            // while this folder was loading. Keep that selection through the
            // first list refresh instead of letting an older cached row win.
            const following = this._follow;
            this._islandNote = following ?? last;
            this._follow = null;
            const newest = [...library.notes.values()].sort((a, b) => b.modified - a.modified)[0];
            const pick = following && library.notes.has(following) ? following
                : library.notes.has(last) ? last : newest?.name ?? null;
            if (pick)
                this._open(pick);
        }
        this._applyFollow();
    }

    _renderChips() {
        const all = this._library.allLabels();
        const keys = new Set(all.map(({label}) => Labels.labelKey(label)));
        for (const key of [...this._selected.keys()]) {
            if (!keys.has(key))
                this._selected.delete(key);
        }
        const shown = JSON.stringify([all, [...this._selected.keys()]]);
        if (shown !== this._chipsShown) {
            this._chipsShown = shown;
            for (let child; (child = this._chips.get_first_child());)
                this._chips.remove(child);
            for (const {label, count} of all) {
                const key = Labels.labelKey(label);
                const content = new Gtk.Box();
                content.append(new Gtk.Label({label}));
                content.append(new Gtk.Label({
                    label: String(count),
                    css_classes: ['dim-label', 'froonty-chip-count'],
                }));
                const chip = new Gtk.ToggleButton({
                    child: content,
                    active: this._selected.has(key),
                    css_classes: ['froonty-label-chip'],
                    tooltip_text: ngettext('%d note', '%d notes', count).format(count),
                });
                chip.connect('toggled', () => {
                    if (chip.active)
                        this._selected.set(key, label);
                    else
                        this._selected.delete(key);
                    this._chipsShown = JSON.stringify([this._library.allLabels(),
                        [...this._selected.keys()]]);
                    this._syncLabelControls();
                    this._render();
                });
                this._chips.append(chip);
            }
        }
        this._labelRow.visible = all.length > 0;
        this._syncLabelControls();
    }

    _syncLabelControls() {
        this._mode.visible = this._selected.size >= 2;
        this._clear.visible = this._selected.size > 0;
    }

    // The list for the search, chips and mode. Runs only when one of those
    // or the notes change (not as the open note is typed into), so rows do
    // not move under the pointer.
    _render() {
        const library = this._library;
        const notes = [...library.notes.values()].map(note => ({
            ...note,
            labels: library.labelsOf(note.name),
        }));
        const results = searchNotes(notes, {
            query: this._query,
            labels: [...this._selected.values()],
            mode: this._settings.get_string(MATCH_KEY),
        }, this._folded);
        for (const name of [...this._folded.keys()]) {
            if (!library.notes.has(name))
                this._folded.delete(name);
        }
        this._title.subtitle = ngettext('%d note', '%d notes', notes.length).format(notes.length);
        this._placeholder.title = notes.length ? _('No matching notes') : _('No notes yet');

        this._list.remove_all();
        for (const result of results.slice(0, MAX_ROWS))
            this._list.append(this._row(result));
        if (results.length > MAX_ROWS) {
            this._list.append(new Gtk.ListBoxRow({
                activatable: false,
                selectable: false,
                child: new Gtk.Label({
                    label: _('Showing %d of %d — refine the search').format(MAX_ROWS, results.length),
                    css_classes: ['dim-label', 'caption'],
                    margin_top: 6,
                    margin_bottom: 6,
                }),
            }));
        }
        this._selectRow(this._pane.name);
    }

    _row({note, nameRanges, snippet}) {
        const line = new Gtk.Box({spacing: 8});
        line.append(new Gtk.Box({
            css_classes: ['froonty-dot', `froonty-dot-${this._library.colorOf(note.name)}`],
            valign: Gtk.Align.CENTER,
        }));
        line.append(new Gtk.Label({
            label: markup(note.name, nameRanges),
            use_markup: true,
            ellipsize: Pango.EllipsizeMode.END,
            xalign: 0,
            hexpand: true,
        }));
        line.append(new Gtk.Label({
            label: formatDate(note.modified),
            css_classes: ['dim-label', 'caption'],
        }));

        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 2,
            margin_top: 4,
            margin_bottom: 4,
        });
        box.append(line);
        if (snippet.text) {
            box.append(new Gtk.Label({
                label: markup(snippet.text, snippet.ranges),
                use_markup: true,
                wrap: true,
                wrap_mode: Pango.WrapMode.WORD_CHAR,
                lines: 2,
                ellipsize: Pango.EllipsizeMode.END,
                max_width_chars: 30,
                xalign: 0,
            }));
        }
        if (note.labels.length) {
            box.append(new Gtk.Label({
                label: note.labels.join(' · '),
                css_classes: ['dim-label', 'caption'],
                ellipsize: Pango.EllipsizeMode.END,
                xalign: 0,
            }));
        }
        const row = new Gtk.ListBoxRow({child: box});
        row._noteName = note.name;
        return row;
    }

    _rowOf(name) {
        for (let child = this._list.get_first_child(); child; child = child.get_next_sibling()) {
            if (name !== null && child._noteName === name)
                return child;
        }
        return null;
    }

    // Selects the open note's row, if listed, without opening it again.
    _selectRow(name) {
        const row = this._rowOf(name);
        this._syncingRow = true;
        if (row)
            this._list.select_row(row);
        else
            this._list.unselect_all();
        this._syncingRow = false;
    }

    _toast(text) {
        this._toasts.add_toast(new Adw.Toast({title: text, use_markup: false, timeout: 5}));
    }
}
