// SPDX-License-Identifier: GPL-3.0-or-later
// Break ideas: a line to try during a break, from Stretchly (BSD-2-Clause)
// and Safe Eyes (GPL-3.0-or-later), as tools/import-break-ideas.py chose
// them (exercises/ideas.json; the licences in exercises/IDEAS-LICENSE.md).
// Short ideas suit eye breaks and short pauses, long ones movement breaks
// and long rests. Read once, in the background; Gio only.

import Gio from 'gi://Gio';

Gio._promisify(Gio.File.prototype, 'load_contents_async');

const ideasFile = () => Gio.File.new_for_uri(import.meta.url).get_parent()
    .get_child('exercises').get_child('ideas.json');

const isText = value => typeof value === 'string' && value.trim() !== '';
const listOf = value => Array.isArray(value) ? value : [];

/**
 * The ideas it can show: {short: [{text, source}], long: [{title?, text,
 * source}]}, empty lists for data it does not understand. An idea whose
 * source is not recorded (so whose licence is unknown) is left out, and so
 * is a short idea on more than one line.
 */
export function validate(data) {
    if (data?.format !== 1 || !Array.isArray(data.sources))
        return {short: [], long: []};
    const sources = new Set(data.sources.filter(s => isText(s?.id) && isText(s.license)).map(s => s.id));
    const known = idea => isText(idea?.text) && sources.has(idea.source);
    return {
        short: listOf(data.short).filter(idea => known(idea) && !/[\r\n]/.test(idea.text)),
        long: listOf(data.long).filter(idea => known(idea) && (idea.title === undefined || isText(idea.title))),
    };
}

/** The idea at `index`, counting round the list (any integer); null for an empty list. */
export function pickIdea(list, index) {
    if (!list?.length)
        return null;
    const i = Number.isFinite(index) ? Math.trunc(index) : 0;
    return list[(i % list.length + list.length) % list.length];
}

let cached = null;

/** Every idea, {short, long} (read once); empty lists on any error. */
export function loadIdeas() {
    cached ??= ideasFile().load_contents_async(null)
        .then(([bytes]) => validate(JSON.parse(new TextDecoder().decode(bytes))))
        .catch(e => {
            console.warn(`Froonty: break ideas: ${e.message}`);
            cached = null;
            return {short: [], long: []};
        });
    return cached;
}
