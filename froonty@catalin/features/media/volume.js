// SPDX-License-Identifier: GPL-3.0-or-later
// The Media tab's output volume: mute and a slider for GNOME's default
// output, on the Shell's shared mixer (shell/mixer.js), as Quick Settings
// does. It follows the default output like the "Mute sound" panic button
// (panic/audioMute.js). No over-amplification (100% at most) and no
// output-device menu: Quick Settings has both.
//
// Connected only while the tab is on screen (setActive).

import Clutter from 'gi://Clutter';
import Gvc from 'gi://Gvc';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';

import {getMixer} from '../../shell/mixer.js';

export class OutputVolume {
    constructor() {
        this._control = null;
        this._stream = null;
        this._updating = false;

        this.actor = new St.BoxLayout({
            style_class: 'froonty-media-volume',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this.muteButton = new St.Button({
            style_class: 'froonty-icon-button froonty-media-mute',
            can_focus: true,
            track_hover: true,
            child: new St.Icon({icon_name: 'audio-volume-high-symbolic'}),
        });
        this.muteButton.connect('clicked', () =>
            this._stream?.change_is_muted(!this._stream.is_muted));
        this.slider = new Slider(0);
        this.slider.add_style_class_name('froonty-media-volume-slider');
        this.slider.accessible_name = _('Volume');
        this.slider.x_expand = false;
        this.slider.y_align = Clutter.ActorAlign.CENTER;
        this.slider.connect('notify::value', () => this._onSliderChanged());
        this.actor.add_child(this.muteButton);
        this.actor.add_child(this.slider);
    }

    /** True once the mixer has a default output to show. */
    get ready() {
        return this._stream !== null;
    }

    /** Follows the mixer while `active` (the tab on screen). */
    setActive(active, onReadyChanged = () => {}) {
        this._onReadyChanged = onReadyChanged;
        if (active && !this._control) {
            this._control = getMixer();
            this._control.connectObject(
                'state-changed', () => this._syncStream(),
                'default-sink-changed', () => this._syncStream(),
                this);
            this._syncStream();
        } else if (!active && this._control) {
            this._control.disconnectObject(this);
            this._control = null;
            this._setStream(null);
            this._sync();
        }
    }

    destroy() {
        this.setActive(false);
        this.actor.destroy();
    }

    _syncStream() {
        const ready = this._control?.get_state() === Gvc.MixerControlState.READY;
        this._setStream(ready ? this._control.get_default_sink() : null);
        this._sync();
    }

    _setStream(stream) {
        if (stream === this._stream)
            return;
        this._stream?.disconnectObject(this);
        this._stream = stream;
        this._stream?.connectObject(
            'notify::volume', () => this._sync(),
            'notify::is-muted', () => this._sync(),
            this);
    }

    _sync() {
        const wasVisible = this.actor.visible;
        this.actor.visible = this._stream !== null;
        if (this._stream) {
            const muted = this._stream.is_muted;
            this.muteButton.child.icon_name = muted
                ? 'audio-volume-muted-symbolic' : 'audio-volume-high-symbolic';
            this.muteButton.accessible_name = muted ? _('Unmute') : _('Mute');
            this.muteButton.checked = muted;
            const max = this._control.get_vol_max_norm();
            this._updating = true;
            this.slider.value = Math.min(1, Math.max(0, this._stream.volume / max));
            this._updating = false;
        }
        if (wasVisible !== this.actor.visible)
            this._onReadyChanged?.();
    }

    _onSliderChanged() {
        if (this._updating || !this._stream || !this._control)
            return;
        this._stream.volume = this.slider.value * this._control.get_vol_max_norm();
        this._stream.push_volume();
    }
}
