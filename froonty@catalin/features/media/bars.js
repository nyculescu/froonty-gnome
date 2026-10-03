// SPDX-License-Identifier: GPL-3.0-or-later
// Moving bars beside a playing song (the tab's title row, the pill's
// trailing wing). Decorative: hidden from assistive technology.
//
// The motion is Clutter's own (an endless eased scale per bar), so no
// JavaScript runs per frame; GNOME still redraws the bars' small region
// every frame while they move. They move only while all hold: the song
// plays, media-animate-bars is on, GNOME's enable-animations is on, and
// the bars are on screen (mapped). Otherwise they stand still, low. A
// colour change never restarts the motion.

import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import St from 'gi://St';

const envelope = (i, n) => 0.55 + 0.45 * Math.sin(Math.PI * (i + 0.5) / n);
export const lowScale = (i, n) => 0.12 + 0.25 * envelope(i, n);
export const highScale = (i, n) => 0.12 + 0.88 * envelope(i, n);

export const MediaBars = GObject.registerClass(
class MediaBars extends St.BoxLayout {
    /**
     * @param {object} [params]
     * @param {number} [params.count] bars
     * @param {number} [params.barWidth] px
     * @param {number} [params.height] px
     * @param {number} [params.gap] px between bars
     */
    _init({count = 3, barWidth = 2.5, height = 12, gap = 2} = {}) {
        super._init({
            style_class: 'froonty-media-bars',
            style: `spacing: ${gap}px;`,
            accessible_role: Atk.Role.REDUNDANT_OBJECT,
            y_align: Clutter.ActorAlign.CENTER,
            reactive: false,
        });
        this._count = count;
        this._color = 'rgba(255, 255, 255, 1)';
        this._radius = barWidth / 2;
        this._playing = false;
        this._enabled = true;
        this._moving = false;
        this._bars = [];
        for (let i = 0; i < count; i++) {
            const bar = new St.Widget({
                style_class: 'froonty-media-bar',
                width: barWidth,
                height,
                pivot_point: new Graphene.Point({x: 0.5, y: 1}),
                scale_y: lowScale(i, count),
                y_align: Clutter.ActorAlign.END,
            });
            this.add_child(bar);
            this._bars.push(bar);
        }
        this._paint();
        this._stSettings = St.Settings.get();
        this._animationsId = this._stSettings.connect('notify::enable-animations', () => this._sync());
        // The last bar: Clutter tells a parent it is mapped before it maps
        // the children, and eases of unmapped actors are skipped; the last
        // child is mapped last (and unmapped before its parent).
        this._bars.at(-1).connect('notify::mapped', () => this._sync());
        this.connect('destroy', () => this._stSettings.disconnect(this._animationsId));
    }

    /** Whether the bars move (and are drawn tall). */
    get moving() {
        return this._moving;
    }

    /** @param {boolean} playing */
    setPlaying(playing) {
        this._playing = playing;
        this._sync();
    }

    /** @param {boolean} enabled media-animate-bars */
    setEnabled(enabled) {
        this._enabled = enabled;
        this._sync();
    }

    /** @param {string} css a CSS colour */
    setColor(css) {
        if (css === this._color)
            return;
        this._color = css;
        this._paint();
    }

    _paint() {
        for (const bar of this._bars)
            bar.style = `background-color: ${this._color}; border-radius: ${this._radius}px;`;
    }

    _sync() {
        const moving = this._playing && this._enabled && this._stSettings.enable_animations &&
            this._bars.at(-1).mapped;
        if (moving === this._moving)
            return;
        this._moving = moving;
        const n = this._count;
        this._bars.forEach((bar, i) => {
            bar.remove_all_transitions();
            bar.scale_y = lowScale(i, n);
            if (!moving)
                return;
            bar.ease({
                scale_y: highScale(i, n),
                duration: Math.round(Math.PI / (5.2 + 0.61 * i) * 1000),
                delay: 170 * i,
                mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
                repeatCount: -1,
                autoReverse: true,
            });
        });
    }
});
