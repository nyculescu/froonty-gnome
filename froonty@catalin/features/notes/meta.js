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
// are dropped whenever it is written.

import {COLOR_IDS, DEFAULT_COLOR} from './colors.js';
import {compareNames} from './names.js';

export const META_FILE = '.froonty.json';

export function emptyMeta() {
    return {version: 1, order: [], colors: {}};
}

/** Parses the file; anything unexpected is ignored rather than fatal. */
export function parseMeta(text) {
    let data;
    try {
        data = JSON.parse(text);
    } catch {
        return emptyMeta();
    }
    const meta = emptyMeta();
    if (Array.isArray(data?.order))
        meta.order = [...new Set(data.order.filter(n => typeof n === 'string'))];
    for (const [name, color] of Object.entries(data?.colors ?? {})) {
        if (COLOR_IDS.includes(color) && color !== DEFAULT_COLOR)
            meta.colors[name] = color;
    }
    return meta;
}

export function serializeMeta(meta) {
    return `${JSON.stringify(meta, null, 2)}\n`;
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
    return meta.colors[name] ?? DEFAULT_COLOR;
}

/** Metadata for writing: current display order, colours of existing notes. */
export function snapshot(meta, names) {
    const colors = {};
    for (const name of names) {
        if (meta.colors[name])
            colors[name] = meta.colors[name];
    }
    return {version: 1, order: [...names], colors};
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
