// SPDX-License-Identifier: GPL-3.0-or-later
// GNOME's break-reminder engine (Settings → Wellbeing), for the Break tab
// (docs/features/break.md).
//
// PRIVATE / INTERNAL API: Main.breakManager is an internal Shell component
// (misc/breakManager.js), exported by ui/main.js since GNOME 48 and made
// at startup in every session, even with breaks off. This is the only
// place that reads it; shell/breakEngine.js wraps the object (and is
// Shell-free, so it is unit-tested against GNOME's own class).

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

/** GNOME's BreakManager, or null when this Shell has none. */
export const breakManager = () => Main.breakManager ?? null;
