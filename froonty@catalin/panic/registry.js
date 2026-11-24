// SPDX-License-Identifier: GPL-3.0-or-later
// Shell-side factories for the panic buttons in catalog.js. Each returns an
// object with `actor`, `destroy()` and optionally `setActive(shown)` (told
// when the hub is shown or hidden). Future panic buttons: add an entry to
// catalog.js and a factory here.

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {AudioMuteButton} from './audioMute.js';
import {byId} from './catalog.js';
import {ClaudeSessionButton} from './claudeSession.js';
import {CpuLoadButton} from './cpuLoad.js';
import {DesktopWidgetsButton} from './desktopWidgets.js';
import {FanLockButton} from './fanLock.js';
import {HorizonRefreshButton} from './horizonRefresh.js';
import {MarketsRefreshButton} from './marketsRefresh.js';
import {PauseMediaButton} from './pauseMedia.js';
import {PinIslandButton} from './pinIsland.js';
import {SitStandButton} from './sitStand.js';
import {TemperatureButton} from './temperature.js';

const FACTORIES = {
    'pin-island': (title, actions) => new PinIslandButton(title, actions.settings),
    'mute-microphone': title => new AudioMuteButton('input', title),
    'mute-sound': title => new AudioMuteButton('output', title),
    // The load and thermometer buttons also take actions.metrics, the
    // panic bar's shared PanicMetricsService, and set `usesMetrics`, so
    // the bar samples only while one of them is shown (ui/panicBar.js).
    // The camera button is switched off for now (catalog.js); offering
    // it again also takes its factory here: a CameraBlockButton, of
    // camera.js, for 'block-camera'.
    'claude-session': (title, actions) => new ClaudeSessionButton(title, actions),
    'cpu-load': (title, actions) => new CpuLoadButton(title, actions),
    'desktop-widgets': (title, actions) => new DesktopWidgetsButton(title, actions.settings),
    'fan-lock': (title, actions) => new FanLockButton(title, actions),
    // Both also take actions.ctx, for their menu and settings page.
    'horizon-refresh': (title, actions) => new HorizonRefreshButton(title, actions),
    'markets-refresh': (title, actions) => new MarketsRefreshButton(title, actions),
    'pause-media': (title, actions) => new PauseMediaButton(title, actions),
    'sit-stand': (title, actions) => new SitStandButton(title, actions),
    temperature: (title, actions) => new TemperatureButton(title, actions),
};

/**
 * @param {string} id
 * @param {object} actions what a button may use
 * @param {Function} actions.selectTab (featureId) → whether that tab exists
 * @param {Gio.Settings} actions.settings Froonty's settings
 * @param {object} actions.ctx the feature context
 * @returns {?object} a panic button, or null for an unknown id
 */
export function createPanicButton(id, actions) {
    const entry = byId(id);
    const factory = FACTORIES[id];
    return entry && factory ? factory(entry.title(_), actions) : null;
}
