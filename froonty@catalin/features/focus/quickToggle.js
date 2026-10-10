// SPDX-License-Identifier: GPL-3.0-or-later
// Focus in Quick Settings (docs/features/focus.md): a toggle with a menu of
// the modes, like macOS's Focus in Control Center. The toggle switches
// between Auto and the last mode chosen; the menu picks one. Sleeping and
// Away also show an icon in the top bar. Opening Froonty while Focus is
// Away (after a login or an unlock: the Shell turns extensions off on the
// lock screen) asks whether you are back; Focus never changes by itself.
//
// An extension part (extension.js): it lives while Froonty runs and
// follows focus-enabled itself.

import Gio from 'gi://Gio';
import GObject from 'gi://GObject';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import {QuickMenuToggle, SystemIndicator} from 'resource:///org/gnome/shell/ui/quickSettings.js';

import {MODES, modePath, readMode, writeMode} from './mode.js';

const LABELS = {
    working: () => _('Working'),
    sleeping: () => _('Sleeping'),
    away: () => _('Away from home'),
    auto: () => _('Auto'),
};
const ICONS = {
    working: 'computer-symbolic',
    sleeping: 'weather-clear-night-symbolic',
    away: 'go-home-symbolic',
    auto: 'preferences-system-time-symbolic',
};
// Shown in the top bar: the modes that change what the computer does.
const PANEL_MODES = new Set(['sleeping', 'away']);

const FocusToggle = GObject.registerClass(
class FocusToggle extends QuickMenuToggle {
    _init(onPick) {
        super._init({title: _('Focus'), iconName: ICONS.auto, toggleMode: false});
        this._onPick = onPick;
        this._last = 'working';
        this.menu.setHeader(ICONS.working, _('Focus'),
            _('Where you are: the cooling pad and the laptop fans follow'));
        this._items = new Map();
        for (const mode of MODES) {
            const item = new PopupMenu.PopupMenuItem(LABELS[mode]());
            item.connect('activate', () => this._onPick(mode));
            this.menu.addMenuItem(item);
            this._items.set(mode, item);
        }
        this.connect('clicked', () => this._onPick(this.checked ? 'auto' : this._last));
    }

    sync(mode, last) {
        this._last = last;
        this.checked = mode !== 'auto';
        this.subtitle = LABELS[mode]();
        this.iconName = ICONS[mode];
        for (const [m, item] of this._items)
            item.setOrnament(m === mode ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
    }
});

export class FocusPart {
    constructor(settings) {
        this._settings = settings;
        this._indicator = null;
        this._toggle = null;
        this._icon = null;
        this._monitor = null;
        this._notification = null;
        this._mode = 'auto';
        settings.connectObject('changed::focus-enabled', () => this._sync(), this);
        this._sync();
    }

    destroy() {
        this._settings.disconnectObject(this);
        this._hide();
        this._settings = null;
    }

    _sync() {
        if (this._settings.get_boolean('focus-enabled'))
            this._show();
        else
            this._hide();
    }

    _show() {
        if (this._indicator)
            return;
        this._indicator = new SystemIndicator();
        this._icon = this._indicator._addIndicator();
        this._toggle = new FocusToggle(mode => this._pick(mode));
        this._indicator.quickSettingsItems.push(this._toggle);
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);

        // A program outside the Shell may change the mode too.
        const file = Gio.File.new_for_path(modePath());
        try {
            file.get_parent().make_directory_with_parents(null);
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
                logError(e, 'Froonty Focus');
        }
        this._monitor = file.monitor_file(Gio.FileMonitorFlags.NONE, null);
        this._monitor.connectObject('changed', () => this._refresh(), this);
        this._refresh();
        if (this._mode === 'away')
            this._askBack();
    }

    _hide() {
        this._notification?.destroy();
        this._notification = null;
        this._monitor?.disconnectObject(this);
        this._monitor?.cancel();
        this._monitor = null;
        if (this._toggle) {
            // Quick Settings keep the toggle's menu in an overlay: it goes too.
            this._toggle.menu.destroy();
            this._toggle.destroy();
        }
        this._toggle = null;
        this._indicator?.destroy();
        this._indicator = null;
        this._icon = null;
    }

    _pick(mode) {
        if (mode !== 'auto')
            this._settings.set_string('focus-last', mode);
        try {
            writeMode(mode);
        } catch (e) {
            logError(e, 'Froonty Focus');
        }
        this._refresh();
    }

    _refresh() {
        if (!this._toggle)
            return;
        this._mode = readMode();
        const last = this._settings.get_string('focus-last');
        this._toggle.sync(this._mode, MODES.includes(last) && last !== 'auto' ? last : 'working');
        this._icon.icon_name = ICONS[this._mode];
        this._icon.visible = PANEL_MODES.has(this._mode);
        if (this._mode !== 'away') {
            this._notification?.destroy();
            this._notification = null;
        }
    }

    _askBack() {
        const source = MessageTray.getSystemSource();
        const notification = new MessageTray.Notification({
            source,
            title: _('Focus is Away from home'),
            body: _('Back? While Focus is Away, the cooling pad and the laptop fans run without noise limits.'),
            iconName: ICONS.away,
            isTransient: false,
        });
        notification.addAction(_('I’m back: Working'), () => this._pick('working'));
        notification.addAction(_('Still away'), () => {});
        notification.connectObject('destroy', () => {
            if (this._notification === notification)
                this._notification = null;
        }, this);
        this._notification = notification;
        source.addNotification(notification);
    }
}
