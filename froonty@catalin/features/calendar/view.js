// SPDX-License-Identifier: GPL-3.0-or-later
// Calendar tab (docs/features/calendar.md §B):
//
//   ┌ month grid ─────────┐ │ [Day][Week][Month]
//   │ ‹    October     ›  │ │ 28 Sep – 4 Oct · Week 40
//   │ wk M T W T F S S    │ │ Today · Fri 2 Oct
//   │ …                   │ │ ▌Standup                     [Now]
//   │ [Google ↗] [⚙ GOA]  │ │ ▌09:00 – 09:15 · Work (Google)
//   └─────────────────────┘ │ Unavailable: …   (only if any)
//
// Or, instead of both columns, why there is nothing to show: the EDS
// bindings are missing, EDS did not answer, or there is no calendar.
//
// Listens to the service's 'changed' and the clock's minute ticks (the
// top bar's own clock; Froonty has no timer for this), nothing else.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Agenda, calendarName, dayName} from './agenda.js';
import {MonthGrid, monthLabel} from './monthGrid.js';
import {dateKey, isoWeek} from './range.js';

const GRANULARITY_LABELS = [
    ['day', () => _('Day')],
    ['week', () => _('Week')],
    ['month', () => _('Month')],
];
const EN_DASH = '–';
// Buttons per row under the grid (web calendars, then Online Accounts).
const PROVIDERS_PER_ROW = 2;
const localDate = date => GLib.DateTime.new_local(date.y, date.m, date.d, 12, 0, 0);

export class CalendarView {
    /**
     * @param {object} ctx feature context: `clock` (ClockService)
     * @param {CalendarService} service
     */
    constructor(ctx, service) {
        this._clock = ctx.clock;
        this._service = service;
        this._active = false;
        this._scrollPending = false;
        this._todayKey = null;
        this._providersKey = null;
        this._translate = text => Shell.util_translate_time_string(text);

        this.actor = new St.Widget({
            style_class: 'froonty-calendar',
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });
        this._body = new St.BoxLayout({style_class: 'froonty-calendar-body', x_expand: true, y_expand: true});
        this._body.add_child(this._buildLeft());
        this._body.add_child(new St.Widget({style_class: 'froonty-calendar-divider', y_expand: true}));
        this._body.add_child(this._buildRight());
        this.actor.add_child(this._body);
        this.actor.add_child(this._buildHint());

        this._serviceId = service.connect('changed', () => this._refresh());
        this._clockId = this._clock.connect('changed', () => this._onClock());
        this._refresh();
    }

    destroy() {
        this._service.disconnect(this._serviceId);
        this._clock.disconnect(this._clockId);
        this.actor.destroy();
    }

    /** On screen: back to today, scrolled to it (the service reset the selection). */
    setActive(active) {
        this._active = active;
        if (active) {
            this._scrollPending = true;
            this._refresh();
        }
    }

    _buildLeft() {
        const left = new St.BoxLayout({
            style_class: 'froonty-calendar-left',
            orientation: Clutter.Orientation.VERTICAL,
        });
        const service = this._service;
        this.grid = new MonthGrid({
            previous: () => this._then(() => service.showMonth(-1)),
            next: () => this._then(() => service.showMonth(1)),
            today: () => this._then(() => service.today()),
            select: date => this._then(() => service.select(date)),
        }, this._translate);
        left.add_child(this.grid);

        // Rows of PROVIDERS_PER_ROW, rather than squeezing the pills;
        // Online Accounts closes the last row.
        this._providers = new St.BoxLayout({
            style_class: 'froonty-calendar-providers',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        left.add_child(this._providers);
        this.providerButtons = [];
        this._accountsButton = this._onlineAccountsButton();
        this._layoutProviders();
        return left;
    }

    _onlineAccountsButton() {
        const button = new St.Button({
            style_class: 'froonty-icon-button froonty-calendar-accounts',
            accessible_name: _('Online Accounts'),
            can_focus: true,
            track_hover: true,
            child: new St.Icon({icon_name: 'goa-panel-symbolic'}),
        });
        button.connect('clicked', () => this._service.openOnlineAccounts());
        return button;
    }

    _buildRight() {
        const right = new St.BoxLayout({
            style_class: 'froonty-calendar-right',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
        });
        const switcher = new St.BoxLayout({style_class: 'froonty-calendar-switch'});
        this._switchButtons = new Map();
        for (const [granularity, label] of GRANULARITY_LABELS) {
            const button = new St.Button({
                style_class: 'froonty-calendar-switch-button',
                label: label(),
                can_focus: true,
                track_hover: true,
                toggle_mode: false,
            });
            button.connect('clicked', () => this._then(() => this._service.setGranularity(granularity)));
            switcher.add_child(button);
            this._switchButtons.set(granularity, button);
        }
        right.add_child(switcher);

        this._title = new St.Label({style_class: 'froonty-calendar-title', x_expand: true});
        right.add_child(this._title);

        this.agenda = new Agenda({
            open: (entry, date) => this._service.openOccurrence(entry, date),
        }, this._clock);
        right.add_child(this.agenda);

        this._footer = new St.Label({style_class: 'froonty-calendar-footer', x_expand: true, visible: false});
        right.add_child(this._footer);
        return right;
    }

    _buildHint() {
        this._hint = new St.BoxLayout({
            style_class: 'froonty-calendar-hint',
            orientation: Clutter.Orientation.VERTICAL,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: true,
            visible: false,
        });
        this._hint.add_child(new St.Icon({
            style_class: 'froonty-calendar-hint-icon',
            icon_name: 'x-office-calendar-symbolic',
            x_align: Clutter.ActorAlign.CENTER,
        }));
        this._hintTitle = new St.Label({style_class: 'froonty-calendar-hint-title'});
        this._hintBody = new St.Label({style_class: 'froonty-calendar-hint-body'});
        for (const label of [this._hintTitle, this._hintBody]) {
            // Wrapped in full; centred by the stylesheet's text-align.
            label.clutter_text.line_wrap = true;
            label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            this._hint.add_child(label);
        }
        this._hintButton = new St.Button({
            style_class: 'froonty-calendar-hint-button',
            label: _('Online Accounts'),
            can_focus: true,
            track_hover: true,
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._hintButton.connect('clicked', () => this._service.openOnlineAccounts());
        this._hint.add_child(this._hintButton);
        return this._hint;
    }

    // A choice in the tab moves the agenda to the chosen day.
    _then(action) {
        this._scrollPending = true;
        action();
    }

    _onClock() {
        if (!this._active || this._service.state !== 'ready')
            return;
        // A new time zone reopens the views; 'changed' follows.
        if (this._service.clockChanged())
            return;
        if (dateKey(this._service.todayDate()) !== this._todayKey ||
            !this.agenda.refreshStates(this._service.agenda()))
            this._refresh();
    }

    /** What the tab shows instead of the calendar, or null. */
    _hintText() {
        const service = this._service;
        switch (service.state) {
        case 'missing':
            return {
                title: _('Install gir1.2-ecal-2.0 to see your calendars’ events'),
                body: _('Then open this tab again. Calendars come from the accounts in Settings → Online Accounts (Google, Microsoft 365, Nextcloud, …) and from GNOME Calendar or Evolution.'),
                button: true,
            };
        case 'error':
            return service.errorKind === 'bindings' ? {
                title: _('The calendar bindings (gir1.2-ecal-2.0) could not be loaded'),
                body: [service.errorMessage, _('Log out and back in after fixing the installation.')]
                    .filter(Boolean).join('\n'),
                button: false,
            } : {
                title: _('GNOME’s calendar service (Evolution Data Server) did not answer'),
                body: [service.errorMessage, _('Froonty tries again the next time this tab is opened.')]
                    .filter(Boolean).join('\n'),
                button: false,
            };
        case 'ready':
            return service.calendars.length === 0 ? {
                title: _('No calendars to show'),
                body: _('Connect an account in Settings → Online Accounts, or turn calendars on in Froonty’s Calendar settings.'),
                button: true,
            } : null;
        default:
            return null;
        }
    }

    _refresh() {
        const hint = this._hintText();
        this._hint.visible = hint !== null;
        this._body.visible = hint === null;
        if (hint) {
            this._hintTitle.text = hint.title;
            this._hintBody.text = hint.body;
            this._hintButton.visible = hint.button;
            return;
        }

        const service = this._service;
        const today = service.todayDate();
        this._todayKey = dateKey(today);
        const grid = service.grid();
        this.grid.update(grid, today.y);
        this._syncProviders();

        for (const [granularity, button] of this._switchButtons)
            button.checked = granularity === service.granularity;

        const agenda = service.agenda();
        this._title.text = this._titleText(agenda, grid, today);
        this.agenda.update(agenda, this._scrollPending);
        if (!agenda.loading)
            this._scrollPending = false;

        const unavailable = service.unavailable;
        this._footer.visible = unavailable.length > 0;
        this._footer.text = unavailable.length
            ? _('Unavailable: %s').format(unavailable.map(calendarName).join(', ')) : '';
    }

    _titleText(agenda, grid, today) {
        if (agenda.granularity === 'day')
            return dayName(agenda.selected, today);
        if (agenda.granularity === 'month')
            return monthLabel(agenda.selected, today.y, this._translate);
        const days = agenda.span.days;
        const range = `${localDate(days[0]).format('%-d %b')} ${EN_DASH} ${localDate(days.at(-1)).format('%-d %b')}`;
        if (!grid.showWeekNumbers)
            return range;
        const thursday = days.find(date => localDate(date).get_day_of_week() === 4) ?? days[0];
        return `${range} · ${_('Week %d').format(isoWeek(thursday))}`;
    }

    // One pill per web calendar (and account), opening it on the
    // selected day; then Online Accounts.
    _syncProviders() {
        const providers = this._service.providers();
        const key = JSON.stringify(providers.map(p => [p.kind, p.account, p.showAccount]));
        if (key === this._providersKey)
            return;
        this._providersKey = key;
        this._accountsButton.get_parent()?.remove_child(this._accountsButton);
        this._providers.destroy_all_children();
        this.providerButtons = providers.map(provider => {
            const local = provider.showAccount ? provider.account.split('@')[0] : null;
            const text = local ? `${provider.label} · ${local}` : provider.label;
            const content = new St.BoxLayout({style_class: 'froonty-calendar-provider-content'});
            content.add_child(new St.Icon({icon_name: 'web-browser-symbolic', y_align: Clutter.ActorAlign.CENTER}));
            content.add_child(new St.Label({text, y_align: Clutter.ActorAlign.CENTER}));
            const button = new St.Button({
                style_class: 'froonty-calendar-provider',
                accessible_name: _('Open %s on the selected day').format(text),
                can_focus: true,
                track_hover: true,
                child: content,
            });
            button.connect('clicked', () => this._service.openProvider(provider));
            return button;
        });
        this._layoutProviders();
    }

    _layoutProviders() {
        const buttons = [...this.providerButtons, this._accountsButton];
        for (let i = 0; i < buttons.length; i += PROVIDERS_PER_ROW) {
            const row = new St.BoxLayout({style_class: 'froonty-calendar-provider-row'});
            for (const button of buttons.slice(i, i + PROVIDERS_PER_ROW))
                row.add_child(button);
            this._providers.add_child(row);
        }
    }
}
