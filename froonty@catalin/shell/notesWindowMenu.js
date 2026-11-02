// SPDX-License-Identifier: GPL-3.0-or-later
// Adds the selected note's labels to GNOME Shell's native window menu (the
// menu with Take Screenshot, Move, Always on Top, and Close).

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as WindowMenu from 'resource:///org/gnome/shell/ui/windowMenu.js';

import * as Labels from '../features/notes/labels.js';
import * as Names from '../features/notes/names.js';
import {NotesStore} from '../features/notes/store.js';

const PREFS_SERVICE = 'org.gnome.Shell.Extensions';
const VIEW_KEY = 'settings-window-view';
const FOLDER_KEY = 'notes-folder';
const RENAME_REQUEST_KEY = 'all-notes-title-request';

/**
 * Patches Shell's native window menu while enabled, adding label toggles when
 * the menu belongs to Froonty's All notes window.
 */
export class NotesWindowMenu {
    constructor(settings, translate = text => text) {
        this._settings = settings;
        this._translate = translate;
        this._prototype = WindowMenu.WindowMenu.prototype;
        this._originalBuildMenu = this._prototype._buildMenu;
        const extension = this;
        this._buildMenu = function (window) {
            extension._originalBuildMenu.call(this, window);
            extension._appendLabels(this, window);
        };
        this._prototype._buildMenu = this._buildMenu;
    }

    destroy() {
        if (this._prototype._buildMenu === this._buildMenu)
            this._prototype._buildMenu = this._originalBuildMenu;
        this._settings = null;
    }

    _appendLabels(menu, window) {
        if (!this._settings || window.get_wm_class() !== PREFS_SERVICE ||
            this._settings.get_string(VIEW_KEY) !== 'all-notes')
            return;

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        menu.addAction(this._translate('Change note title'), () => this._requestTitleChange());
        const labels = new PopupMenu.PopupSubMenuMenuItem(this._translate('Labels'));
        menu.addMenuItem(labels);
        labels.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this._fillLabels(labels.menu);
        });
    }

    async _fillLabels(menu) {
        menu.removeAll();
        const store = this._store();
        const noteName = await store.readCurrentNote();
        if (!this._settings || !noteName) {
            this._appendEmpty(menu, this._translate('No note selected'));
            return;
        }

        const result = await store.readLabels();
        if (!this._settings)
            return;
        if (result.state === 'unreadable') {
            this._appendEmpty(menu, this._translate('Labels cannot be read'));
            return;
        }

        const assigned = new Set(Labels.labelsOf(result.data, noteName).map(Labels.labelKey));
        const all = [...new Set(Object.values(result.data.labels).flat())]
            .sort(Names.compareNames);
        if (!all.length) {
            this._appendEmpty(menu, this._translate('No labels yet'));
            return;
        }
        for (const label of all) {
            const key = Labels.labelKey(label);
            const item = new PopupMenu.PopupMenuItem(label);
            if (assigned.has(key))
                item.setOrnament(PopupMenu.Ornament.CHECK);
            item.connect('activate', () => {
                store.updateLabels(data => Labels.withLabel(data, noteName, label,
                    !assigned.has(key))).catch(e => logError(e, 'Froonty: could not update note labels'));
            });
            menu.addMenuItem(item);
        }
    }

    async _requestTitleChange() {
        if (!this._settings)
            return;
        const noteName = await this._store().readCurrentNote();
        if (!this._settings || !noteName)
            return;
        this._settings.set_string(RENAME_REQUEST_KEY, JSON.stringify({
            id: GLib.uuid_string_random(),
            name: noteName,
        }));
    }

    _appendEmpty(menu, text) {
        const item = new PopupMenu.PopupMenuItem(text);
        item.setSensitive(false);
        menu.addMenuItem(item);
    }

    _store() {
        const path = this._settings.get_string(FOLDER_KEY);
        const folder = path
            ? Gio.File.new_for_path(path)
            : Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_data_dir(), 'froonty', 'notes']));
        return new NotesStore(folder);
    }
}
