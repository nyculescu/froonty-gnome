// SPDX-License-Identifier: GPL-3.0-or-later
// "Panic buttons" settings tab: which buttons are in the bar (at most 5),
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
    const inBar = new Adw.PreferencesGroup({
        title: _('In the bar'),
        description: _('Up to 5, at the top of the island, in this order'),
    });
    const available = new Adw.PreferencesGroup({
        title: _('Available'),
        description: _('More panic buttons will come in later versions'),
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

        const ids = sanitize(settings.get_strv(KEY));
        const save = next => settings.set_strv(KEY, next);
        ids.forEach((id, i) => add(inBar, barRow(id, i, ids, save)));
        if (ids.length === 0)
            add(inBar, new Adw.ActionRow({title: _('No panic buttons')}));

        const full = ids.length >= MAX_PANIC_BUTTONS;
        for (const {id} of PANIC_BUTTONS.filter(b => !ids.includes(b.id)))
            add(available, availableRow(id, full, () => save([...ids, id])));
        if (PANIC_BUTTONS.every(b => ids.includes(b.id)))
            add(available, new Adw.ActionRow({title: _('All buttons are in the bar')}));
    };
    settings.connect(`changed::${KEY}`, rebuild);
    rebuild();
    return page;
}

// A button in the bar: move up, move down, remove.
function barRow(id, index, ids, save) {
    const row = entryRow(id);
    const move = delta => {
        const next = [...ids];
        [next[index], next[index + delta]] = [next[index + delta], next[index]];
        save(next);
    };
    row.add_suffix(iconButton('go-up-symbolic', _('Move up'), index > 0, () => move(-1)));
    row.add_suffix(iconButton('go-down-symbolic', _('Move down'), index < ids.length - 1,
        () => move(1)));
    row.add_suffix(iconButton('list-remove-symbolic', _('Remove'), true,
        () => save(ids.filter(i => i !== id))));
    return row;
}

function availableRow(id, full, onAdd) {
    const row = entryRow(id);
    const button = iconButton('list-add-symbolic', _('Add'), !full, onAdd);
    if (full)
        button.tooltip_text = _('The bar holds at most 5 buttons');
    row.add_suffix(button);
    return row;
}

function entryRow(id) {
    const entry = byId(id);
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
