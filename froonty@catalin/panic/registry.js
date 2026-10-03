// SPDX-License-Identifier: GPL-3.0-or-later
// Shell-side factories for the panic buttons in catalog.js. Each returns an
// object with `actor`, `destroy()` and optionally `setActive(shown)` (told
// when the hub is shown or hidden). Future panic buttons: add an entry to
// catalog.js and a factory here.

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {AudioMuteButton} from './audioMute.js';
import {byId} from './catalog.js';
import {LOCAL_FACTORIES} from './localFactories.js';

const FACTORIES = {
    'mute-microphone': title => new AudioMuteButton('input', title),
    'mute-sound': title => new AudioMuteButton('output', title),
    // The camera button is switched off for now (localCatalog.js); offering
    // it again also takes its factory here: a CameraBlockButton, of
    // camera.js, for 'block-camera'.
    ...LOCAL_FACTORIES,
};

/**
 * @param {string} id
 * @param {object} actions
 * @param {Function} actions.selectTab (featureId) → whether that tab exists
 * @param {Gio.Settings} actions.settings Froonty's settings
 * @param {object} actions.ctx the feature context (settings, memory)
 * @returns {?object} a panic button, or null for an unknown id
 */
export function createPanicButton(id, actions) {
    const entry = byId(id);
    const factory = FACTORIES[id];
    return entry && factory ? factory(entry.title(_), actions) : null;
}
