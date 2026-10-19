// SPDX-License-Identifier: GPL-3.0-or-later
// The Break tab's exercises (docs/features/break.md, Exercises):
//
// - the catalog (exercises/catalog.json): every move, in Froonty's words,
//   with its tags and where its picture comes from;
// - the fetched art (third_party/break-art/index.json, from
//   tools/fetch-break-art.py; not in the repository): frames per move;
// - Workrave's exercises (exercises/README.md): pictures and timings, the
//   fallback when the art is not fetched.
//
// Read once, in the background; Gio only.

import Gio from 'gi://Gio';

import {DRAWN_KINDS} from './drawnKinds.js';

Gio._promisify(Gio.File.prototype, 'load_contents_async');

const folder = () => Gio.File.new_for_uri(import.meta.url).get_parent().get_child('exercises');
const artFolder = () => Gio.File.new_for_uri(import.meta.url).get_parent().get_parent().get_parent()
    .get_child('third_party').get_child('break-art');

/** The picture `name` (a PNG next to exercises.json). */
export const imageFile = name => folder().get_child('images').get_child(name);

/** The exercises it can show, or [] for data it does not understand. */
export function validate(data) {
    if (data?.format !== 1 || !Array.isArray(data.exercises))
        return [];
    return data.exercises.filter(e =>
        typeof e.id === 'string' && typeof e.title === 'string' && typeof e.text === 'string' &&
        ['stretch', 'eyes'].includes(e.kind) && Array.isArray(e.frames) && e.frames.length > 0 &&
        e.frames.every(f => typeof f.image === 'string' && /^[a-z0-9-]+\.png$/.test(f.image) &&
            Number.isFinite(f.seconds)));
}

let cached = null;

/** Every exercise, in Workrave's order (read once). */
export function loadExercises() {
    cached ??= folder().get_child('exercises.json').load_contents_async(null)
        .then(([bytes]) => validate(JSON.parse(new TextDecoder().decode(bytes))))
        .catch(e => {
            console.warn(`Froonty: exercises: ${e.message}`);
            cached = null;
            return [];
        });
    return cached;
}

export const stretches = exercises => exercises.filter(e => e.kind === 'stretch');
export const eyeExercises = exercises => exercises.filter(e => e.kind === 'eyes');

// ------------------------------------------------------------ catalog

const KINDS = ['stretch', 'move', 'eyes', 'breath'];
const POSTURES = ['seated', 'standing'];
const SAFE_FILE = /^[a-z0-9-]+(\/[a-z0-9-]+)*\.(png|webp|jpg)$/;

/** The catalog's moves it can show, or [] for data it does not understand. */
export function validateCatalog(data) {
    if (data?.format !== 2 || !Array.isArray(data.moves))
        return [];
    return data.moves.filter(m =>
        typeof m.id === 'string' && typeof m.title === 'string' && typeof m.text === 'string' &&
        KINDS.includes(m.kind) && POSTURES.includes(m.posture) && typeof m.region === 'string' &&
        Number.isFinite(m.seconds) && m.seconds > 0 && m.art && typeof m.art === 'object');
}

/** The fetched art's moves: {id: [{file, ms}]}, only safe relative files. */
export function validateArt(data) {
    if (data?.format !== 1 || !data.moves || typeof data.moves !== 'object')
        return {};
    const out = {};
    for (const [id, art] of Object.entries(data.moves)) {
        const frames = Array.isArray(art?.frames) ? art.frames.filter(f =>
            typeof f?.file === 'string' && SAFE_FILE.test(f.file) && Number.isFinite(f.ms) && f.ms > 0) : [];
        if (frames.length)
            out[id] = frames;
    }
    return out;
}

/**
 * A move's picture: fetched frames, a drawn widget, Workrave's pictures,
 * in that order; null for none.
 *
 * @returns {?{kind: 'frames'|'drawn', source: string, frames?: object[], drawn?: string}}
 */
export function pictureOf(move, {art = {}, workrave = []} = {}) {
    const frames = art[move.art.workoutlabs];
    if (frames) {
        return {kind: 'frames', source: 'workoutlabs',
            frames: frames.map(f => ({file: artFolder().resolve_relative_path(f.file), ms: f.ms, mirror: false}))};
    }
    if (DRAWN_KINDS.includes(move.art.drawn))
        return {kind: 'drawn', source: 'froonty', drawn: move.art.drawn};
    const old = workrave.find(e => e.id === move.art.workrave);
    if (old) {
        return {kind: 'frames', source: 'workrave',
            frames: old.frames.map(f => ({file: imageFile(f.image), ms: f.seconds * 1000, mirror: Boolean(f.mirror)}))};
    }
    return null;
}

async function readJson(file) {
    const [bytes] = await file.load_contents_async(null);
    return JSON.parse(new TextDecoder().decode(bytes));
}

let catalog = null;

/**
 * Every move with its picture (read once): {moves, art: whether the
 * fetched art was found}.
 */
export function loadCatalog() {
    catalog ??= (async () => {
        const [moves, art, workrave] = await Promise.all([
            readJson(folder().get_child('catalog.json')).then(validateCatalog),
            readJson(artFolder().get_child('index.json')).then(validateArt).catch(() => ({})),
            loadExercises(),
        ]);
        return {
            moves: moves.map(m => ({...m, picture: pictureOf(m, {art, workrave})})),
            art: Object.keys(art).length > 0,
        };
    })().catch(e => {
        console.warn(`Froonty: exercise catalog: ${e.message}`);
        catalog = null;
        return {moves: [], art: false};
    });
    return catalog;
}
