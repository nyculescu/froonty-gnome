// SPDX-License-Identifier: GPL-3.0-or-later
// Panic buttons "Mute microphone" and "Mute sound": toggle the mute of the
// default input (microphone) or output (all system sound). Event-driven:
// follows the default device and its mute state, whoever changes them.

import Gvc from 'gi://Gvc';
import St from 'gi://St';

import {getMixer} from '../shell/mixer.js';

const KINDS = {
    input: {
        defaultStream: control => control.get_default_source(),
        changedSignal: 'default-source-changed',
        icons: {on: 'audio-input-microphone-symbolic', muted: 'microphone-sensitivity-muted-symbolic'},
    },
    output: {
        defaultStream: control => control.get_default_sink(),
        changedSignal: 'default-sink-changed',
        icons: {on: 'audio-volume-high-symbolic', muted: 'audio-volume-muted-symbolic'},
    },
};

export class AudioMuteButton {
    /**
     * @param {'input'|'output'} kind
     * @param {string} title accessible name
     */
    constructor(kind, title) {
        this._kind = KINDS[kind];
        this._control = getMixer();
        this._stream = null;

        this.actor = new St.Button({
            style_class: 'froonty-icon-button froonty-panic-button',
            accessible_name: title,
            can_focus: true,
            track_hover: true,
            child: new St.Icon(),
        });
        this.actor.connect('clicked', () => this._toggle());

        this._control.connectObject(
            'state-changed', () => this._syncStream(),
            this._kind.changedSignal, () => this._syncStream(),
            this);
        this._syncStream();
    }

    destroy() {
        this._control.disconnectObject(this);
        this._stream?.disconnectObject(this);
        this.actor.destroy();
    }

    // The default device can change (headset plugged in, chosen in
    // Settings); follow it and its mute state.
    _syncStream() {
        const ready = this._control.get_state() === Gvc.MixerControlState.READY;
        const stream = ready ? this._kind.defaultStream(this._control) : null;
        if (stream !== this._stream) {
            this._stream?.disconnectObject(this);
            this._stream = stream;
            this._stream?.connectObject('notify::is-muted', () => this._syncState(), this);
        }
        this._syncState();
    }

    _syncState() {
        const muted = this._stream?.is_muted ?? false;
        this.actor.checked = muted;
        this.actor.reactive = this._stream !== null;
        this.actor.child.icon_name = muted ? this._kind.icons.muted : this._kind.icons.on;
    }

    _toggle() {
        this._stream?.change_is_muted(!this._stream.is_muted);
    }
}
