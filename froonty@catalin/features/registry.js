// SPDX-License-Identifier: GPL-3.0-or-later
// Every hub feature, in tab order, and the parts that are not tabs. Adding
// or removing a feature is a one-line change here (plus its settings page
// in features/pages.js, which runs in a separate GTK process and cannot
// load these Shell-side modules). Each one can be turned off (enabledKey);
// the date and time are in the island itself (the collapsed pill, the hub
// header's date pill).

// `break` is a reserved word.
import breakFeature from './break/index.js';
import {SoftwareBrightness} from './brightness/overlay.js';
import claude from './claude/index.js';
import clipboard from './clipboard/index.js';
import formulas from './formulas/index.js';
import killprocess from './killprocess/index.js';
import localsend from './localsend/index.js';
import media from './media/index.js';
import notes from './notes/index.js';
import {PadNoiseSliderPart} from './padNoiseSlider/quickSlider.js';
import sysmon from './sysmon/index.js';
import {TimezonePlannerPart} from './timezonePlanner/quickSettings.js';
import writing from './writing/index.js';
import zerotier from './zerotier/index.js';

export const FEATURES = [
    notes,
    media,
    claude,
    sysmon,
    clipboard,
    killprocess,
    breakFeature,
    zerotier,
    localsend,
    writing,
    formulas,
];

// Not hub tabs: parts that live while Froonty runs (extension.js), each
// made from the settings and a function that opens a settings page:
// Software brightness, the pad noise slider, the time zone planner.
export const PARTS = [
    (settings, openSettings) => new SoftwareBrightness(settings, openSettings),
    (settings, openSettings) => new PadNoiseSliderPart(settings, openSettings),
    (settings, openSettings) => new TimezonePlannerPart(settings, openSettings),
];
