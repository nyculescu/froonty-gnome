// SPDX-License-Identifier: GPL-3.0-or-later
// The Media tab (docs/features/media.md): what a music or video player
// reports, with play, pause, skip and seek.
//
//   ┌────────┐  Title                       [Source ▾] ▁▃▂
//   │  art   │  Artist
//   │        │  ━━━━━━━━━●──────────────
//   └────────┘  1:23                              −2:04
//               ⏮        ( ⏯ )        ⏭
//   [lyrics or up next, while open]
//   🔈 ━━━●──                          [≡ Lyrics] [• Up next]
//
// The player row takes the height left over (the art is as tall as the
// row, 56-200 px); the details drop the artist, then the timeline, when
// the row is short. The source chip opens a list of players inside the
// tab. Escape closes that list, then the open extra, then the island.
//
// Every control acts on the context it was drawn with (MediaService):
// one drawn for a song that has since changed does nothing.
//
// Emits 'size-changed' when the extras open or close (the island grows
// by EXTRA_HEIGHT).

import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import {BarLevel} from 'resource:///org/gnome/shell/ui/barLevel.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';

import {Emitter} from '../../core/emitter.js';
import {Tooltip} from '../../core/tooltip.js';
import {ArtFrame} from './artFrame.js';
import {MediaBars} from './bars.js';
import {LyricsPanel, QueuePanel} from './extrasView.js';
import {feedSwipe, nudge} from './gesture.js';
import {
    OneShot, SEEK_HOLD_MS, SwipeTracker, formatRemaining, formatTime, glibTimers, playPauseCommand,
    subst, tintCss,
} from './model.js';
import {OutputVolume} from './volume.js';

const ROW_SPACING = 8;
const CONTROLS_ROW = 32;
const EXTRAS_H = 216;
const MIN_PLAYER = 88;
const ART_MIN = 56;
const ART_MAX = 200;
const ROOMY = 140;
/** Logical px the island grows by while lyrics or the queue are open. */
export const EXTRA_HEIGHT = EXTRAS_H + ROW_SPACING;

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

function iconButton(icon, name, styleClass = '') {
    return new St.Button({
        style_class: `froonty-icon-button ${styleClass}`,
        accessible_name: name,
        can_focus: true,
        track_hover: true,
        y_align: Clutter.ActorAlign.CENTER,
        child: new St.Icon({icon_name: icon}),
    });
}

function ellipsized(text, styleClass) {
    const label = new St.Label({text, style_class: styleClass, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
    label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    return label;
}

export class MediaView extends Emitter {
    /**
     * @param {object} ctx feature context {settings, collapse}
     * @param {object} handle MediaHandle (index.js): its `service` while active
     */
    constructor(ctx, handle) {
        super();
        this._ctx = ctx;
        this._settings = ctx.settings;
        this._handle = handle;
        this._service = null;
        this._serviceIds = [];
        this._extra = null; // 'lyrics' | 'queue' | null
        this._panels = {lyrics: null, queue: null};
        this._pickerOpen = false;
        this._scrub = null; // {context} while the slider is dragged
        this._dragging = false;
        this._hold = null; // {targetS, revision} after a seek, until it shows
        this._holdTimer = new OneShot(glibTimers, () => {
            this._hold = null;
            this._updateTime();
        });
        this._settingSlider = false;
        this._context = null; // what the controls were drawn for
        this._wantFocus = false;
        this._laterId = 0;
        this._timelineMode = 'none';
        this._swipe = new SwipeTracker();

        this._build();
        this._settingsIds = ['media-lyrics', 'media-queue', 'media-animate-bars'].map(key =>
            this._settings.connect(`changed::${key}`, () => this._syncControlsRow()));
        this._syncControlsRow();
    }

    destroy() {
        this.setActive(false);
        for (const id of this._settingsIds)
            this._settings.disconnect(id);
        this._holdTimer.stop();
        if (this._laterId)
            global.compositor.get_laters().remove(this._laterId);
        this._laterId = 0;
        this._volume.destroy();
        for (const panel of Object.values(this._panels))
            panel?.destroy();
        this.actor.destroy();
    }

    // ------------------------------------------------------------ actors

    _build() {
        this._tooltip = new Tooltip();
        this.actor = new St.Widget({
            style_class: 'froonty-media',
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });
        this._content = new St.BoxLayout({
            style_class: 'froonty-media-content',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
        });
        this.actor.add_child(this._content);

        this._stack = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });
        this._content.add_child(this._stack);
        // Its height is what is left (the player is sized from it), never
        // what its content asks: that would feed back into the island.
        this._stack.min_height = 0;
        this._stack.connect('notify::allocation', () => this._queueLayout());

        this._main = new St.BoxLayout({
            style_class: 'froonty-media-main',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
            visible: false,
        });
        this._stack.add_child(this._main);
        this._main.add_child(this._buildPlayerRow());
        this._extrasHost = new St.Widget({
            style_class: 'froonty-media-extras',
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            visible: false,
        });
        this._main.add_child(this._extrasHost);

        this._stack.add_child(this._buildIdle());
        this._stack.add_child(this._buildPicker());

        this._content.add_child(this._buildControlsRow());

        const overlay = new St.Widget({x_expand: true, y_expand: true});
        overlay.add_child(this._tooltip.actor);
        this.actor.add_child(overlay);

        // Space toggles playback when the focus is not on a button or slider.
        this.actor.connect('key-press-event', (_actor, event) => {
            if (event.get_key_symbol() !== Clutter.KEY_space)
                return Clutter.EVENT_PROPAGATE;
            const focus = global.stage.key_focus;
            if (focus instanceof St.Button || focus instanceof BarLevel || !this._service?.playback)
                return Clutter.EVENT_PROPAGATE;
            this._service.playPause(this._context);
            return Clutter.EVENT_STOP;
        });
    }

    _buildPlayerRow() {
        this._playerRow = new St.BoxLayout({
            style_class: 'froonty-media-player',
            x_expand: true,
            // Reactive for touchpad swipes (scroll events) over the row.
            reactive: true,
        });
        this._playerRow.connect('scroll-event', (_actor, event) => this._onScroll(event));

        this._art = new ArtFrame();
        this.artButton = new St.Button({
            style_class: 'froonty-media-art-button',
            can_focus: true,
            track_hover: true,
            x_expand: false,
            y_expand: false,
            y_align: Clutter.ActorAlign.CENTER,
            child: this._art,
        });
        this.artButton.connect('clicked', () => this._openPlayer());
        this._tooltip.attach(this.artButton, () => this._artTooltip(), 'below');
        this._playerRow.add_child(this.artButton);

        this._details = new St.BoxLayout({
            style_class: 'froonty-media-details',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._playerRow.add_child(this._details);

        const titleRow = new St.BoxLayout({style_class: 'froonty-media-title-row', x_expand: true});
        this._title = ellipsized('', 'froonty-media-title');
        this._title.reactive = true;
        this._title.track_hover = true;
        titleRow.add_child(this._title);
        this._chip = this._sourceChip();
        titleRow.add_child(this._chip);
        this._bars = new MediaBars({count: 3, barWidth: 2.5, height: 12, gap: 2});
        this._bars.add_style_class_name('froonty-media-title-bars');
        titleRow.add_child(this._bars);
        this._details.add_child(titleRow);

        this._artist = ellipsized('', 'froonty-media-artist');
        this._details.add_child(this._artist);

        this._timeline = new St.BoxLayout({
            style_class: 'froonty-media-timeline',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this.slider = new Slider(0);
        this.slider.add_style_class_name('froonty-media-slider');
        this.slider.accessible_name = _('Playback position');
        this.slider.connect('drag-begin', () => this._onDragBegin());
        this.slider.connect('drag-end', () => this._onDragEnd());
        this.slider.connect('notify::value', () => this._onSliderValue());
        this.slider.connect('key-focus-in', () => this._describePosition());
        this._timeline.add_child(this.slider);
        this._meter = new BarLevel({
            style_class: 'barlevel froonty-media-slider froonty-media-meter',
            reactive: false,
            x_expand: true,
        });
        this._timeline.add_child(this._meter);
        const times = new St.BoxLayout({style_class: 'froonty-media-times', x_expand: true});
        this._elapsed = new St.Label({style_class: 'froonty-media-time', x_expand: true});
        this._remaining = new St.Label({style_class: 'froonty-media-time'});
        times.add_child(this._elapsed);
        times.add_child(this._remaining);
        this._timeline.add_child(times);
        this._details.add_child(this._timeline);

        this._transport = new St.BoxLayout({
            style_class: 'froonty-media-transport',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this.previousButton = iconButton('media-skip-backward-symbolic', _('Previous track'), 'froonty-media-skip');
        this.previousButton.connect('clicked', () => this._service?.previous(this._context));
        this.playButton = new St.Button({
            style_class: 'froonty-media-play',
            can_focus: true,
            track_hover: true,
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({icon_name: 'media-playback-start-symbolic'}),
        });
        this.playButton.connect('clicked', () => this._service?.playPause(this._context));
        this.nextButton = iconButton('media-skip-forward-symbolic', _('Next track'), 'froonty-media-skip');
        this.nextButton.connect('clicked', () => this._service?.next(this._context));
        for (const button of [this.previousButton, this.playButton, this.nextButton])
            this._transport.add_child(button);
        this._details.add_child(this._transport);

        // A player that cannot be controlled (CanControl false).
        this._readOnly = new St.BoxLayout({style_class: 'froonty-media-readonly', x_expand: true});
        this._readOnly.add_child(ellipsized(_('This player can’t be controlled from here.'), 'froonty-media-readonly-text'));
        this.openButton = new St.Button({
            style_class: 'froonty-media-text-button',
            label: _('Open player'),
            can_focus: true,
            track_hover: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.openButton.connect('clicked', () => this._openPlayer());
        this._readOnly.add_child(this.openButton);
        this._details.add_child(this._readOnly);

        this._tooltip.attach(this._title, () =>
            this._title.clutter_text.get_layout().is_ellipsized() ? this._title.text : null, 'below');
        return this._playerRow;
    }

    _sourceChip() {
        const chip = new St.Button({
            style_class: 'froonty-media-chip',
            accessible_name: _('Playback source'),
            can_focus: true,
            track_hover: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const label = new St.Label({style_class: 'froonty-media-chip-label', y_align: Clutter.ActorAlign.CENTER});
        label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        chip.child = label;
        chip.connect('clicked', () => this._openPicker());
        return chip;
    }

    _buildIdle() {
        this._idle = new St.BoxLayout({
            style_class: 'froonty-media-idle',
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        const tile = new St.Widget({
            style_class: 'froonty-media-idle-tile',
            layout_manager: new Clutter.BinLayout(),
        });
        tile.add_child(new St.Icon({
            icon_name: 'audio-x-generic-symbolic',
            style_class: 'froonty-media-idle-icon',
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            accessible_role: Atk.Role.REDUNDANT_OBJECT,
        }));
        this._idle.add_child(tile);
        const column = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'froonty-media-idle-text',
        });
        this._idleChip = this._sourceChip();
        this._idleChip.x_align = Clutter.ActorAlign.START;
        column.add_child(this._idleChip);
        this._nothing = new St.Label({text: _('Nothing playing'), style_class: 'froonty-media-nothing'});
        column.add_child(this._nothing);
        const hint = new St.Label({
            text: _('Your music and playback controls appear here.'),
            style_class: 'froonty-media-idle-hint',
        });
        hint.clutter_text.line_wrap = true;
        column.add_child(hint);
        this._idle.add_child(column);
        return this._idle;
    }

    _buildPicker() {
        this._picker = new St.BoxLayout({
            style_class: 'froonty-media-picker',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
            reactive: true,
            visible: false,
        });
        const header = new St.BoxLayout({style_class: 'froonty-media-picker-header'});
        header.add_child(ellipsized(_('Playback source'), 'froonty-media-picker-title'));
        this.pickerClose = iconButton('window-close-symbolic', _('Close'));
        this.pickerClose.connect('clicked', () => this._closePicker());
        header.add_child(this.pickerClose);
        this._picker.add_child(header);
        this._pickerRows = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        const scroll = new St.ScrollView({
            style_class: 'froonty-media-picker-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true,
        });
        scroll.add_child(this._pickerRows);
        this._picker.add_child(scroll);
        return this._picker;
    }

    _buildControlsRow() {
        this._controls = new St.BoxLayout({style_class: 'froonty-media-controls', x_expand: true});
        this._volume = new OutputVolume();
        this._controls.add_child(this._volume.actor);
        this._controls.add_child(new St.Widget({x_expand: true}));
        this.lyricsChip = this._extraChip('format-justify-left-symbolic', _('Lyrics'), 'lyrics');
        this.queueChip = this._extraChip('view-list-bullet-symbolic', _('Up next'), 'queue');
        this._controls.add_child(this.lyricsChip);
        this._controls.add_child(this.queueChip);
        return this._controls;
    }

    _extraChip(icon, text, kind) {
        const box = new St.BoxLayout({style_class: 'froonty-media-extra-chip-box'});
        box.add_child(new St.Icon({icon_name: icon, y_align: Clutter.ActorAlign.CENTER}));
        box.add_child(new St.Label({text, y_align: Clutter.ActorAlign.CENTER}));
        const chip = new St.Button({
            style_class: 'froonty-media-extra-chip',
            accessible_name: text,
            toggle_mode: true,
            can_focus: true,
            track_hover: true,
            y_align: Clutter.ActorAlign.CENTER,
            child: box,
        });
        chip.connect('clicked', () => this._setExtra(this._extra === kind ? null : kind));
        return chip;
    }

    // ------------------------------------------------------------ activity

    /**
     * On screen: follow the service (held by the handle), the mixer and
     * the keyboard. Off screen: close the extras and the list.
     */
    setActive(active) {
        if (active && !this._service && this._handle.service) {
            this._service = this._handle.service;
            const s = this._service;
            // The service is made anew after nobody held it: the extras
            // follow the one in use.
            if (this._panelsFor !== s) {
                for (const [kind, panel] of Object.entries(this._panels)) {
                    panel?.destroy();
                    this._panels[kind] = null;
                }
                this._panelsFor = s;
            }
            this._serviceIds = [
                s.connect('changed', () => this._sync()),
                s.connect('position-changed', () => this._updateTime()),
                s.connect('tick', () => this._updateTime()),
                s.connect('art-changed', () => this._syncArt()),
            ];
            this._volume.setActive(true, () => this._syncControlsRow());
            this._wantFocus = true;
            this._sync();
            this._syncArt();
        } else if (!active && this._service) {
            this._closePicker();
            this._setExtra(null);
            for (const id of this._serviceIds)
                this._service.disconnect(id);
            this._serviceIds = [];
            this._service = null;
            this._volume.setActive(false);
            this._scrub = null;
            this._dragging = false;
            this._endHold();
            this._tooltip.hide();
            this._bars.setPlaying(false);
        }
    }

    /** Logical px added to the island while an extra is open. */
    get extraHeight() {
        return this._extra ? EXTRA_HEIGHT : 0;
    }

    /** Escape: the source list first, then the open extra. */
    handleEscape() {
        if (this._pickerOpen) {
            this._closePicker();
            return true;
        }
        if (this._extra) {
            this._setExtra(null);
            return true;
        }
        return false;
    }

    /** The open extra ('lyrics', 'queue') or null (tests). */
    get extra() {
        return this._extra;
    }

    get pickerOpen() {
        return this._pickerOpen;
    }

    /** The open extra's panel (tests). */
    panel(kind) {
        return this._panels[kind];
    }

    // ------------------------------------------------------------ state

    _sync() {
        const s = this._service;
        if (!s)
            return;
        const playback = s.playback;
        this._context = s.context();
        if (this._scrub && !s.allowed(this._scrub.context))
            this._scrub = null;
        if (this._hold && playback?.revision !== this._hold.revision)
            this._endHold();

        const showPlayer = Boolean(playback) && !s.awaiting;
        this._main.visible = showPlayer;
        this._idle.visible = !playback && !s.awaiting;
        if (!playback && this._extra)
            this._setExtra(null);
        this._syncChips();
        if (this._pickerOpen)
            this._fillPicker();

        if (playback) {
            const {track, caps, held} = playback;
            this._title.text = track.title || _('Now playing');
            this._wantArtist = Boolean(track.artist || track.album) || s.commandFailed;
            if (s.commandFailed) {
                this._artist.text = _('Could not change playback.');
                this._artist.add_style_class_name('froonty-media-failed');
            } else {
                this._artist.text = track.artist ?? track.album ?? '';
                this._artist.remove_style_class_name('froonty-media-failed');
            }
            this._bars.setPlaying(playback.playing);
            this._bars.setEnabled(this._settings.get_boolean('media-animate-bars'));
            this._art.setPaused(!playback.playing);

            const command = playPauseCommand(caps);
            this.playButton.child.icon_name = playback.playing
                ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
            this.playButton.accessible_name = playback.playing ? _('Pause') : _('Play');
            this.playButton.reactive = !held && command !== null;
            this.previousButton.visible = caps.canGoPrevious !== false;
            this.nextButton.visible = caps.canGoNext !== false;
            this.previousButton.reactive = this.nextButton.reactive = !held && caps.canControl;
            this._transport.visible = caps.canControl;
            this._readOnly.visible = !caps.canControl;
            this.openButton.visible = playback.canOpen;

            const length = track.lengthUs ?? 0;
            const known = length > 0 && s.hasPosition;
            this._timelineMode = !known ? 'none'
                : caps.canSeek && caps.canControl && !held ? 'slider' : 'meter';
            this.slider.visible = this._timelineMode === 'slider';
            this._meter.visible = this._timelineMode === 'meter';
            this._wantTimeline = this._timelineMode !== 'none';
            this.artButton.reactive = playback.canOpen;
            this.artButton.accessible_name = playback.canOpen
                ? subst(_('Open %s'), playback.name) : playback.name;
            this._syncArt();
            this._updateTime();
            this._applyLevel(this._level ?? 0);
            if (this._wantFocus && this.playButton.visible && this._transport.visible)
                this._takeFocus();
        } else {
            this._bars.setPlaying(false);
        }
        this._queueLayout();
    }

    // Focus on play/pause once it shows, unless the user moved on.
    _takeFocus() {
        this._wantFocus = false;
        const focus = global.stage.key_focus;
        if (!focus || focus.contains(this.actor) || this.actor.contains(focus))
            this.playButton.grab_key_focus();
    }

    _syncChips() {
        const s = this._service;
        const sources = s.sources;
        const chosen = s.chosenKey ? sources.find(x => x.key === s.chosenKey) : null;
        const name = s.playback?.name ?? chosen?.displayName ?? _('Automatic');
        const visible = sources.length > 1 || !s.automatic;
        for (const chip of [this._chip, this._idleChip]) {
            chip.child.text = `${name} ▾`;
            chip.accessible_description = s.automatic ? `${_('Automatic')}, ${name}` : name;
        }
        this._chip.visible = visible;
        this._idleChip.visible = sources.length > 0 || !s.automatic;
        this._nothing.visible = !this._idleChip.visible;
    }

    _syncArt() {
        const s = this._service;
        const playback = s?.playback;
        if (!playback)
            return;
        const art = s.art;
        const appIcon = playback.app?.get_icon?.() ?? null;
        this._art.setImage(art.state === 'ready' ? art.pixbuf : null, appIcon);
        this._art.setTint(art.state === 'ready' ? art.tint : null);
        const accent = tintCss(art.state === 'ready' ? art.tint : null);
        if (accent === this._accent)
            return;
        this._accent = accent;
        this._bars.setColor(accent);
        const style = `-barlevel-active-background-color: ${accent}; color: ${accent};`;
        this.slider.style = style;
        this._meter.style = style;
    }

    _artTooltip() {
        const playback = this._service?.playback;
        if (!playback)
            return null;
        if (this._service.art.state === 'blocked')
            return _('Cover art from the internet is off (Settings → Media)');
        return playback.canOpen ? subst(_('Open %s'), playback.name) : null;
    }

    _syncControlsRow() {
        const lyrics = this._settings.get_boolean('media-lyrics');
        const queue = this._settings.get_boolean('media-queue');
        this.lyricsChip.visible = lyrics;
        this.queueChip.visible = queue;
        if ((this._extra === 'lyrics' && !lyrics) || (this._extra === 'queue' && !queue))
            this._setExtra(null);
        this._controls.visible = this._volume.ready || lyrics || queue;
        this._bars.setEnabled(this._settings.get_boolean('media-animate-bars'));
        this._queueLayout();
    }

    // ------------------------------------------------------------ time

    _updateTime() {
        const s = this._service;
        const playback = s?.playback;
        if (!playback || this._timelineMode === 'none')
            return;
        const lengthS = playback.track.lengthUs / 1e6;
        let position = s.positionUs() / 1e6;
        if (this._scrub || this._dragging) {
            position = this.slider.value * lengthS;
        } else if (this._hold) {
            if (Math.abs(position - this._hold.targetS) <= 2)
                this._endHold();
            else
                position = this._hold.targetS;
        }
        this._elapsed.text = formatTime(position);
        this._remaining.text = formatRemaining(lengthS, position);
        if (!this._scrub && !this._dragging) {
            this._settingSlider = true;
            this.slider.value = lengthS > 0 ? Math.min(1, position / lengthS) : 0;
            this._meter.value = this.slider.value;
            this._settingSlider = false;
        }
    }

    _describePosition() {
        const playback = this._service?.playback;
        if (!playback?.track.lengthUs)
            return;
        const lengthS = playback.track.lengthUs / 1e6;
        this.slider.accessible_description = subst(_('%s of %s'),
            formatTime(this.slider.value * lengthS), formatTime(lengthS));
    }

    _onDragBegin() {
        this._dragging = true;
        const context = this._service?.context();
        this._scrub = this._service?.allowed(context) ? {context} : null;
    }

    _onDragEnd() {
        this._dragging = false;
        const scrub = this._scrub;
        this._scrub = null;
        if (scrub && this._service?.allowed(scrub.context))
            this._seekTo(this.slider.value, scrub.context);
        else
            this._updateTime();
    }

    // Keyboard (±10%) and scroll steps: each is a seek (latest wins).
    _onSliderValue() {
        if (this._settingSlider)
            return;
        if (this._dragging) {
            this._updateTime();
            return;
        }
        const context = this._service?.context();
        if (this._service?.allowed(context))
            this._seekTo(this.slider.value, context);
    }

    _seekTo(fraction, context) {
        const lengthS = (this._service.playback?.track.lengthUs ?? 0) / 1e6;
        const targetS = fraction * lengthS;
        this._service.seek(targetS, context).then(() => this._describePosition());
        // The thumb stays at the target until the player is there (or 1 s).
        this._hold = {targetS, revision: context.revision};
        this._holdTimer.restart(SEEK_HOLD_MS);
        this._updateTime();
        this._describePosition();
    }

    _endHold() {
        this._hold = null;
        this._holdTimer.stop();
    }

    // ------------------------------------------------------------ actions

    _openPlayer() {
        if (this._service?.raise())
            this._ctx.collapse?.();
    }

    _onScroll(event) {
        if (!this._settings.get_boolean('media-gestures') || !this._service?.playback)
            return Clutter.EVENT_PROPAGATE;
        const action = feedSwipe(this._swipe, event);
        if (action === null)
            return Clutter.EVENT_PROPAGATE;
        if (action)
            this._skip(action);
        return Clutter.EVENT_STOP;
    }

    _skip(action) {
        const s = this._service;
        if (!s.allowed(this._context))
            return;
        if (action === 'next')
            s.next(this._context);
        else
            s.previous(this._context);
        nudge(this._art, action);
    }

    // ------------------------------------------------------------ picker

    _openPicker() {
        if (!this._service)
            return;
        this._pickerOpen = true;
        this._fillPicker();
        this._picker.show();
        this._main.opacity = this._idle.opacity = 0;
        this._pickerRows.get_first_child()?.grab_key_focus();
    }

    _closePicker() {
        if (!this._pickerOpen)
            return;
        this._pickerOpen = false;
        this._picker.hide();
        this._main.opacity = this._idle.opacity = 255;
        const chip = this._chip.visible && this._main.visible ? this._chip : this._idleChip;
        if (chip.mapped)
            chip.grab_key_focus();
    }

    _fillPicker() {
        const s = this._service;
        const rows = [{key: null, name: _('Automatic')},
            ...s.sources.map(source => ({key: source.key, name: source.displayName}))];
        const active = s.automatic ? null : s.chosenKey;
        // Rebuilt only when it changed: rebuilding moves the key focus.
        const signature = JSON.stringify([rows, active]);
        if (signature === this._pickerSignature && this._pickerRows.get_n_children() > 0)
            return;
        this._pickerSignature = signature;
        this._pickerRows.destroy_all_children();
        for (const {key, name} of rows) {
            const box = new St.BoxLayout({
                style_class: 'froonty-media-picker-row-box',
                x_expand: true,
                x_align: Clutter.ActorAlign.START,
            });
            const check = new St.Icon({
                icon_name: 'object-select-symbolic',
                style_class: 'froonty-media-picker-check',
                opacity: key === active ? 255 : 0,
            });
            box.add_child(check);
            box.add_child(ellipsized(name, 'froonty-media-picker-name'));
            const row = new St.Button({
                style_class: 'froonty-media-picker-row',
                accessible_name: name,
                can_focus: true,
                track_hover: true,
                x_expand: true,
                child: box,
            });
            if (key === active)
                row.add_accessible_state(Atk.StateType.CHECKED);
            row.connect('clicked', () => {
                s.select(key);
                this._closePicker();
            });
            this._pickerRows.add_child(row);
        }
    }

    // ------------------------------------------------------------ extras

    _setExtra(kind) {
        if (kind && !this._service?.playback)
            kind = null;
        if (kind === this._extra) {
            this._syncExtraChips();
            return;
        }
        const previous = this._extra;
        if (previous) {
            this._panels[previous].setOpen(false);
            this._panels[previous].actor.hide();
        }
        this._extra = kind;
        if (kind) {
            this._panels[kind] ??= this._makePanel(kind);
            const panel = this._panels[kind];
            if (!panel.actor.get_parent())
                this._extrasHost.add_child(panel.actor);
            panel.actor.show();
            panel.setOpen(true);
        }
        this._extrasHost.visible = Boolean(kind);
        if (kind) {
            const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
            this._extrasHost.height = this._extrasHeight = EXTRAS_H * scale;
        }
        this._syncExtraChips();
        if (Boolean(previous) !== Boolean(kind)) {
            // The island grows or shrinks by EXTRA_HEIGHT: the player keeps
            // its size meanwhile, and is laid out again once that is done.
            this._holdLayout = true;
            this.emit('size-changed');
        }
        this._queueLayout();
    }

    _makePanel(kind) {
        const media = this._service;
        return kind === 'lyrics'
            ? new LyricsPanel({settings: this._settings, media})
            : new QueuePanel({
                media,
                context: () => this._context,
                openPlayer: () => this._openPlayer(),
            });
    }

    _syncExtraChips() {
        this.lyricsChip.checked = this._extra === 'lyrics';
        this.queueChip.checked = this._extra === 'queue';
    }

    // ------------------------------------------------------------ layout

    // Once per frame at most, after layout: sizes follow the room left.
    _queueLayout() {
        if (this._laterId)
            return;
        this._laterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._laterId = 0;
            this._layout();
            return GLib.SOURCE_REMOVE;
        });
    }

    _islandResizing() {
        for (let actor = this.actor.get_parent(); actor; actor = actor.get_parent()) {
            if (actor.get_transition('height'))
                return true;
        }
        return false;
    }

    _layout() {
        if (!this._stack.get_stage() || !this._main.visible)
            return;
        if (this._holdLayout) {
            if (this._islandResizing())
                return;
            this._holdLayout = false;
        }
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        // The last allocation, also while a relayout is pending (showing
        // the player invalidates it; `height` would then be the natural
        // height, and an unchanged allocation sends no notify::allocation).
        const stackBox = this._stack.allocation;
        const stackHeight = stackBox.get_height();
        const extras = this._extra ? EXTRA_HEIGHT * scale : 0;
        const room = stackHeight - extras;
        // Open extras on a short island take the whole height.
        const showPlayer = !this._extra || room >= MIN_PLAYER * scale;
        this._playerRow.visible = showPlayer;
        if (this._extra) {
            const extrasHeight = showPlayer ? EXTRAS_H * scale : stackHeight;
            if (this._extrasHeight !== extrasHeight)
                this._extrasHost.height = this._extrasHeight = extrasHeight;
        }
        if (!showPlayer)
            return;
        const height = Math.max(0, Math.floor(room));
        if (this._rowHeight !== height)
            this._playerRow.height = this._rowHeight = height;
        const roomy = height >= ROOMY * scale;
        const side = Math.round(clamp(height / scale, ART_MIN, ART_MAX) * scale);
        this._art.setSize(side, (roomy ? 16 : 12) * scale);
        const gap = roomy ? 20 : 16;
        const style = `spacing: ${gap}px;`;
        if (this._playerRow.style !== style)
            this._playerRow.style = style;
        const width = Math.max(0, stackBox.get_width() - side - gap * scale);
        let level = 0;
        for (; level < 3; level++) {
            this._applyLevel(level);
            const [, natural] = this._details.get_preferred_height(width);
            if (natural <= height)
                break;
        }
        this._applyLevel(level);
        this._lastLayout = {stackHeight, height, side, width, level, calls: (this._lastLayout?.calls ?? 0) + 1};
    }

    // 0 roomy; 1 compact; 2 compact without the artist; 3 also without
    // the timeline.
    _applyLevel(level) {
        this._level = level;
        if (level >= 1)
            this._details.add_style_class_name('froonty-media-compact');
        else
            this._details.remove_style_class_name('froonty-media-compact');
        // A failed command is said even when the artist would not fit.
        this._artist.visible = Boolean(this._wantArtist) &&
            (level < 2 || Boolean(this._service?.commandFailed));
        this._timeline.visible = Boolean(this._wantTimeline) && level < 3;
    }

    /** The details level in use (tests): 0 roomy … 3 smallest. */
    get level() {
        return this._level ?? 0;
    }
}
