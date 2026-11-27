// SPDX-License-Identifier: GPL-3.0-or-later
// livenerf: Claude Opus 5.5 against its own launch week, as the project's
// README reports it (docs/features/claude.md). Pure: parsing only, no Gio,
// no St, so it is unit-tested with plain gjs.
//
// livenerf (https://github.com/ninjahawk/livenerf, third_party/livenerf)
// publishes no machine-readable results: its logs are private, and each
// daily run only redraws charts and edits the README. Two files are read:
// - the README: the "Progress" line under Status, and the Results table;
// - the hero chart, media/livenerf-dark.svg (livenerf/plot.py): its points
//   and error bars, read back through the chart's own labelled grid.
// Anything this reader does not recognise is left out, never guessed.

const RAW = 'https://raw.githubusercontent.com/ninjahawk/livenerf/main';
export const README_PATH = 'README.md';
export const CHART_PATH = 'media/livenerf-dark.svg';
export const urlFor = path => `${RAW}/${path}`;

const MINUS = /[−–]/g; // − and –, as a sign
const NUMBER = String.raw`[+-]?\d+(?:\.\d+)?`;

/**
 * What livenerf's README reports.
 *
 * @param {string} text the README, Markdown
 * @returns {{progress: object|null, result: object|null}|null}
 *   progress: {date, collected, total, baselineCollected, baselineTotal}
 *   (days; the baseline pair may be null), from "**Progress (2026-09-30):**
 *   7 of 30 days collected (baseline 7 of 10)". result: the last Results
 *   row with a measured Δ (points ± SE), {window, deltaText, decision},
 *   verbatim. Null when neither is found.
 */
export function benchmarkFromReadme(text) {
    if (typeof text !== 'string')
        return null;
    const progress = parseProgress(text);
    const result = parseResults(text);
    if (!progress && !result)
        return null;
    return {progress, result};
}

function parseProgress(text) {
    // Hard-wrapped prose: a line break may fall anywhere in the sentence.
    const flat = text.replace(/\s+/g, ' ');
    const match = flat.match(new RegExp(String.raw`\*\*Progress \((\d{4}-\d{2}-\d{2})\):\*\* ` +
        String.raw`(\d+) of (\d+) days collected(?: \(baseline (\d+) of (\d+)\))?`));
    if (!match)
        return null;
    const [, date, collected, total, baselineCollected, baselineTotal] = match;
    if (+total <= 0 || +collected > +total)
        return null;
    return {
        date,
        collected: +collected,
        total: +total,
        baselineCollected: baselineTotal ? +baselineCollected : null,
        baselineTotal: baselineTotal ? +baselineTotal : null,
    };
}

// | # | window | samples | score | Δ vs baseline ± SE | … | decision |
function parseResults(text) {
    const lines = text.split('\n');
    const start = lines.findIndex(l => /^##\s+Results\s*$/.test(l.trim()));
    if (start < 0)
        return null;
    let i = start + 1;
    while (i < lines.length && !lines[i].trim().startsWith('|')) {
        if (/^#{1,2}\s/.test(lines[i].trim()))
            return null; // the next section, no table
        i++;
    }
    const header = cells(lines[i] ?? '');
    const col = {
        window: header.findIndex(c => /^window/i.test(c)),
        delta: header.findIndex(c => c.startsWith('Δ')),
        decision: header.findIndex(c => /^decision/i.test(c)),
    };
    if (col.window < 0 || col.delta < 0)
        return null;

    let result = null;
    // i + 1 is the |---|---| separator.
    for (i += 2; i < lines.length && lines[i].trim().startsWith('|'); i++) {
        const row = cells(lines[i]);
        const deltaText = row[col.delta] ?? '';
        const measured = new RegExp(String.raw`^${NUMBER}\s*(?:pts?|points?|pp)?\s*±\s*\d+(?:\.\d+)?`)
            .test(deltaText.replace(MINUS, '-'));
        if (!measured)
            continue; // "baseline", "-", or a format not known here
        result = {
            window: row[col.window] ?? '',
            deltaText,
            decision: col.decision >= 0 ? row[col.decision] ?? '' : '',
        };
    }
    return result;
}

// A table row's cells, without Markdown emphasis or code marks.
function cells(line) {
    return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|')
        .map(c => c.replace(/[*`]/g, '').trim());
}

/**
 * The daily scores in livenerf's hero chart, as livenerf/plot.py draws it.
 *
 * Positions are pixels on a linear scale, so values are read back through
 * the chart's labelled grid lines ("40%" at y 328.0, …). plot.py rounds
 * positions to 0.1 px, a few hundredths of a point; the latest score is
 * also printed as text, and that exact text is what `latest` is.
 *
 * @param {string} text the SVG
 * @returns {object|null} {grid: [%], band: [from, to], ticks: [{at, label}],
 *   points: [{at, score, low, high}], others: [{name, color, latest,
 *   points}], latest, baselineMean, collecting: {day, of}|null, updated}. `at` and the band run from 0 (the
 *   plot's left edge) to 1 (its right edge); scores are percent correct,
 *   low and high the 95% interval. Null without a grid or points.
 */
export function chartFromSvg(text) {
    if (typeof text !== 'string' || !text.includes('<svg'))
        return null;
    const elements = [...text.matchAll(/<(line|circle|rect|text)\b([^>]*?)\/?>(?:([^<]*)<\/text>)?/g)]
        .map(([, tag, attrs, content]) => ({tag, a: attributes(attrs), text: decode(content ?? '')}));
    const texts = elements.filter(e => e.tag === 'text');

    // "40%", right-aligned left of the plot, 4 px below its grid line.
    const labels = texts.filter(e => e.a['text-anchor'] === 'end' && /^\d+%$/.test(e.text))
        .map(e => ({y: e.a.y - 4, value: parseInt(e.text)}));
    if (labels.length < 2)
        return null;
    const [l0, l1] = [labels[0], labels[labels.length - 1]];
    if (l0.y === l1.y)
        return null;
    const valueAt = y => l0.value + (l0.y - y) * (l1.value - l0.value) / (l0.y - l1.y);

    // The grid lines span the plot: their ends are its left and right edges.
    const grid = elements.find(e => e.tag === 'line' && e.a.y1 === e.a.y2 &&
        Math.abs(e.a.y1 - l0.y) < 0.5);
    if (!grid || !(grid.a.x2 > grid.a.x1))
        return null;
    const atX = x => (x - grid.a.x1) / (grid.a.x2 - grid.a.x1);

    // Each day: its 95% whisker (a vertical line in the series' colour),
    // then its dot. Other series (Fable 5.2 since 2026-11-11) are named by
    // an end label in their colour; the rest is the Opus series.
    const whiskers = elements.filter(e => e.tag === 'line' && e.a.x1 === e.a.x2 && e.a.opacity === 0.5);
    const circles = elements.filter(e => e.tag === 'circle' && Number.isFinite(e.a.cx) && Number.isFinite(e.a.cy));
    const seriesPoints = keep => circles.filter(c => keep(c.a.fill)).map(c => {
        const w = whiskers.find(l => l.a.stroke === c.a.fill && Math.abs(l.a.x1 - c.a.cx) < 0.05);
        const [lo, hi] = w ? [Math.max(w.a.y1, w.a.y2), Math.min(w.a.y1, w.a.y2)] : [c.a.cy, c.a.cy];
        return {at: atX(c.a.cx), score: valueAt(c.a.cy), low: valueAt(lo), high: valueAt(hi)};
    });
    const others = [...text.matchAll(new RegExp(String.raw`<text\b[^>]*>\s*<tspan fill="([^"]+)">([^<]+)</tspan>` +
        String.raw`\s*(\d+(?:\.\d+)?)%\s*</text>`, 'g'))]
        .map(([, color, name, value]) => ({name: decode(name), color, latest: parseFloat(value),
            points: seriesPoints(fill => fill === color)}))
        .filter(o => o.points.length);
    const otherColors = new Set(others.map(o => o.color));
    const points = seriesPoints(fill => !otherColors.has(fill));
    if (!points.length)
        return null;

    const band = elements.find(e => e.tag === 'rect' && Number.isFinite(e.a.x) && e.a.width > 0);
    const match = re => texts.map(e => e.text.match(re)).find(Boolean) ?? null;
    const latest = texts.find(e => e.a['font-weight'] === 600 && /^\d+(\.\d+)?%$/.test(e.text));
    const mean = match(/^baseline (\d+(?:\.\d+)?)%$/);
    const collecting = match(/^Collecting the baseline: day (\d+) of (\d+)\.$/);
    const footer = match(/^\d+ samples · updated (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) UTC$/);
    return {
        grid: labels.map(l => l.value).sort((a, b) => a - b),
        band: band ? [atX(band.a.x), atX(band.a.x + band.a.width)] : null,
        ticks: texts.filter(e => e.a['text-anchor'] === 'middle' && /^[A-Z][a-z]{2} \d{2}$/.test(e.text))
            .map(e => ({at: atX(e.a.x), label: e.text})),
        points,
        others,
        latest: latest ? parseFloat(latest.text) : null,
        baselineMean: mean ? +mean[1] : null,
        collecting: collecting ? {day: +collecting[1], of: +collecting[2]} : null,
        updated: footer ? Date.parse(`${footer[1].replace(' ', 'T')}:00Z`) : null,
    };
}

/**
 * How much of the chart, from its right edge, shows the last `days` days:
 * from half a day before the earliest of them. livenerf spaces days
 * evenly, so the usual gap between points is a day; a missed day only
 * widens one gap.
 *
 * @param {Array<{at: number}>} points every series' points
 * @param {number} days
 * @returns {number} from 0 to 1 (all of it)
 */
export function recentSpan(points, days) {
    const ats = points.map(p => p.at).sort((a, b) => a - b);
    const gaps = ats.slice(1).map((at, i) => at - ats[i]).filter(g => g > 0).sort((a, b) => a - b);
    if (!gaps.length)
        return 1;
    const day = gaps[Math.floor(gaps.length / 2)];
    return Math.min(1, 1 - (ats[ats.length - 1] - (days - 0.5) * day));
}

// Numbers as numbers; everything else as written.
function attributes(text) {
    const out = {};
    for (const [, name, value] of text.matchAll(/([\w-]+)="([^"]*)"/g))
        out[name] = /^-?\d+(\.\d+)?$/.test(value) ? +value : value;
    return out;
}

function decode(text) {
    return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'").replace(/&amp;/g, '&').trim();
}
