// SPDX-License-Identifier: GPL-3.0-or-later
// The Media tab's extras, below the player while open (docs/features/
// media.md): the song's lyrics, or the player's upcoming songs. Each works
// only while its panel is open (setOpen).
//
// Lyrics:  the current line large, the others dim, the current one kept
//          in the middle; Earlier / +0.00 / Later shift the timing.
// Up next: numbered rows with "Play now"; a refresh button.

import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import {Spinner} from 'resource:///org/gnome/shell/ui/animation.js';
import {Switch} from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {LyricsService, ONLINE_KEY} from './lyricsService.js';
import {OFFSET_STEP, activeIndex, nextVerseDelay, offsetLabel} from './lyrics.js';
import {OneShot, glibTimers} from './model.js';
import {QueueClient} from './queue.js';

const SCROLL_MS = 280;

function label(text, styleClass, wrap = false) {
    const actor = new St.Label({text, style_class: styleClass, x_expand: true});
    if (wrap) {
        actor.clutter_text.line_wrap = true;
        actor.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        actor.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    }
    return actor;
}

function textButton(text, accessibleName = text) {
    return new St.Button({
        style_class: 'froonty-media-text-button',
        label: text,
        accessible_name: accessibleName,
        can_focus: true,
        track_hover: true,
        y_align: Clutter.ActorAlign.CENTER,
    });
}

/** A short message, with room for a control under it. */
class Message {
    constructor() {
        this.actor = new St.BoxLayout({
            style_class: 'froonty-media-message',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.spinner = new Spinner(16, {hideOnStop: true});
        this.spinner.x_align = Clutter.ActorAlign.CENTER;
        this.actor.add_child(this.spinner);
        this.text = label('', 'froonty-media-message-text', true);
        this.actor.add_child(this.text);
        this.note = label('', 'froonty-media-message-note', true);
        this.actor.add_child(this.note);
    }

    destroy() {
        this.spinner.stop();
        this.actor.destroy();
        this.actor = null;
    }

    show(text, note = '', {loading = false} = {}) {
        this.text.text = text;
        this.note.text = note;
        this.note.visible = Boolean(note);
        if (loading)
            this.spinner.play();
        else
            this.spinner.stop();
    }
}

export class LyricsPanel {
    /**
     * @param {object} options {settings, media (MediaService)}
     */
    constructor({settings, media}) {
        this._settings = settings;
        this._media = media;
        this._lyrics = new LyricsService({settings, media});
        this._open = false;
        this._shown = null; // the lyrics object the lines show
        this._active = -2;
        this._ids = [];
        this._wake = new OneShot(glibTimers, () => this._follow());

        this.actor = new St.BoxLayout({
            style_class: 'froonty-media-lyrics',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
        });
        this._hint = label('', 'froonty-media-lyrics-hint');
        this.actor.add_child(this._hint);

        this._lines = new St.BoxLayout({
            style_class: 'froonty-media-lyrics-lines',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._scroll = new St.ScrollView({
            style_class: 'froonty-media-lyrics-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true,
        });
        this._scroll.add_child(this._lines);
        this.actor.add_child(this._scroll);

        this._message = new Message();
        this.actor.add_child(this._message.actor);

        // Consent: a switch for media-lyrics-online, with what it sends.
        this._consent = new St.Button({
            style_class: 'froonty-media-consent',
            can_focus: true,
            track_hover: true,
            accessible_name: _('Find lyrics online'),
            x_align: Clutter.ActorAlign.CENTER,
        });
        const consentBox = new St.BoxLayout({style_class: 'froonty-media-consent-box'});
        consentBox.add_child(new St.Label({text: _('Find lyrics online'), y_align: Clutter.ActorAlign.CENTER}));
        this._switch = new Switch(settings.get_boolean(ONLINE_KEY));
        consentBox.add_child(this._switch);
        this._consent.child = consentBox;
        this._consent.connect('clicked', () =>
            settings.set_boolean(ONLINE_KEY, !settings.get_boolean(ONLINE_KEY)));
        this._message.actor.add_child(this._consent);

        this._retry = textButton(_('Try again'));
        this._retry.x_align = Clutter.ActorAlign.CENTER;
        this._retry.connect('clicked', () => this._lyrics.retry());
        this._message.actor.add_child(this._retry);

        // Timing: Earlier, the offset (Reset), Later.
        this._timing = new St.BoxLayout({
            style_class: 'froonty-media-lyrics-timing',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this.earlier = textButton(_('Earlier'));
        this.earlier.connect('clicked', () => this._lyrics.adjust(-OFFSET_STEP));
        this.reset = textButton('+0.00', _('Reset'));
        this.reset.connect('clicked', () => this._lyrics.resetOffset());
        this.later = textButton(_('Later'));
        this.later.connect('clicked', () => this._lyrics.adjust(OFFSET_STEP));
        for (const button of [this.earlier, this.reset, this.later])
            this._timing.add_child(button);
        this.actor.add_child(this._timing);

        this._settingsId = settings.connect(`changed::${ONLINE_KEY}`, () => {
            this._switch.state = settings.get_boolean(ONLINE_KEY);
        });
        this._sync();
    }

    /** The lyrics service (tests). */
    get service() {
        return this._lyrics;
    }

    setOpen(open) {
        if (open === this._open)
            return;
        this._open = open;
        if (open) {
            this._ids = [
                [this._lyrics, this._lyrics.connect('changed', () => this._sync())],
                [this._media, this._media.connect('position-changed', () => this._follow())],
                [this._media, this._media.connect('changed', () => this._follow())],
            ];
            this._lyrics.setOpen(true);
            this._sync();
        } else {
            for (const [object, id] of this._ids)
                object.disconnect(id);
            this._ids = [];
            this._wake.stop();
            this._message.spinner.stop();
            this._lyrics.setOpen(false);
        }
    }

    destroy() {
        this.setOpen(false);
        this._settings.disconnect(this._settingsId);
        this._lyrics.destroy();
        this._message.destroy();
        this.actor.destroy();
    }

    _sync() {
        const state = this._lyrics.state;
        const lyrics = this._lyrics.lyrics;
        const ready = state === 'ready' && lyrics;
        this._consent.visible = state === 'consent';
        this._retry.visible = state === 'failed';
        this._message.actor.visible = !ready && state !== 'idle';
        switch (state) {
        case 'consent':
            this._message.show(_('Sends the song’s title, artist, album and length to lrclib.net.'));
            break;
        case 'loading':
            this._message.show(_('Loading lyrics…'), '', {loading: true});
            break;
        case 'unavailable':
            this._message.show(_('No matching lyrics for this recording.'));
            break;
        case 'failed':
            this._message.show(_('Could not load the lyrics.'));
            break;
        default:
            this._message.show('');
        }
        this._scroll.visible = Boolean(ready);
        if (ready && lyrics !== this._shown)
            this._fill(lyrics);
        if (!ready)
            this._shown = null;
        this.reset.label = offsetLabel(this._lyrics.offset);
        this._follow();
    }

    _fill(lyrics) {
        this._shown = lyrics;
        this._active = -2;
        this._lines.destroy_all_children();
        if (lyrics.instrumental) {
            this._lines.add_child(label('♪', 'froonty-media-lyric froonty-media-lyric-plain'));
            return;
        }
        const timed = lyrics.lines.length > 0;
        const texts = timed ? lyrics.lines.map(line => line.text || '♪') : [lyrics.plain];
        for (const text of texts)
            this._lines.add_child(label(text, `froonty-media-lyric${timed ? '' : ' froonty-media-lyric-plain'}`, true));
        this._scroll.vadjustment.value = 0;
    }

    // Highlights the current line and wakes up at the next one (no timer
    // while paused, without a position, or after the last line).
    _follow() {
        this._wake.stop();
        const lyrics = this._shown;
        const timed = lyrics && lyrics.lines.length > 0 && !lyrics.instrumental;
        const timing = this._media.timing;
        this._timing.visible = Boolean(timed);
        if (!timed) {
            this._hint.visible = false;
            return;
        }
        this.reset.label = offsetLabel(this._lyrics.offset);
        if (!timing.hasPosition) {
            this._hint.text = _('The player does not share its position.');
            this._hint.visible = true;
            this._highlight(null, true);
            return;
        }
        const index = activeIndex(lyrics.lines, timing.positionS, this._lyrics.offset);
        this._hint.text = _('Waiting for the first verse');
        this._hint.visible = index === null;
        this._highlight(index, false);
        const delay = nextVerseDelay(lyrics.lines, timing, this._lyrics.offset);
        if (delay !== null && this._open)
            this._wake.restart(delay);
    }

    /** The highlighted line's index (tests), or null. */
    get activeLine() {
        return this._active >= 0 ? this._active : null;
    }

    _highlight(index, plain) {
        const value = plain ? -1 : index ?? -1;
        if (value === this._active)
            return;
        this._active = value;
        const lines = this._lines.get_children();
        lines.forEach((line, i) => {
            if (i === value)
                line.add_style_class_name('froonty-media-lyric-active');
            else
                line.remove_style_class_name('froonty-media-lyric-active');
            if (plain)
                line.add_style_class_name('froonty-media-lyric-plain');
            else
                line.remove_style_class_name('froonty-media-lyric-plain');
        });
        const line = lines[value];
        if (!line)
            return;
        const adjustment = this._scroll.vadjustment;
        const box = line.get_allocation_box();
        const target = Math.max(0, (box.y1 + box.y2) / 2 - adjustment.page_size / 2);
        adjustment.remove_transition('value');
        if (St.Settings.get().enable_animations && this._scroll.mapped) {
            adjustment.ease(target, {
                duration: SCROLL_MS,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        } else {
            adjustment.value = target;
        }
    }
}

export class QueuePanel {
    /**
     * @param {object} options {media (MediaService), context: () → the
     *   tab's rendered command context, openPlayer: () → void}
     */
    constructor({media, context, openPlayer}) {
        this._media = media;
        this._context = context;
        this._queue = new QueueClient({media});
        this._open = false;
        this._queueId = 0;

        this.actor = new St.BoxLayout({
            style_class: 'froonty-media-queue',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
        });
        const header = new St.BoxLayout({style_class: 'froonty-media-queue-header'});
        header.add_child(label(_('Up next'), 'froonty-media-queue-title'));
        this.refreshButton = new St.Button({
            style_class: 'froonty-icon-button',
            accessible_name: _('Refresh'),
            can_focus: true,
            track_hover: true,
            child: new St.Icon({icon_name: 'view-refresh-symbolic'}),
        });
        this.refreshButton.connect('clicked', () => this._queue.refresh());
        header.add_child(this.refreshButton);
        this.actor.add_child(header);

        this._rows = new St.BoxLayout({
            style_class: 'froonty-media-queue-rows',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._scroll = new St.ScrollView({
            style_class: 'froonty-media-queue-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true,
        });
        this._scroll.add_child(this._rows);
        this.actor.add_child(this._scroll);

        this._message = new Message();
        this._openButton = textButton(_('Open player'));
        this._openButton.x_align = Clutter.ActorAlign.CENTER;
        this._openButton.connect('clicked', () => openPlayer());
        this._message.actor.add_child(this._openButton);
        this.actor.add_child(this._message.actor);

        this._notice = label('', 'froonty-media-queue-notice', true);
        this.actor.add_child(this._notice);
        this._sync();
    }

    /** The queue client (tests). */
    get client() {
        return this._queue;
    }

    setOpen(open) {
        if (open === this._open)
            return;
        this._open = open;
        if (open) {
            this._queueId = this._queue.connect('changed', () => this._sync());
            this._queue.setOpen(true);
        } else {
            this._queue.disconnect(this._queueId);
            this._queueId = 0;
            this._queue.setOpen(false);
            this._message.spinner.stop();
        }
        this._sync();
    }

    destroy() {
        this.setOpen(false);
        this._queue.destroy();
        this._message.destroy();
        this.actor.destroy();
    }

    _sync() {
        const {state, rows, notice} = this._queue;
        this._scroll.visible = state === 'ready';
        this._message.actor.visible = state !== 'ready';
        this._openButton.visible = state === 'unsupported' && Boolean(this._media.playback?.canOpen);
        switch (state) {
        case 'loading':
            this._message.show(_('Loading…'), '', {loading: true});
            break;
        case 'empty':
            this._message.show(_('No upcoming songs'));
            break;
        case 'failed':
            this._message.show(_('Could not read the upcoming songs.'));
            break;
        case 'unsupported':
            this._message.show(_('This player does not share its upcoming songs.'));
            break;
        default:
            this._message.show('');
        }
        this._notice.text = notice === 'did-not-switch' ? _('The player did not switch to this song.') : '';
        this._notice.visible = Boolean(this._notice.text);
        if (state === 'ready')
            this._fill(rows);
    }

    _fill(rows) {
        this._rows.destroy_all_children();
        const canControl = this._media.playback?.caps.canControl ?? false;
        for (const row of rows) {
            const box = new St.BoxLayout({style_class: 'froonty-media-queue-row', x_expand: true});
            box.add_child(new St.Label({
                text: String(row.offset),
                style_class: 'froonty-media-queue-offset',
                y_align: Clutter.ActorAlign.CENTER,
            }));
            const text = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            const title = new St.Label({text: row.title, style_class: 'froonty-media-queue-song'});
            title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            text.add_child(title);
            if (row.artist) {
                const artist = new St.Label({text: row.artist, style_class: 'froonty-media-queue-artist'});
                artist.clutter_text.ellipsize = Pango.EllipsizeMode.END;
                text.add_child(artist);
            }
            box.add_child(text);
            if (canControl) {
                const play = new St.Button({
                    style_class: 'froonty-icon-button froonty-media-queue-play',
                    accessible_name: _('Play now: %s').format(row.title),
                    can_focus: true,
                    track_hover: true,
                    y_align: Clutter.ActorAlign.CENTER,
                    child: new St.Icon({icon_name: 'media-playback-start-symbolic'}),
                });
                play.connect('clicked', () => this._queue.playNow(row, this._context()));
                box.add_child(play);
            }
            this._rows.add_child(box);
        }
    }
}
