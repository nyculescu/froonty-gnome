// SPDX-License-Identifier: GPL-3.0-or-later
// Features kept out of public extension packages.

import writing from './writing/index.js';
import zerotier from './zerotier/index.js';

export const LOCAL_FEATURES = [zerotier, writing];
