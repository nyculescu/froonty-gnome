// SPDX-License-Identifier: GPL-3.0-or-later
// "Widget Lock" in Quick Settings, while something is on the desktop: on,
// the desktop cards and stickies ignore the pointer, so clicks and
// scrolling reach the desktop (and Desktop Icons) under them.

import GObject from 'gi://GObject';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import {QuickToggle} from 'resource:///org/gnome/shell/ui/quickSettings.js';

const KEY = 'widgets-desktop-locked';

export const WidgetLockToggle = GObject.registerClass(
class WidgetLockToggle extends QuickToggle {
    _init(settings) {
        super._init({title: _('Widget Lock'), toggleMode: true});
        this._settings = settings;
        this._syncing = false;
        this.connect('notify::checked', () => {
            if (!this._syncing)
                this._settings.set_boolean(KEY, this.checked);
            this._syncIcon();
        });
        this._settingsId = settings.connect(`changed::${KEY}`, () => this._sync());
        this.connect('destroy', () => settings.disconnect(this._settingsId));
        this._sync();
    }

    _sync() {
        this._syncing = true;
        this.checked = this._settings.get_boolean(KEY);
        this._syncing = false;
        this._syncIcon();
    }

    _syncIcon() {
        this.iconName = this.checked ? 'changes-prevent-symbolic' : 'changes-allow-symbolic';
    }
});
