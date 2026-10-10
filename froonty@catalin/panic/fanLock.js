// SPDX-License-Identifier: GPL-3.0-or-later
// Panic button "Fan lock": turns the cooling pad off and locks it there
// (llano.py lock), so no program that drives the pad through llano.py can
// start it; a second click unlocks it, back to the speed it had. Checked,
// with the crossed-out fan, while locked. It follows llano.py's lock file
// with a file monitor, so a lock from the command line shows too
// (docs/features/fan.md).

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {fanIcon, fanOffIcon} from '../features/fan/icon.js';
import {llano, stateDir} from '../features/fan/pad.js';

export class FanLockButton {
    /**
     * @param {string} title accessible name
     * @param {object} actions
     * @param {Gio.Settings} actions.settings Froonty's
     */
    constructor(title, {settings}) {
        this._title = title;
        this._settings = settings;
        this._busy = false;
        this._failed = '';
        this.actor = new St.Button({
            style_class: 'froonty-icon-button froonty-panic-button froonty-panic-fan-lock',
            accessible_name: title,
            can_focus: true,
            track_hover: true,
            child: new St.Icon({gicon: fanIcon()}),
        });
        this.actor.connect('clicked', () => this._toggle());

        // llano.py creates the folder on its first write; watched from now on.
        GLib.mkdir_with_parents(stateDir(), 0o700);
        this._lockFile = Gio.File.new_for_path(`${stateDir()}/lock`);
        this._monitor = this._lockFile.monitor_file(Gio.FileMonitorFlags.NONE, null);
        this._monitorId = this._monitor.connect('changed', () => this._sync());
        this._sync();
    }

    destroy() {
        this._monitor.disconnect(this._monitorId);
        this._monitor.cancel();
        this.actor.destroy();
    }

    get _locked() {
        return this._lockFile.query_exists(null);
    }

    async _toggle() {
        if (this._busy)
            return;
        this._busy = true;
        this._sync();
        const {error, message} = await llano(this._settings.get_string('fan-llano-path'),
            [this._locked ? 'unlock' : 'lock']);
        this._busy = false;
        this._failed = error ? message : '';
        this._sync();
    }

    _sync() {
        const locked = this._locked;
        this.actor.checked = locked;
        this.actor.reactive = !this._busy;
        this.actor.child.gicon = locked ? fanOffIcon() : fanIcon();
        const state = locked ? _('locked off; click to start it again') : _('click to turn it off and lock it');
        this.actor.accessible_name = this._failed
            ? _('%s: failed (%s)').format(this._title, this._failed)
            : _('%s: %s').format(this._title, state);
    }
}
