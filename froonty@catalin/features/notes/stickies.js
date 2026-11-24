// SPDX-License-Identifier: GPL-3.0-or-later
// The notes pinned to the desktop, as stickies (docs/features/notes.md):
// each a card like the desktop widgets' (owner's choice 2026-11-23, over
// the note's colour) with its name and text, drawn as the island's
// rendered view draws text (markup.js), scrolling when long; nothing
// happens on a click. Read-only: notes come from a NotesLibrary, which
// never writes .froonty.json (the island owns it).
//
// Each sticky is a desktop item of its own (owner, 2026-11-23: "Notes
// sticky 1, 2, …", each placed and sized in Settings → Widgets): the
// desktop layer puts the cards on screen. Emits 'changed' when they change.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {Emitter} from '../../core/emitter.js';
import {NotesLibrary} from './library.js';
import {noteMarkup} from './markup.js';

export class Stickies extends Emitter {
    constructor(settings) {
        super();
        this._settings = settings;
        /** Note name → its card, in the order the notes were pinned. */
        this.cards = new Map();
        // What the cards show, so a change elsewhere in the folder does not
        // rebuild them (and reset their scrolling).
        this._shown = '';
        this._library = new NotesLibrary({
            settings,
            dataDir: Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_data_dir(), 'froonty'])),
        });
        this._libraryId = this._library.connect('changed', () => this._build());
        this._library.start().catch(e => console.warn(`Froonty: desktop notes: ${e.message}`));
    }

    /** How many stickies show. */
    get count() {
        return this.cards.size;
    }

    destroy() {
        this._library.disconnect(this._libraryId);
        this._library.stop();
        for (const card of this.cards.values())
            card.destroy();
        this.cards.clear();
        this._settings = null;
    }

    _build() {
        const notes = this._library.pinned.map(name => [name, this._library.notes.get(name)?.text ?? '']);
        const shown = JSON.stringify(notes);
        if (shown === this._shown)
            return;
        this._shown = shown;
        for (const card of this.cards.values())
            card.destroy();
        this.cards = new Map(notes.map(([name, text]) => [name, this._card(name, text)]));
        this.emit('changed');
    }

    // Reactive for the scroll wheel; no click.
    _card(name, text) {
        const card = new St.BoxLayout({
            style_class: 'froonty-desktop-widget froonty-desktop-sticky',
            vertical: true,
            reactive: true,
            accessible_name: name,
        });
        const title = new St.Label({style_class: 'froonty-widgets-status froonty-desktop-sticky-title', text: name});
        title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        card.add_child(title);
        if (text.trim()) {
            const body = new St.Label({style_class: 'froonty-desktop-sticky-text', x_expand: true});
            // Whole: a scroll view's content gets its minimum height, and
            // an ellipsizing label's minimum is one line.
            body.clutter_text.set({
                line_wrap: true,
                line_wrap_mode: Pango.WrapMode.WORD_CHAR,
                ellipsize: Pango.EllipsizeMode.NONE,
            });
            body.clutter_text.set_markup(noteMarkup(text));
            const content = new St.BoxLayout({vertical: true, x_expand: true});
            content.add_child(body);
            card.add_child(new St.ScrollView({
                style_class: 'froonty-desktop-sticky-scroll',
                hscrollbar_policy: St.PolicyType.NEVER,
                vscrollbar_policy: St.PolicyType.AUTOMATIC,
                overlay_scrollbars: true,
                x_expand: true,
                child: content,
            }));
        }
        return card;
    }
}
