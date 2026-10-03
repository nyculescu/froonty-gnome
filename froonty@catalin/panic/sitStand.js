// SPDX-License-Identifier: GPL-3.0-or-later
// Panic button "Sitting or standing": switches the Break tab's sit/stand
// tracker (docs/features/break.md). Checked while standing; its icon is
// the current posture. Insensitive unless the Break tab and its sit/stand
// tracking are on; it holds the shared break service only then, and
// follows both settings.

import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {subjectIcon} from '../features/break/icons.js';
import {acquireBreakService, releaseBreakService} from '../features/break/shared.js';

const KEYS = ['break-enabled', 'posture-enabled'];

export class SitStandButton {
    /**
     * @param {string} title accessible name
     * @param {object} actions
     * @param {Gio.Settings} actions.settings Froonty's
     */
    constructor(title, {settings}) {
        this._title = title;
        this._settings = settings;
        this._service = null;
        this._serviceId = 0;
        this.actor = new St.Button({
            style_class: 'froonty-icon-button froonty-panic-button froonty-panic-posture',
            accessible_name: title,
            can_focus: true,
            track_hover: true,
            child: new St.Icon({gicon: subjectIcon('stand')}),
        });
        this.actor.connect('clicked', () => this._toggle());
        this._settingsIds = KEYS.map(key => settings.connect(`changed::${key}`, () => this._syncHold()));
        this._syncHold();
    }

    destroy() {
        for (const id of this._settingsIds)
            this._settings.disconnect(id);
        this._settingsIds = [];
        this._release();
        this.actor.destroy();
    }

    get _usable() {
        return KEYS.every(key => this._settings.get_boolean(key));
    }

    _syncHold() {
        if (this._usable && !this._service) {
            this._service = acquireBreakService(this._settings).service;
            this._serviceId = this._service.connect('changed', () => this._sync());
        } else if (!this._usable) {
            this._release();
        }
        this._sync();
    }

    _release() {
        if (!this._service)
            return;
        this._service.disconnect(this._serviceId);
        this._service = null;
        this._serviceId = 0;
        releaseBreakService();
    }

    _toggle() {
        if (!this._service?.loaded)
            return;
        const standing = this._service.state.posture.mode === 'standing';
        this._service.setPosture(standing ? 'sitting' : 'standing');
    }

    _sync() {
        const usable = Boolean(this._service?.loaded);
        const standing = usable && this._service.state.posture.mode === 'standing';
        this.actor.reactive = usable;
        this.actor.checked = standing;
        this.actor.child.gicon = subjectIcon(standing ? 'stand' : 'sit');
        this.actor.accessible_name = !this._usable
            ? _('%s: off (turn on in Settings → Break)').format(this._title)
            : _('%s: %s').format(this._title, standing ? _('standing') : _('sitting'));
    }
}
