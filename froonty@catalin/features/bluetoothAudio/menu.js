// SPDX-License-Identifier: GPL-3.0-or-later
// Bluetooth in GNOME's Sound Output menu: paired headphones and speakers,
// each one click from connected and made the sound output, and "Pair New
// Device…", which opens Settings → Bluetooth. Hidden while Bluetooth is off
// or absent. While it shows, the volume slider keeps its >, which GNOME
// shows only with more than one output.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GnomeBluetooth from 'gi://GnomeBluetooth?version=3.0';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import {Spinner} from 'resource:///org/gnome/shell/ui/animation.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {getMixer} from '../../shell/mixer.js';
import {gnomeItem, whenQuickSettings} from '../../shell/quickSettings.js';
import {isOutputOf, listedDevices} from './devices.js';

// As ui/status/bluetooth.js does; a second call changes nothing.
Gio._promisify(GnomeBluetooth.Client.prototype, 'connect_service');

const KEY = 'sound-bluetooth-menu';
// How long a newly connected device's sound output may take to appear.
const OUTPUT_WAIT_MS = 20000;
const DEVICE_PROPS = ['alias', 'icon', 'type', 'uuids', 'paired', 'trusted', 'connectable', 'connected'];

// A device's row, as GNOME's Bluetooth menu draws it.
class DeviceRow {
    constructor(device, onClick) {
        this.device = device;
        this.busy = false;
        this.item = new PopupMenu.PopupBaseMenuItem({style_class: 'bt-device-item'});
        this._icon = new St.Icon({style_class: 'popup-menu-icon'});
        this._label = new St.Label({x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._subtitle = new St.Label({style_class: 'device-subtitle', y_align: Clutter.ActorAlign.CENTER});
        this._spinner = new Spinner(16, {hideOnStop: true});
        for (const child of [this._icon, this._label, this._subtitle, this._spinner])
            this.item.add_child(child);
        this.item.label_actor = this._label;
        this.item.connect('destroy', () => (this._spinner = null));
        // Activating an item closes the whole menu (PopupMenuBase.itemActivated);
        // this one stays open, to show the device connect and become the output.
        this.item.activate = () => onClick(this);
        this.sync();
    }

    sync() {
        const {device} = this;
        this._icon.icon_name = device.icon;
        this._label.text = device.alias ?? '';
        this._subtitle.text = device.connected ? _('Disconnect') : _('Connect');
        this._subtitle.visible = !this.busy;
        this.item.accessible_name = (device.connected ? _('Disconnect %s') : _('Connect to %s'))
            .format(this._label.text);
    }

    setBusy(busy) {
        if (!this._spinner)
            return;
        this.busy = busy;
        if (busy)
            this._spinner.play();
        else
            this._spinner.stop();
        this.sync();
    }
}

export class BluetoothOutputs {
    constructor(settings) {
        this._settings = settings;
        this._output = null;
        this._client = null;
        this._section = null;
        this._menu = null;
        this._devices = null;
        // Device → its row, and the devices whose changes are followed.
        this._rows = new Map();
        this._followed = new Set();
        this._syncId = 0;
        this._follow = null;
        this._cancellable = null;
        this._cancel = whenQuickSettings((quickSettings, last) => {
            const output = gnomeItem(quickSettings, 'volumeOutput');
            if (output)
                this._attach(output);
            return Boolean(output) || last;
        });
    }

    destroy() {
        this._cancel();
        this._settings.disconnectObject(this);
        this._removeSection();
        this._output = null;
        this._settings = null;
    }

    _attach(output) {
        this._output = output;
        this._settings.connectObject(`changed::${KEY}`, () => this._syncSetting(), this);
        this._syncSetting();
    }

    _syncSetting() {
        const wanted = this._settings.get_boolean(KEY);
        if (wanted && !this._section)
            this._addSection();
        else if (!wanted)
            this._removeSection();
    }

    _addSection() {
        this._cancellable = new Gio.Cancellable();
        this._client = new GnomeBluetooth.Client();
        const queue = () => this._queueSync();
        this._client.connectObject(
            'notify::default-adapter', queue,
            'notify::default-adapter-powered', queue,
            'device-added', queue,
            'device-removed', queue,
            this);

        const section = new PopupMenu.PopupMenuSection();
        // A labelled separator, which the menu never hides on its own.
        section.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(_('Bluetooth')));
        this._devices = new PopupMenu.PopupMenuSection();
        section.addMenuItem(this._devices);
        section.addSettingsAction(_('Pair New Device…'), 'gnome-bluetooth-panel.desktop');

        // Before GNOME's separator and Sound Settings, under its outputs.
        const menu = this._output.menu;
        const position = menu._getMenuItems().findIndex(item => item instanceof PopupMenu.PopupSeparatorMenuItem);
        menu.addMenuItem(section, position < 0 ? undefined : position);
        this._section = section;
        this._menu = menu;
        // GNOME sets it again whenever an output comes or goes.
        this._output.connectObject('notify::menu-enabled', () => this._syncArrow(), this);
        this._sync();
    }

    _syncArrow() {
        if (this._section?.actor.visible) {
            if (!this._output.menuEnabled)
                this._output.menuEnabled = true;
            return;
        }
        // GNOME's own rule, as ui/status/volume.js sets it.
        const outputs = this._output._deviceItems;
        if (outputs)
            this._output.menuEnabled = outputs.size > 1;
    }

    _removeSection() {
        if (!this._section)
            return;
        this._stopFollowing();
        this._cancellable.cancel();
        this._cancellable = null;
        if (this._syncId)
            GLib.source_remove(this._syncId);
        this._syncId = 0;
        for (const device of this._followed)
            device.disconnectObject(this);
        this._followed.clear();
        this._rows.clear();
        this._client.disconnectObject(this);
        this._client = null;
        this._output.disconnectObject(this);
        // The menu tracks a section by it, and a section (not a GObject)
        // is not let go of when destroyed.
        this._menu.disconnectObject(this._section);
        this._section.destroy();
        this._section = null;
        this._devices = null;
        this._menu = null;
        this._syncArrow();
    }

    // GnomeBluetooth notifies each change on its own; one sync for a burst.
    _queueSync() {
        if (this._syncId)
            return;
        this._syncId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._syncId = 0;
            this._sync();
            return GLib.SOURCE_REMOVE;
        });
    }

    _sync() {
        const store = this._client.get_devices();
        const all = [];
        for (let i = 0; i < store.get_n_items(); i++)
            all.push(store.get_item(i));

        // A new adapter brings new device objects.
        for (const device of this._followed) {
            if (!all.includes(device)) {
                device.disconnectObject(this);
                this._followed.delete(device);
            }
        }
        for (const device of all) {
            if (this._followed.has(device))
                continue;
            device.connectObject(
                ...DEVICE_PROPS.flatMap(prop => [`notify::${prop}`, () => this._queueSync()]),
                this);
            this._followed.add(device);
        }

        const on = this._client.default_adapter_powered;
        this._section.actor.visible = on;
        this._syncArrow();
        const listed = on ? listedDevices(all) : [];
        for (const [device, row] of this._rows) {
            if (!listed.includes(device)) {
                row.item.destroy();
                this._rows.delete(device);
            }
        }
        listed.forEach((device, i) => {
            let row = this._rows.get(device);
            if (!row) {
                row = new DeviceRow(device, clicked => this._toggle(clicked).catch(logError));
                this._devices.addMenuItem(row.item);
                this._rows.set(device, row);
            }
            row.sync();
            this._devices.moveMenuItem(row.item, i);
        });
    }

    async _toggle(row) {
        if (row.busy)
            return;
        const {device} = row;
        const connect = !device.connected;
        const {address} = device;
        row.setBusy(true);
        if (connect)
            this._followOutput(address);
        try {
            await this._client.connect_service(device.get_object_path(), connect, this._cancellable);
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                console.warn(`Froonty: could not ${connect ? 'connect' : 'disconnect'} ` +
                    `"${device.alias}": ${e.message}`);
            }
            if (this._follow?.address === address)
                this._stopFollowing();
        }
        row.setBusy(false);
    }

    // Makes the device's sound output GNOME's output once it appears, as a
    // click on it in GNOME's list does, unless another output is chosen
    // meanwhile.
    _followOutput(address) {
        this._stopFollowing();
        const mixer = getMixer();
        const before = mixer.get_default_sink()?.get_id();
        const choose = () => {
            const sink = mixer.get_sinks().find(s => isOutputOf(s.get_name(), address));
            if (!sink)
                return false;
            this._stopFollowing();
            if (mixer.get_default_sink()?.get_id() !== sink.get_id()) {
                const output = mixer.lookup_device_from_stream(sink);
                if (output)
                    mixer.change_output(output);
                else
                    mixer.set_default_sink(sink);
            }
            return true;
        };
        const follow = {address, timeout: 0};
        this._follow = follow;
        mixer.connectObject(
            'stream-added', choose,
            'default-sink-changed', () => {
                if (!choose() && mixer.get_default_sink()?.get_id() !== before)
                    this._stopFollowing();
            },
            follow);
        follow.timeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, OUTPUT_WAIT_MS, () => {
            follow.timeout = 0;
            this._stopFollowing();
            return GLib.SOURCE_REMOVE;
        });
        choose();
    }

    _stopFollowing() {
        const follow = this._follow;
        if (!follow)
            return;
        this._follow = null;
        getMixer().disconnectObject(follow);
        if (follow.timeout)
            GLib.source_remove(follow.timeout);
    }
}
