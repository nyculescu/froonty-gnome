// SPDX-License-Identifier: GPL-3.0-or-later
// Per-folder note metadata: tab order and colours. Pure functions,
// unit-tested; persisted by store.js as a hidden file next to the notes.
//
//   .froonty.json   {"version": 1, "order": ["28.09.26 16.03", "Plan"],
//                    "colors": {"Plan": "green"}}
//
// The .md files stay plain Markdown (no front matter), so other editors
// see only the text. The files on disk decide which notes exist; the
// metadata only orders and colours them, and entries for vanished notes
// are dropped whenever it is written. Top-level keys this version does
// not know are kept (`extra`) and written back as found. A file that
// cannot be read is never written (parseMeta, store.js readMeta).

import {COLOR_IDS, DEFAULT_COLOR} from './colors.js';
import {compareNames} from './names.js';

export const META_FILE = '.froonty.json';

export function emptyMeta() {
    // `extra` has no prototype: a key may be "__proto__".
    return {version: 1, order: [], colors: {}, extra: Object.create(null)};
}

/**
 * Parses the file. A file that cannot be understood (not JSON, not an
 * object, another version) is reported, never repaired: Froonty then
 * neither trusts nor writes it, so a typo made by hand or a half-synced
 * file does not cost the order and the colours. Inside a readable file,
 * odd entries are ignored one by one. An empty file holds nothing and may
 * be written.
 *
 * @returns {{ok: true, meta: object} | {ok: false, reason: string}}
 */
export function parseMeta(text) {
    if (text === '')
        return {ok: true, meta: emptyMeta()};
    let data;
    try {
        data = JSON.parse(text);
    } catch {
        return {ok: false, reason: 'not valid JSON'};
    }
    if (!data || typeof data !== 'object' || Array.isArray(data))
        return {ok: false, reason: 'not a JSON object'};
    if (data.version !== undefined && data.version !== 1)
        return {ok: false, reason: `version ${JSON.stringify(data.version)}`};
    const meta = emptyMeta();
    if (Array.isArray(data.order))
        meta.order = [...new Set(data.order.filter(n => typeof n === 'string'))];
    const colors = data.colors && typeof data.colors === 'object' ? data.colors : {};
    for (const [name, color] of Object.entries(colors)) {
        if (COLOR_IDS.includes(color) && color !== DEFAULT_COLOR)
            meta.colors[name] = color;
    }
    for (const [key, value] of Object.entries(data)) {
        if (!['version', 'order', 'colors'].includes(key))
            meta.extra[key] = value;
    }
    return {ok: true, meta};
}

export function serializeMeta(meta) {
    const {version, order, colors} = meta;
    return `${JSON.stringify({...meta.extra, version, order, colors}, null, 2)}\n`;
}

/**
 * Display order: notes known to the metadata in its (creation) order, then
 * notes it does not know yet (created by another program), by name.
 */
export function orderedNames(diskNames, meta) {
    const onDisk = new Set(diskNames);
    const known = meta.order.filter(n => onDisk.has(n));
    const knownSet = new Set(known);
    const unknown = diskNames.filter(n => !knownSet.has(n)).sort(compareNames);
    return [...known, ...unknown];
}

export function colorOf(meta, name) {
    return Object.hasOwn(meta.colors, name) ? meta.colors[name] : DEFAULT_COLOR;
}

/** Metadata for writing: current display order, colours of existing notes. */
export function snapshot(meta, names) {
    const colors = {};
    for (const name of names) {
        if (Object.hasOwn(meta.colors, name))
            colors[name] = meta.colors[name];
    }
    return {version: 1, order: [...names], colors, extra: Object.assign(Object.create(null), meta.extra)};
}

export function withNote(meta, name) {
    return {...meta, order: [...meta.order.filter(n => n !== name), name]};
}

export function withoutNote(meta, name) {
    const {[name]: _removed, ...colors} = meta.colors;
    return {...meta, order: meta.order.filter(n => n !== name), colors};
}

export function withRename(meta, from, to) {
    const {[from]: color, ...colors} = meta.colors;
    if (color)
        colors[to] = color;
    return {...meta, order: meta.order.map(n => n === from ? to : n), colors};
}

export function withColor(meta, name, color) {
    const {[name]: _old, ...colors} = meta.colors;
    if (color !== DEFAULT_COLOR)
        colors[name] = color;
    return {...meta, colors};
}
