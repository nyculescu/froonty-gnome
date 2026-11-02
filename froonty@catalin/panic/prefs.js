// SPDX-License-Identifier: GPL-3.0-or-later
// "Panic buttons" settings tab: which buttons are in the bar (at most 8),
// in which order. Runs in the preferences process (GTK 4 + libadwaita).

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {MAX_PANIC_BUTTONS, PANIC_BUTTONS, byId, sanitize} from './catalog.js';

const KEY = 'panic-buttons';

export function panicPage(settings) {
    const page = new Adw.PreferencesPage({
        name: 'panic',
        title: _('Panic buttons'),
        icon_name: 'dialog-warning-symbolic',
    });
    addChoiceGroups(page, settings, {
        key: KEY,
        entries: PANIC_BUTTONS,
        byId,
        sanitize,
        max: MAX_PANIC_BUTTONS,
        chosenTitle: _('In the bar'),
        chosenDescription: _('Up to 8 at the top of the island, in this order: half left ' +
            'of the date pill, half right of it (one more on the right when odd)'),
        availableDescription: _('More panic buttons will come in later versions'),
        emptyText: _('No panic buttons'),
        allChosenText: _('All buttons are in the bar'),
        fullText: _('The bar holds at most 8 buttons'),
    });
    return page;
}

/**
 * Adds a page's two groups for a capped, ordered choice from a catalog:
 * what is chosen, with up, down and remove, and what is available, with Add.
 * Also the Readouts page's.
 *
 * @param {Adw.PreferencesPage} page
 * @param {Gio.Settings} settings
 * @param {object} choice
 * @param {string} choice.key the strv setting
 * @param {object[]} choice.entries the catalog
 * @param {Function} choice.byId id → its entry
 * @param {Function} choice.sanitize ids → those to show
 * @param {number} choice.max
 * @param {string} choice.chosenTitle
 * @param {string} choice.chosenDescription
 * @param {string} choice.availableDescription
 * @param {string} choice.emptyText the row while nothing is chosen
 * @param {string} choice.allChosenText the row while nothing is left
 * @param {string} choice.fullText Add's tooltip at the cap
 */
export function addChoiceGroups(page, settings, choice) {
    const {key, entries, max} = choice;
    const inBar = new Adw.PreferencesGroup({
        title: choice.chosenTitle,
        description: choice.chosenDescription,
    });
    const available = new Adw.PreferencesGroup({
        title: _('Available'),
        description: choice.availableDescription,
    });
    page.add(inBar);
    page.add(available);

    let rows = [];
    const rebuild = () => {
        for (const [group, row] of rows)
            group.remove(row);
        rows = [];
        const add = (group, row) => {
            group.add(row);
            rows.push([group, row]);
        };

        const ids = choice.sanitize(settings.get_strv(key));
        const save = next => settings.set_strv(key, next);
        ids.forEach((id, i) => add(inBar, barRow(choice.byId(id), i, ids, save)));
        if (ids.length === 0)
            add(inBar, new Adw.ActionRow({title: choice.emptyText}));

        const full = ids.length >= max;
        for (const {id} of entries.filter(b => !ids.includes(b.id))) {
            add(available, availableRow(choice.byId(id), full, choice.fullText,
                () => save([...ids, id])));
        }
        if (entries.every(b => ids.includes(b.id)))
            add(available, new Adw.ActionRow({title: choice.allChosenText}));
    };
    settings.connect(`changed::${key}`, rebuild);
    rebuild();
}

// A chosen entry: move up, move down, remove.
function barRow(entry, index, ids, save) {
    const row = entryRow(entry);
    const move = delta => {
        const next = [...ids];
        [next[index], next[index + delta]] = [next[index + delta], next[index]];
        save(next);
    };
    row.add_suffix(iconButton('go-up-symbolic', _('Move up'), index > 0, () => move(-1)));
    row.add_suffix(iconButton('go-down-symbolic', _('Move down'), index < ids.length - 1,
        () => move(1)));
    row.add_suffix(iconButton('list-remove-symbolic', _('Remove'), true,
        () => save(ids.filter(i => i !== entry.id))));
    return row;
}

function availableRow(entry, full, fullText, onAdd) {
    const row = entryRow(entry);
    const button = iconButton('list-add-symbolic', _('Add'), !full, onAdd);
    if (full)
        button.tooltip_text = fullText;
    row.add_suffix(button);
    return row;
}

function entryRow(entry) {
    const row = new Adw.ActionRow({title: entry.title(_)});
    // What a button does when its title cannot say it all (no markup).
    if (entry.description) {
        row.use_markup = false;
        row.subtitle = entry.description(_);
    }
    row.add_prefix(new Gtk.Image({icon_name: entry.icon}));
    return row;
}

function iconButton(icon, tooltip, sensitive, onClick) {
    const button = new Gtk.Button({
        icon_name: icon,
        tooltip_text: tooltip,
        sensitive,
        valign: Gtk.Align.CENTER,
        css_classes: ['flat'],
    });
    button.connect('clicked', onClick);
    return button;
}
