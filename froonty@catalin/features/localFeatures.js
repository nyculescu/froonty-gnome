// SPDX-License-Identifier: GPL-3.0-or-later
// Features of the working tree that are not in the public build yet:
// tools/pack-public replaces this file with an empty list, and their
// settings tabs come from localPrefs.js. Each moves to registry.js once it
// is submitted to extensions.gnome.org (ZeroTier, Writing and Formulas
// stay local). LOCAL_PARTS (Software brightness) are not tabs.

// `break` is a reserved word.
import breakFeature from './break/index.js';
import {SoftwareBrightness} from './brightness/overlay.js';
import claude from './claude/index.js';
import clipboard from './clipboard/index.js';
import formulas from './formulas/index.js';
import killprocess from './killprocess/index.js';
import media from './media/index.js';
import sysmon from './sysmon/index.js';
import writing from './writing/index.js';
import zerotier from './zerotier/index.js';

export const LOCAL_FEATURES = [
    media,
    claude,
    sysmon,
    clipboard,
    killprocess,
    breakFeature,
    zerotier,
    writing,
    formulas,
];

// Not hub tabs: parts that live while Froonty runs (extension.js), each
// made from the settings.
export const LOCAL_PARTS = [
    settings => new SoftwareBrightness(settings),
];
