// SPDX-License-Identifier: GPL-3.0-or-later
// Features of the working tree that are not in the public build yet:
// tools/pack-public replaces this file with an empty list, and their
// settings tabs come from localPrefs.js. Each moves to registry.js once it
// is submitted to extensions.gnome.org (ZeroTier and Writing stay local).

// `break` is a reserved word.
import breakFeature from './break/index.js';
import claude from './claude/index.js';
import clipboard from './clipboard/index.js';
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
];
