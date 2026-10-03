// SPDX-License-Identifier: GPL-3.0-or-later
// Workrave's exercises (exercises/README.md): 7 stretches and 3 eye
// exercises, with their pictures. Read once, in the background; Gio only.

import Gio from 'gi://Gio';

Gio._promisify(Gio.File.prototype, 'load_contents_async');

const folder = () => Gio.File.new_for_uri(import.meta.url).get_parent().get_child('exercises');

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
