// SPDX-License-Identifier: GPL-3.0-or-later
// Night Light in a brightness menu: the Night Light switch, its warmth and
// its schedule (All day, From, To) go in the menu of GNOME's brightness
// slider (whose > Froonty turns on), or, where GNOME shows none, in
// Froonty's software brightness menu. GNOME's Night Light tile leaves the
// Quick Settings grid while a menu holds it.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';

import {gnomeItem, whenQuickSettings} from '../../shell/quickSettings.js';
import {sliderFromTemperature, temperatureFromSlider} from './levels.js';
import {allDaySchedule, clockFromHours, isAllDay, stepHour, stepMinutes, twoDigits} from './schedule.js';

const COLOR_SCHEMA = 'org.gnome.settings-daemon.plugins.color';
const ALL_DAY_KEY = 'brightness-night-light-all-day';
const SAVED_KEY = 'brightness-night-light-schedule';
const SCHEDULE_KEYS = ['night-light-schedule-from', 'night-light-schedule-to', 'night-light-schedule-automatic'];

// Software brightness's slider while it is in Quick Settings (overlay.js).
let softwareSlider = null;
const menus = new Set();

/**
 * Overlay.js says when its slider comes and goes; it calls with null
 * before destroying the slider, so Night Light leaves its menu first.
 *
 * @param {QuickSlider|null} slider with insertBeforeSettings(items)
 */
export function setSoftwareSlider(slider) {
    softwareSlider = slider;
    for (const menu of menus)
        menu._sync();
}

// A switch that flips in place: a menu item's activation closes the whole
// menu (PopupMenuBase.itemActivated), right for a list of choices, not for
// settings next to sliders and steppers.
function settingSwitch(label, state) {
    const item = new PopupMenu.PopupSwitchMenuItem(label, state);
    item.activate = () => item.toggle();
    return item;
}

// A two-digit number between - and + buttons.
function stepper(lessName, moreName, onStep) {
    const box = new St.BoxLayout({style_class: 'froonty-night-light-stepper'});
    const button = (iconName, accessibleName, delta) => {
        const b = new St.Button({
            style_class: 'icon-button froonty-night-light-step',
            can_focus: true,
            accessible_name: accessibleName,
            child: new St.Icon({icon_name: iconName}),
        });
        b.connect('clicked', () => onStep(delta));
        return b;
    };
    const less = button('list-remove-symbolic', lessName, -1);
    const more = button('list-add-symbolic', moreName, 1);
    const label = new St.Label({style_class: 'froonty-night-light-time', y_align: Clutter.ActorAlign.CENTER});
    box.add_child(less);
    box.add_child(label);
    box.add_child(more);
    return {box, label, buttons: [less, more]};
}

// A From or To row: hours and minutes, each with its own buttons.
function timeRow(title, onStep) {
    const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
    item.add_child(new St.Label({text: title, x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
    const hours = stepper(_('Hour earlier'), _('Hour later'), delta => onStep(stepHour, delta));
    const minutes = stepper(_('Minutes earlier'), _('Minutes later'), delta => onStep(stepMinutes, delta));
    item.add_child(hours.box);
    item.add_child(new St.Label({text: ':', y_align: Clutter.ActorAlign.CENTER}));
    item.add_child(minutes.box);
    return {
        item,
        show(value, enabled) {
            const [h, m] = clockFromHours(value);
            hours.label.text = twoDigits(h);
            minutes.label.text = twoDigits(m);
            for (const button of [...hours.buttons, ...minutes.buttons]) {
                button.reactive = enabled;
                button.can_focus = enabled;
            }
            if (enabled)
                item.remove_style_pseudo_class('insensitive');
            else
                item.add_style_pseudo_class('insensitive');
        },
    };
}

export class NightLightMenu {
    constructor(settings) {
        this._settings = settings;
        this._color = new Gio.Settings({schema_id: COLOR_SCHEMA});
        // All day ends once the schedule is changed elsewhere (GNOME
        // Settings), even with the menu not shown or Froonty off meanwhile.
        this._color.connectObject(
            ...SCHEDULE_KEYS.flatMap(key => [`changed::${key}`, () => this._checkAllDay()]),
            this);
        this._checkAllDay();
        this._brightness = null;
        this._toggle = null;
        this._section = null;
        this._separator = null;
        // The menu the separator and section were added to.
        this._parent = null;
        this._host = null;
        this._hidTile = false;
        this._cancel = whenQuickSettings((quickSettings, last) => {
            const brightness = gnomeItem(quickSettings, 'brightness');
            const toggle = gnomeItem(quickSettings, 'nightLight');
            if (brightness && toggle)
                this._attach(brightness, toggle);
            return Boolean(brightness && toggle) || last;
        });
    }

    destroy() {
        this._cancel();
        this._settings.disconnectObject(this);
        this._detach();
        this._color.disconnectObject(this);
        this._color = null;
        this._settings = null;
    }

    _attach(brightness, toggle) {
        this._brightness = brightness;
        this._toggle = toggle;
        menus.add(this);
        this._settings.connectObject('changed::brightness-night-light-menu', () => this._sync(), this);
        // After GNOME's own handler, which sets menuEnabled from the
        // number of monitors (ui/status/brightness.js).
        Main.brightnessManager.connectObject('changed', () => this._sync(), this);
        brightness.connectObject('notify::visible', () => this._sync(), this);
        // GNOME binds the tile's visibility to night-light-supported.
        global.backend.get_monitor_manager().connectObject(
            'notify::night-light-supported', () => this._sync(), this);
        toggle.connectObject('notify::visible', () => this._sync(), this);
        this._sync();
    }

    _detach() {
        if (!this._brightness)
            return;
        menus.delete(this);
        Main.brightnessManager.disconnectObject(this);
        global.backend.get_monitor_manager().disconnectObject(this);
        this._brightness.disconnectObject(this);
        this._toggle.disconnectObject(this);
        this._removeSection();
        this._restoreTile();
        this._brightness = null;
        this._toggle = null;
    }

    // GNOME's slider while it shows (a backlight), else Software
    // brightness's; none without Night Light support or with the setting
    // off, and then everything is as GNOME has it.
    _wantedHost() {
        if (!this._settings.get_boolean('brightness-night-light-menu') ||
            !global.backend.get_monitor_manager().night_light_supported)
            return null;
        return this._brightness.visible ? this._brightness : softwareSlider;
    }

    _sync() {
        const host = this._wantedHost();
        if (host !== this._host) {
            this._removeSection();
            if (host)
                this._addSection(host);
        }
        if (host === this._brightness)
            this._brightness.menuEnabled = true;
        // Hiding or showing the tile comes back here through notify::visible,
        // with the host already settled.
        if (host) {
            this._hidTile = true;
            if (this._toggle.visible)
                this._toggle.hide();
        } else {
            this._restoreTile();
        }
    }

    // As ui/status/nightLight.js binds it, if Froonty hid it.
    _restoreTile() {
        if (!this._hidTile)
            return;
        this._hidTile = false;
        this._toggle.visible = global.backend.get_monitor_manager().night_light_supported;
    }

    _schedule() {
        return {
            from: this._color.get_double('night-light-schedule-from'),
            to: this._color.get_double('night-light-schedule-to'),
            automatic: this._color.get_boolean('night-light-schedule-automatic'),
        };
    }

    _savedSchedule() {
        const [from, to, automatic] = this._settings.get_value(SAVED_KEY).deepUnpack();
        return {from, to, automatic};
    }

    _writeSchedule({from, to, automatic}) {
        this._color.set_boolean('night-light-schedule-automatic', automatic);
        this._color.set_double('night-light-schedule-from', from);
        this._color.set_double('night-light-schedule-to', to);
    }

    _checkAllDay() {
        if (this._settings.get_boolean(ALL_DAY_KEY) && !isAllDay(this._schedule()))
            this._settings.set_boolean(ALL_DAY_KEY, false);
    }

    // The flag is set after the schedule and cleared before it, so
    // _checkAllDay never sees All day on with the schedule half written.
    _setAllDay(on) {
        if (on === this._settings.get_boolean(ALL_DAY_KEY))
            return;
        if (on) {
            const schedule = this._schedule();
            this._settings.set_value(SAVED_KEY,
                new GLib.Variant('(ddb)', [schedule.from, schedule.to, schedule.automatic]));
            this._writeSchedule(allDaySchedule(schedule));
            this._settings.set_boolean(ALL_DAY_KEY, true);
        } else {
            this._settings.set_boolean(ALL_DAY_KEY, false);
            this._writeSchedule(this._savedSchedule());
        }
    }

    _addSection(host) {
        const gnome = host === this._brightness;
        // In the host menu, not the section: a separator shows only with
        // visible items before and after it in its own box.
        const separator = new PopupMenu.PopupSeparatorMenuItem();
        const section = new PopupMenu.PopupMenuSection();

        const nightLight = settingSwitch(_('Night Light'), this._color.get_boolean('night-light-enabled'));
        let syncing = false;
        nightLight.connect('toggled', (_item, state) => {
            if (!syncing)
                this._color.set_boolean('night-light-enabled', state);
        });
        section.addMenuItem(nightLight);

        section.addMenuItem(new PopupMenu.PopupMenuItem(_('Warmth'), {reactive: false}));
        const slider = new Slider(0);
        slider.accessible_name = _('Night Light warmth');
        const sliderItem = new PopupMenu.PopupBaseMenuItem({reactive: false});
        sliderItem.add_child(new St.Bin({
            style_class: 'slider-bin',
            child: slider,
            reactive: true,
            can_focus: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        section.addMenuItem(sliderItem);

        slider.connect('notify::value', () => {
            if (!syncing)
                this._color.set_uint('night-light-temperature', temperatureFromSlider(slider.value));
        });

        const allDay = settingSwitch(_('All day'), false);
        allDay.connect('toggled', (_item, state) => {
            if (!syncing)
                this._setAllDay(state);
        });
        section.addMenuItem(allDay);

        const step = (key, change, delta) =>
            this._color.set_double(key, change(this._color.get_double(key), delta));
        const from = timeRow(_('From'), (change, delta) => step('night-light-schedule-from', change, delta));
        const to = timeRow(_('To'), (change, delta) => step('night-light-schedule-to', change, delta));
        section.addMenuItem(from.item);
        section.addMenuItem(to.item);
        const sunset = new PopupMenu.PopupMenuItem(_('Sunset to sunrise'), {reactive: false});
        section.addMenuItem(sunset);

        const syncColor = () => {
            syncing = true;
            nightLight.setToggleState(this._color.get_boolean('night-light-enabled'));
            slider.value = sliderFromTemperature(this._color.get_uint('night-light-temperature'));
            const on = this._settings.get_boolean(ALL_DAY_KEY);
            allDay.setToggleState(on);
            // While All day is on, the times that come back when it goes off.
            const shown = on ? this._savedSchedule() : this._schedule();
            from.item.visible = to.item.visible = !shown.automatic;
            sunset.visible = shown.automatic;
            if (on)
                sunset.add_style_pseudo_class('insensitive');
            else
                sunset.remove_style_pseudo_class('insensitive');
            from.show(shown.from, !on);
            to.show(shown.to, !on);
            syncing = false;
        };
        this._color.connectObject(
            'changed::night-light-enabled', syncColor,
            'changed::night-light-temperature', syncColor,
            ...SCHEDULE_KEYS.flatMap(key => [`changed::${key}`, syncColor]),
            section);
        this._settings.connectObject(
            `changed::${ALL_DAY_KEY}`, syncColor,
            `changed::${SAVED_KEY}`, syncColor,
            section);
        syncColor();

        // Software brightness's menu ends with its own settings.
        if (gnome) {
            section.addSettingsAction(_('Display Settings'), 'gnome-display-panel.desktop');
            host.menu.addMenuItem(separator);
            host.menu.addMenuItem(section);
        } else {
            host.insertBeforeSettings([separator, section]);
        }
        this._separator = separator;
        this._section = section;
        this._parent = host.menu;
        this._host = host;
    }

    _removeSection() {
        if (!this._section)
            return;
        this._color.disconnectObject(this._section);
        this._settings.disconnectObject(this._section);
        // The menu tracks a section by it, and a section (not a GObject)
        // is not let go of when destroyed.
        this._parent.disconnectObject(this._section);
        this._section.destroy();
        this._separator.destroy();
        this._section = null;
        this._separator = null;
        this._parent = null;
        // GNOME's own rule, as ui/status/brightness.js sets it.
        if (this._host === this._brightness)
            this._brightness.menuEnabled = Main.brightnessManager.scales.length > 1;
        this._host = null;
    }
}
