// SPDX-License-Identifier: GPL-3.0-or-later
// Note labels. Pure functions, unit-tested; shared by the island and the
// settings window's "All notes" page. Persisted by store.js in a hidden
// file of their own, next to the notes:
//
//   .froonty-labels.json   {"version": 1,
//                           "labels": {"Plan": ["q4", "work"]}}
//
// A file of its own, not .froonty.json (tab order and colours): either
// is rewritten without touching the other. The .md files stay plain
// Markdown.
//
// A label's identity ignores case but not accents ("Work" = "work",
// "café" ≠ "cafe"); the first spelling in the file wins. Entries for notes
// that are gone (trashed, renamed elsewhere) are kept, so a note restored
// from the Trash gets its labels back; they are never shown or counted.

import {compareNames} from './names.js';

export const LABELS_FILE = '.froonty-labels.json';
export const MAX_LABEL_LENGTH = 40; // code points

const VERSION = 1;
// Control characters (Unicode Cc), after whitespace became spaces.
const CONTROL = /\p{Cc}/u;

/** A label as typed → its stored form, or null when it is not usable. */
export function cleanLabel(text) {
    if (typeof text !== 'string')
        return null;
    const label = text.normalize('NFC').trim()
        .replace(/^#+/, '')
        .replace(/\s+/gu, ' ')
        .trim();
    if (!label || [...label].length > MAX_LABEL_LENGTH || CONTROL.test(label))
        return null;
    return label;
}

/** Identity of a label: case-insensitive, accent-sensitive. */
export function labelKey(label) {
    return label.normalize('NFC').toLowerCase();
}

// Name-keyed maps have no prototype: a note may be called "constructor"
// or "__proto__".
function dict(entries = []) {
    const map = Object.create(null);
    for (const [key, value] of entries)
        map[key] = value;
    return map;
}

export function emptyLabels() {
    return {version: VERSION, labels: dict(), extra: dict()};
}

function sorted(labels) {
    const seen = new Set();
    const unique = [];
    for (const label of labels) {
        const key = labelKey(label);
        if (!seen.has(key)) {
            seen.add(key);
            unique.push(label);
        }
    }
    return unique.sort(compareNames);
}

/**
 * Parses the file. A file that cannot be understood is reported, never
 * repaired: Froonty then neither shows nor writes labels.
 *
 * @returns {{ok: true, data: object} | {ok: false, reason: string}}
 */
export function parseLabels(text) {
    // An empty file (e.g. created, then the write was cut off) holds no
    // labels and may be written.
    if (text === '')
        return {ok: true, data: emptyLabels()};
    let json;
    try {
        json = JSON.parse(text);
    } catch {
        return {ok: false, reason: 'invalid JSON'};
    }
    if (json === null || typeof json !== 'object' || Array.isArray(json))
        return {ok: false, reason: 'not an object'};
    if (json.version !== VERSION)
        return {ok: false, reason: `version ${json.version}`};
    const raw = json.labels ?? {};
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
        return {ok: false, reason: 'labels is not an object'};

    const data = emptyLabels();
    for (const [name, list] of Object.entries(raw)) {
        if (!Array.isArray(list))
            continue;
        const labels = sorted(list.map(cleanLabel).filter(Boolean));
        if (labels.length)
            data.labels[name] = labels;
    }
    for (const [key, value] of Object.entries(json)) {
        if (key !== 'version' && key !== 'labels')
            data.extra[key] = value;
    }
    return {ok: true, data};
}

/** File contents; keys Froonty does not know are written back as found. */
export function serializeLabels(data) {
    const json = {...data.extra, version: VERSION, labels: {...data.labels}};
    return `${JSON.stringify(json, null, 2)}\n`;
}

/** Labels of one note (a copy), sorted. */
export function labelsOf(data, name) {
    return [...(Object.hasOwn(data.labels, name) ? data.labels[name] : [])];
}

// The first spelling of a label anywhere in the file.
function spellingOf(data, key) {
    for (const list of Object.values(data.labels)) {
        const found = list.find(l => labelKey(l) === key);
        if (found)
            return found;
    }
    return null;
}

function withList(data, name, list) {
    const labels = dict(Object.entries(data.labels));
    if (list.length)
        labels[name] = list;
    else
        delete labels[name];
    return {...data, labels};
}

/** Turns a label on or off for a note; unchanged data if nothing changes. */
export function withLabel(data, name, label, on) {
    const clean = cleanLabel(label);
    if (!clean)
        return data;
    const key = labelKey(clean);
    const current = labelsOf(data, name);
    const has = current.some(l => labelKey(l) === key);
    if (on === has)
        return data;
    const next = on
        ? sorted([...current, spellingOf(data, key) ?? clean])
        : current.filter(l => labelKey(l) !== key);
    return withList(data, name, next);
}

/** A note renamed by Froonty: its labels move; an old entry at the target goes. */
export function withRename(data, from, to) {
    const moved = labelsOf(data, from);
    const labels = dict(Object.entries(data.labels));
    delete labels[from];
    delete labels[to];
    if (moved.length)
        labels[to] = moved;
    return {...data, labels};
}

export function withoutNote(data, name) {
    return withList(data, name, []);
}

/** Every label used by `names` (notes that exist), with its count, sorted. */
export function allLabels(data, names) {
    const counts = new Map();
    for (const name of names) {
        for (const label of labelsOf(data, name)) {
            const key = labelKey(label);
            const entry = counts.get(key) ?? {label: spellingOf(data, key) ?? label, count: 0};
            entry.count++;
            counts.set(key, entry);
        }
    }
    return [...counts.values()].sort((a, b) => compareNames(a.label, b.label));
}

/**
 * Whether a note's labels pass a label filter. Nothing selected passes
 * everything; 'all' needs every selected label, 'any' at least one.
 */
export function matchesLabels(noteLabels, selected, mode = 'all') {
    if (!selected.length)
        return true;
    const have = new Set(noteLabels.map(labelKey));
    return mode === 'any'
        ? selected.some(l => have.has(labelKey(l)))
        : selected.every(l => have.has(labelKey(l)));
}
