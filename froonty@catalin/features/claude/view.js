// SPDX-License-Identifier: GPL-3.0-or-later
// Claude tab: the plan's usage limits, as in Claude's Settings → Usage.
//
//   Session                              13%
//   ██████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
//   Resets in 4 h 2 min
//   Weekly                               33%
//   ███████████░░░░░░░░░░░░░░░░░░░░░░░░░░░
//   Resets Sat 22:59
//   Weekly Fable                         18%
//   ██████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
//   Resets Sat 22:59
//   Cloud session credits          $181.09 left
//   ███████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
//   Resets Thu 5 Nov 08:59
//                            Updated 2 min ago
//
// Offline, every value reads "Unknown" and a line says why (user request).
// Renders ClaudeService state; re-renders on its changes and on the shared
// clock's minute tick, for "Resets in" and "Updated … ago".

import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {CREDITS, SESSION, WEEKLY, describeReset, fillFraction, minutesSince} from './usage.js';

// Beyond this, a reset shows its date, not only its weekday.
const DATED_RESET_MS = 6 * 24 * 3600 * 1000;

// Rows shown as "Unknown" offline before any reading was ever made.
const DEFAULT_KINDS = [SESSION, WEEKLY];

export class ClaudeView {
    constructor(ctx, service) {
        this._service = service;
        this._clock = ctx.clock;

        this.actor = new St.BoxLayout({
            style_class: 'froonty-claude',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
        });

        this._rows = new St.BoxLayout({
            style_class: 'froonty-claude-rows',
            orientation: Clutter.Orientation.VERTICAL,
        });
        this._scroll = new St.ScrollView({
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true,
            child: this._rows,
        });
        this._notice = wrappingLabel('froonty-claude-notice');
        this._empty = new St.BoxLayout({
            style_class: 'froonty-claude-empty',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._emptyTitle = wrappingLabel('froonty-claude-empty-title');
        this._emptyHint = wrappingLabel('froonty-claude-empty-hint');
        this._empty.add_child(this._emptyTitle);
        this._empty.add_child(this._emptyHint);
        this._footer = new St.Label({
            style_class: 'froonty-claude-footer',
            x_align: Clutter.ActorAlign.END,
        });

        this.actor.add_child(this._scroll);
        this.actor.add_child(this._empty);
        this.actor.add_child(this._notice);
        this.actor.add_child(this._footer);

        this._active = false;
        this._serviceId = this._service.connect('changed', () => this._sync());
        // The minute tick runs while the island is collapsed too; only
        // re-render for it while the tab is on screen.
        this._clock.connectObject('changed', () => this._active && this._sync(), this);
        this._sync();
    }

    setActive(active) {
        this._active = active;
        if (active)
            this._sync();
    }

    destroy() {
        this._service.disconnect(this._serviceId);
        this._clock.disconnectObject(this);
        this.actor.destroy();
    }

    _sync() {
        const {usage, online, error, loaded} = this._service;
        const now = Date.now();

        this._notice.visible = !online;
        this._notice.text = _('No internet connection: Claude cannot be asked for these details.');

        let windows = usage?.windows ?? [];
        if (!online && !windows.length)
            windows = DEFAULT_KINDS.map(kind => ({id: kind, kind, model: null}));

        this._rows.destroy_all_children();
        for (const window of windows)
            this._rows.add_child(this._row(window, online, now));

        // Before the first read, nothing: no hint flashing up for a moment.
        const empty = windows.length === 0;
        this._scroll.visible = !empty;
        this._empty.visible = empty && loaded;
        this._emptyTitle.text = _('No plan usage from Claude Code yet');
        this._emptyHint.text = error === 'unreadable'
            ? _('Claude Code’s settings file could not be read.')
            : _('It appears once Claude Code, signed in with a Claude plan, checks your usage.');

        this._footer.visible = online && Boolean(usage);
        if (usage)
            this._footer.text = this._updatedText(usage.fetchedAt, now);
    }

    _row(window, online, now) {
        const row = new St.BoxLayout({
            style_class: 'froonty-claude-row',
            orientation: Clutter.Orientation.VERTICAL,
        });
        const reset = online ? describeReset(window.resetsAt, now) : {kind: 'unknown'};
        // After a renewal, what was used since is not known either.
        const known = online && reset.kind !== 'renewed';

        const heading = new St.BoxLayout({style_class: 'froonty-claude-row-heading'});
        heading.add_child(new St.Label({
            style_class: 'froonty-claude-name',
            text: windowTitle(window),
            x_expand: true,
        }));
        heading.add_child(new St.Label({
            style_class: 'froonty-claude-percent',
            text: known ? amountText(window) : _('Unknown'),
        }));
        row.add_child(heading);

        const bar = new UsageBar(known ? fillFraction(window.percent) : 0);
        if (known && isCritical(window))
            bar.actor.add_style_class_name('froonty-claude-bar-critical');
        row.add_child(bar.actor);

        row.add_child(new St.Label({
            style_class: 'froonty-claude-reset',
            text: this._resetText(reset, now),
        }));
        return row;
    }

    _resetText(reset, now) {
        switch (reset.kind) {
        case 'in':
            return reset.hours > 0
                ? _('Resets in %d h %d min').format(reset.hours, reset.minutes)
                : _('Resets in %d min').format(reset.minutes);
        case 'at':
            return _('Resets %s').format(this._clock.formatTime(reset.time,
                reset.time - now >= DATED_RESET_MS ? {date: true} : {weekday: true}));
        case 'renewed':
            return _('Renewed at %s; not checked since').format(this._clock.formatTime(reset.time));
        default:
            return _('Resets: unknown');
        }
    }

    _updatedText(fetchedAt, now) {
        const minutes = minutesSince(fetchedAt, now);
        if (minutes < 1)
            return _('Updated just now');
        if (minutes < 60)
            return _('Updated %d min ago').format(minutes);
        if (minutes < 24 * 60)
            return _('Updated %d h ago').format(Math.floor(minutes / 60));
        return _('Updated %s').format(this._clock.formatTime(fetchedAt, {weekday: true}));
    }
}

function windowTitle(window) {
    switch (window.kind) {
    case SESSION:
        return _('Session');
    case WEEKLY:
        return _('Weekly');
    case CREDITS:
        return _('Cloud session credits');
    default:
        // The model's name comes from Claude's servers, e.g. "Fable".
        return _('Weekly %s').format(window.model);
    }
}

// Credits: what is left, as claude.ai shows it; limits: the share used.
function amountText(window) {
    if (window.kind === CREDITS)
        return _('$%s left').format(window.remaining.toFixed(2));
    return _('%d%%').format(Math.round(window.percent));
}

// Used up, or flagged by Claude's servers (any severity but "normal").
const isCritical = window =>
    window.percent >= 100 || (window.severity !== null && window.severity !== 'normal');

function wrappingLabel(styleClass) {
    const label = new St.Label({style_class: styleClass, x_expand: true});
    label.clutter_text.line_wrap = true;
    label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
    label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    return label;
}

// A rounded bar: CSS paints the track (background-color, border-radius),
// this paints the used part in the foreground colour, as GNOME's own
// ui/barLevel.js does.
class UsageBar {
    constructor(fraction) {
        this._fraction = fraction;
        this.actor = new St.DrawingArea({style_class: 'froonty-claude-bar', x_expand: true});
        this.actor.connect('repaint', () => this._repaint());
    }

    _repaint() {
        const cr = this.actor.get_context();
        const [width, height] = this.actor.get_surface_size();
        const fill = Math.round(this._fraction * width);
        if (fill > 0) {
            // At least a full circle, so a sliver still reads as rounded.
            const w = Math.max(fill, height);
            const r = height / 2;
            cr.arc(r, r, r, Math.PI / 2, Math.PI * 3 / 2);
            cr.arc(w - r, r, r, -Math.PI / 2, Math.PI / 2);
            cr.closePath();
            cr.setSourceColor(this.actor.get_theme_node().get_foreground_color());
            cr.fill();
        }
        cr.$dispose();
    }
}
