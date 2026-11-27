// SPDX-License-Identifier: GPL-3.0-or-later
// The System card's graph line: which readings it strokes. A period holds
// far more readings than a graph has pixel columns (900 at 2 s over 30
// minutes), so each column keeps only its lowest and highest. Pure, so it
// loads in plain gjs tests.

/**
 * A graph's pixel columns, fixed in time rather than to its edges: what a
 * column keeps stays put as the graph scrolls, so a noisy band does not
 * change its texture on every sample.
 *
 * @param {number} periodMs the time the graph's width spans
 * @param {number} pixels that width, in device pixels
 * @returns {function(number): number} a time to its column
 */
export function timeColumns(periodMs, pixels) {
    return t => t / periodMs * pixels;
}

/**
 * The runs of a graph's line: a pause of more than `gapMs` between two
 * readings ends one. Within a run, per pixel column, only the lowest and
 * the highest reading stay, in time order, so a spike survives and what is
 * kept has the same low and high as all the readings.
 *
 * @param {Array<{t, v}>} points in time order
 * @param {function(number): number} columnOf a time to its pixel column
 * @param {number} gapMs
 * @returns {Array<Array<{t, v}>>} each run's readings kept, in time order
 */
export function lineRuns(points, columnOf, gapMs) {
    const runs = [];
    let run = null;
    let column = null;
    let low = -1;
    let high = -1;
    const flush = () => {
        if (low < 0)
            return;
        run.push(points[Math.min(low, high)]);
        if (low !== high)
            run.push(points[Math.max(low, high)]);
        low = high = -1;
    };
    points.forEach((point, i) => {
        const at = Math.floor(columnOf(point.t));
        const starts = i === 0 || point.t - points[i - 1].t > gapMs;
        if (starts || at !== column) {
            flush();
            column = at;
        }
        if (starts) {
            run = [];
            runs.push(run);
        }
        if (low < 0 || point.v < points[low].v)
            low = i;
        if (high < 0 || point.v > points[high].v)
            high = i;
    });
    flush();
    return runs;
}
