// SPDX-License-Identifier: GPL-3.0-or-later
// Shell-side factories for localCatalog.js's panic buttons.
// tools/pack-public replaces this file with an empty map.

import {ClaudeSessionButton} from './claudeSession.js';
import {PauseMediaButton} from './pauseMedia.js';
import {SitStandButton} from './sitStand.js';

export const LOCAL_FACTORIES = {
    'claude-session': (title, actions) => new ClaudeSessionButton(title, actions),
    'pause-media': (title, actions) => new PauseMediaButton(title, actions),
    'sit-stand': (title, actions) => new SitStandButton(title, actions),
};
