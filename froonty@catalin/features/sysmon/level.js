// SPDX-License-Identifier: GPL-3.0-or-later
// The Btop tab's level: a share (load, used space) as five cells, one per
// 20%, green to red (user request). No St, so it loads in plain gjs tests.
//
//   0% _____   20% ▂____   40% ▂▄___   60% ▂▄▆__   80% ▂▄▆▇_   100% ▂▄▆▇█
//
// Cell n (1-5) is coloured by the CSS class froonty-sysmon-cell-n (green,
// lime, yellow, orange, red); an empty one by froonty-sysmon-cell-empty.

export const LEVEL_GLYPHS = ['▂', '▄', '▆', '▇', '█'];
const EMPTY = '_';

/**
 * The five cells for `fraction` (0…1).
 *
 * @returns {{glyph: string, styleClass: string}[]}
 */
export function levelCells(fraction) {
    const reached = Math.round(Math.min(1, Math.max(0, fraction)) * LEVEL_GLYPHS.length);
    return LEVEL_GLYPHS.map((glyph, i) => i < reached
        ? {glyph, styleClass: `froonty-sysmon-cell-${i + 1}`}
        : {glyph: EMPTY, styleClass: 'froonty-sysmon-cell-empty'});
}
