// SPDX-License-Identifier: GPL-3.0-or-later
// Adapter: GNOME Shell's shared audio mixer (Gvc.MixerControl).
//
// SHELL API (exported, not formally stable), GNOME Shell 50:
//   ui/status/volume.js  getMixerControl()  the singleton behind the Quick
//                                           Settings volume and microphone
//                                           sliders, already connected to the
//                                           sound server (PipeWire/Pulse).
// Reusing it means no second sound-server connection, and mute changes
// made anywhere (keys, Quick Settings, other apps) are seen at once.

import * as Volume from 'resource:///org/gnome/shell/ui/status/volume.js';

/** @returns {Gvc.MixerControl} */
export function getMixer() {
    return Volume.getMixerControl();
}
