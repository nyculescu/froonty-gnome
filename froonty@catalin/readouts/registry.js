// SPDX-License-Identifier: GPL-3.0-or-later
// Shell-side factories for the readouts in catalog.js. A readout is an icon
// and a value, never reactive: a click or hover falls through to the pill.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {sparkIcon} from '../features/claude/icon.js';
import {SESSION, WEEKLY} from '../features/claude/usage.js';
import {cpuIcon, gpuIcon, memoryIcon, thermometerIcon} from '../features/sysmon/icon.js';
import {
    dayOffsetAt, dayOffsetLabel, dayOffsetName, favoriteCities, formatTimeAt, plannerTimeFormat,
} from '../features/timezonePlanner/clock.js';
import {byId} from './catalog.js';
import {METRICS, claudeUsage, shortCityName} from './values.js';

const themed = name => () => Gio.ThemedIcon.new(name);

const METRIC_ICONS = {
    'cpu-load': cpuIcon,
    'gpu-load': gpuIcon,
    'ram-usage': memoryIcon,
    'cpu-temp': cpuIcon,
    'cpu-temp-max': thermometerIcon,
    'gpu-temp': gpuIcon,
    'net-down': themed('go-down-symbolic'),
    'net-up': themed('go-up-symbolic'),
    'disk-used': themed('drive-harddisk-symbolic'),
};

class Readout {
    /**
     * @param {string} title
     * @param {object} parts
     * @param {?Function} parts.icon → Gio.Icon, or null for a value alone
     * @param {string} [parts.styleClass]
     * @param {Function} parts.read (sources) → a value (values.js), null when
     *   unknown, or undefined to keep what shows
     * @param {string} [parts.source] 'metrics' or 'claude', when it needs one
     */
    constructor(title, {icon, styleClass = '', read, source = null}) {
        this._title = title;
        this._read = read;
        this.source = source;
        this._valueClass = null;
        this._kind = null;
        this.actor = new St.BoxLayout({
            style_class: `froonty-readout ${styleClass}`,
            y_align: Clutter.ActorAlign.CENTER,
        });
        if (icon) {
            this.actor.add_child(new St.Icon({
                gicon: icon(),
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }
        this._label = new St.Label({
            style_class: 'froonty-readout-value',
            text: '–',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.actor.add_child(this._label);
        // A small mark after the value, raised as flight times have their +1.
        this._badge = new St.Label({
            style_class: 'froonty-readout-badge',
            y_align: Clutter.ActorAlign.START,
            visible: false,
        });
        this.actor.add_child(this._badge);
        this.accessibleText = null;
    }

    destroy() {
        this.actor.destroy();
    }

    /**
     * @param {object} sources {metrics, claude, settings, clock}
     * @returns {boolean} whether what it prints changed
     */
    sync(sources) {
        const value = this._read(sources);
        if (value === undefined)
            return false;
        const text = value?.text ?? '?';
        const name = value?.title ?? this._title;
        let accessible = _('%s: unknown').format(name);
        if (value?.asleep)
            accessible = _('%s: asleep').format(name);
        else if (value)
            accessible = _('%s: %s').format(name, text);
        if (value?.badgeName)
            accessible = `${accessible}, ${value.badgeName}`;
        const badge = value?.badge ?? '';
        const changed = text !== this._label.text || badge !== this._badge.text ||
            this.actor.visible !== !value?.hidden;
        this._label.text = text;
        this._badge.text = badge;
        this._badge.visible = badge !== '';
        this.actor.visible = !value?.hidden;
        this.accessibleText = value?.hidden ? null : accessible;
        this._setClass('_valueClass', this._label, value?.styleClass ?? null);
        // Kept while unknown or asleep, so the pill keeps its width.
        if (value?.kind)
            this._setClass('_kind', this.actor, `froonty-readout-${value.kind}`);
        this._label.set_style(value?.color ? `color: ${value.color};` : null);
        return changed;
    }

    _setClass(field, actor, styleClass) {
        if (this[field] === styleClass)
            return;
        if (this[field])
            actor.remove_style_class_name(this[field]);
        if (styleClass)
            actor.add_style_class_name(styleClass);
        this[field] = styleClass;
    }
}

// Before its second reading the load is not known yet, and the sampler
// starts anew on each collapse: what shows stays until then.
const metric = id => ({
    icon: METRIC_ICONS[id],
    source: 'metrics',
    read: ({metrics}) => (metrics.samples < 2 ? undefined : METRICS[id].read(metrics.snapshot)),
});

const claude = kind => ({
    icon: sparkIcon,
    styleClass: 'froonty-readout-claude',
    source: 'claude',
    read: ({claude: service}) => (service.loaded
        ? claudeUsage(service.usage, service.online, kind, Date.now()) : undefined),
});

// The city's short name and its time, on the clock's ticks, in a colour of
// its own so it is not read as the local time; hidden without that
// favourite. +1 or −1 when its date is not the local one.
const timezone = index => ({
    icon: null,
    styleClass: 'froonty-readout-timezone',
    read: ({settings, clock}) => {
        const city = favoriteCities(settings.get_strv('timezone-planner-cities'),
            settings.get_strv('timezone-planner-favorites'))[index];
        if (!city)
            return {text: '', hidden: true};
        const format = plannerTimeFormat(settings.get_string('timezone-planner-time-format'),
            clock.timeFormat());
        const now = GLib.DateTime.new_now_utc().to_unix();
        const time = formatTimeAt(now, city.timezone, format);
        const offset = dayOffsetAt(now, city.timezone);
        return {
            text: `${shortCityName(city.name)} ${time}`,
            title: city.name,
            badge: dayOffsetLabel(offset),
            badgeName: dayOffsetName(offset, _),
        };
    },
});

const PARTS = {
    ...Object.fromEntries(Object.keys(METRICS).map(id => [id, metric(id)])),
    'claude-session': claude(SESSION),
    'claude-weekly': claude(WEEKLY),
    'timezone-1': timezone(0),
    'timezone-2': timezone(1),
};

/**
 * @param {string} id
 * @returns {?Readout} a readout, or null for an unknown id
 */
export function createReadout(id) {
    const entry = byId(id);
    const parts = PARTS[id];
    return entry && parts ? new Readout(entry.title(_), parts) : null;
}
