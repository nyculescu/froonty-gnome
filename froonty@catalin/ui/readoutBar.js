// SPDX-License-Identifier: GPL-3.0-or-later
// The readouts: up to eight read-only values on the collapsed pill, chosen
// and ordered in Settings (readouts). Two groups, on either side of the time
// (collapsedView.js places them), split where their widths come closest
// (balancedSplit). Both as wide as the wider one, so the time stays centred;
// the narrower keeps its readouts together, next to the time.
//
// Their sources run only while the collapsed pill is on screen (setShown):
// the system sampler at readouts-interval, one Claude service (which asks
// Claude Code for fresh usage about every 2 min), and the clock.
//
// Emits 'changed' when what is printed changed: the pill's width and name
// follow.

import GObject from 'gi://GObject';
import St from 'gi://St';

import {Emitter} from '../core/emitter.js';
import {ClaudeService} from '../features/claude/service.js';
import {ReadoutMetricsService} from '../features/sysmon/panicMetrics.js';
import {balancedSplit, sanitize} from '../readouts/catalog.js';
import {createReadout} from '../readouts/registry.js';
import {metricNeeds} from '../readouts/values.js';
import {PanicGroupLayout} from './panicBar.js';

const KEY = 'readouts';
// Claude Code's /usage takes 2-3 s and about 350 MB; the refresher still
// skips it when the setting is off or in low power. Claude Code 2.1.332
// fetched again only about 2 min after its last fetch, so an ask sooner
// brought nothing; 5 s more keeps the ask clear of that wait.
const CLAUDE_ASK_EVERY_S = 125;

const ReadoutGroupLayout = GObject.registerClass(
class ReadoutGroupLayout extends PanicGroupLayout {
    /**
     * @param {boolean} leading the group before the time
     * @param {Function} groups → both groups
     */
    _init(leading, groups) {
        super._init(leading);
        this._groups = groups;
    }

    // Each group asks its own natural width, never the actor's: that would
    // come back here.
    vfunc_get_preferred_width(_container, forHeight) {
        const widths = this._groups().map(group =>
            super.vfunc_get_preferred_width(group, forHeight)[1]);
        const widest = Math.max(...widths);
        return [widest, widest];
    }

    _placement(extra) {
        return {start: this._leading ? extra : 0, grow: 0};
    }
});

export class ReadoutBar extends Emitter {
    /** @param {object} ctx the feature context {settings, clock} */
    constructor({settings, clock}) {
        super();
        this._settings = settings;
        this._clock = clock;
        this._readouts = [];
        this._split = 0;
        this._shown = false;
        this._claude = null;
        this._claudeId = 0;
        this._metrics = new ReadoutMetricsService(settings);
        this._metricsId = this._metrics.connect('changed', () => this._sync());
        // Empty, they take no room.
        this.groups = [true, false].map(leading => new St.Widget({
            style_class: 'froonty-readouts',
            layout_manager: new ReadoutGroupLayout(leading, () => this.groups),
            visible: false,
        }));

        clock.connectObject('changed', () => this._sync(), this);
        settings.connectObject(
            `changed::${KEY}`, () => this._rebuild(),
            'changed::timezone-planner-cities', () => this._sync(),
            'changed::timezone-planner-favorites', () => this._sync(),
            'changed::timezone-planner-time-format', () => this._sync(),
            this);
        this._rebuild();
    }

    destroy() {
        this._settings.disconnectObject(this);
        this._clock.disconnectObject(this);
        this._metrics.disconnect(this._metricsId);
        this._metrics.stop();
        this._destroyReadouts();
        this._setClaude(false);
        for (const group of this.groups)
            group.destroy();
    }

    /** Whether any readout is chosen (the pill then fits them). */
    get count() {
        return this._readouts.length;
    }

    /** The room both groups take (stage px; on stage only). */
    get width() {
        return this.groups.reduce((sum, group) =>
            sum + (group.visible ? group.get_preferred_width(-1)[1] : 0), 0);
    }

    /** What the pill's accessible name adds, or null. */
    get accessibleText() {
        return this._readouts.map(readout => readout.accessibleText).filter(Boolean)
            .join(', ') || null;
    }

    /** @param {boolean} shown whether the collapsed pill is on screen */
    setShown(shown) {
        this._shown = shown;
        this._syncSources();
        this._balance();
    }

    _rebuild() {
        this._destroyReadouts();
        const ids = sanitize(this._settings.get_strv(KEY));
        this._readouts = ids.map(id => createReadout(id)).filter(Boolean);
        this._place(Math.floor(this._readouts.length / 2));
        // A lone readout's empty group still balances the time.
        for (const group of this.groups)
            group.visible = this._readouts.length > 0;
        this._setClaude(this._readouts.some(readout => readout.source === 'claude'));
        const {sections, cores} = metricNeeds(ids);
        this._metrics.setNeeds(sections, cores);
        this._syncSources();
        this._sync(true);
    }

    // Widths need the theme, so only on stage; until then half each.
    _balance() {
        const [group] = this.groups;
        if (!group.get_stage())
            return;
        const widths = this._readouts.map(({actor}) =>
            (actor.visible ? actor.get_preferred_width(-1)[1] : 0));
        const spacing = group.get_theme_node().get_length('spacing');
        const split = balancedSplit(widths, spacing, this._split);
        if (split !== this._split)
            this._place(split);
    }

    _place(split) {
        this._split = split;
        this._readouts.forEach(({actor}, i) => {
            actor.get_parent()?.remove_child(actor);
            this.groups[i < split ? 0 : 1].add_child(actor);
        });
    }

    _syncSources() {
        this._claude?.setActive(this._shown);
        this._metrics.setActive(this._shown);
    }

    _setClaude(wanted) {
        if (wanted === Boolean(this._claude))
            return;
        if (wanted) {
            this._claude = new ClaudeService({
                settings: this._settings,
                askEvery: CLAUDE_ASK_EVERY_S,
            });
            this._claude.start();
            this._claudeId = this._claude.connect('changed', () => this._sync());
        } else {
            this._claude.disconnect(this._claudeId);
            this._claude.stop();
            this._claude = null;
        }
    }

    _sync(force = false) {
        const sources = {
            metrics: this._metrics,
            claude: this._claude,
            settings: this._settings,
            clock: this._clock,
        };
        let changed = force;
        for (const readout of this._readouts)
            changed = readout.sync(sources) || changed;
        if (!changed)
            return;
        this._balance();
        // A group's width depends on the other's, which a label's change
        // does not invalidate.
        for (const group of this.groups)
            group.queue_relayout();
        this.emit('changed');
    }

    _destroyReadouts() {
        for (const readout of this._readouts)
            readout.destroy();
        this._readouts = [];
    }
}
