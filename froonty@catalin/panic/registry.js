// SPDX-License-Identifier: GPL-3.0-or-later
// Shell-side factories for the panic buttons in catalog.js. Each returns an
// object with `actor` and `destroy()`. Future panic buttons: add an entry to
// catalog.js and a factory here.

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {AudioMuteButton} from './audioMute.js';
import {byId} from './catalog.js';

const FACTORIES = {
    'mute-microphone': title => new AudioMuteButton('input', title),
    'mute-sound': title => new AudioMuteButton('output', title),
};

/** @returns {?object} a panic button, or null for an unknown id */
export function createPanicButton(id) {
    const entry = byId(id);
    const factory = FACTORIES[id];
    return entry && factory ? factory(entry.title(_)) : null;
}
