// SPDX-License-Identifier: GPL-3.0-or-later
// Workrave's exercises as the Break tab ships them
// (features/break/exercises/): the 10 active ones, their 18 pictures and
// nothing else, with the attribution README.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {done, eq, ok, test} from './test.js';
import {
    eyeExercises, imageFile, loadExercises, stretches, validate,
} from '../../froonty@catalin/features/break/exercises.js';

const FOLDER = GLib.build_filenamev([GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]),
    '..', '..', 'froonty@catalin', 'features', 'break', 'exercises']);
const read = name => new TextDecoder().decode(GLib.file_get_contents(GLib.build_filenamev([FOLDER, name]))[1]);
const data = JSON.parse(read('exercises.json'));

// Workrave's exercises.xml.in (commit f393616): title, kind, total, frames.
const EXPECTED = [
    ['Shoulder-arm stretch', 'stretch', 40, 'shoulder-arm-stretch.png 10, shoulder-arm-stretch.png 10 m'],
    ['Finger stretch', 'stretch', 40, 'finger-stretch-1.png 10, finger-stretch-2.png 10'],
    ['Neck tilt stretch', 'stretch', 30, 'neck-tilt-stretch-1.png 5, neck-tilt-stretch-2.png 5'],
    ['Backward shoulder stretch', 'stretch', 30, 'backward-shoulder-stretch.png 10'],
    ['Move the eyes', 'eyes', 32,
        'monitor-border-1.png 4, monitor-border-2.png 4, monitor-border-3.png 4, monitor-border-4.png 4'],
    ['Train focusing the eyes', 'eyes', 25, 'depth-focus-1.png 5, depth-focus-2.png 5'],
    ['Look into the darkness', 'eyes', 20, 'eye-darkness.png 20'],
    ['Move the shoulders', 'stretch', 30, 'rotate-arm.png 15, rotate-arm.png 15 m'],
    ['Move the shoulders up and down', 'stretch', 30, 'chair-pushup-1.png 5, chair-pushup-2.png 10'],
    ['Turn your head', 'stretch', 24, 'turn-head-1.png 3, turn-head-2.png 3'],
];

test('the 10 active exercises, with Workrave\'s frames, times and totals', () => {
    eq(data.exercises.map(e => [e.title, e.kind, e.seconds,
        e.frames.map(f => `${f.image} ${f.seconds}${f.mirror ? ' m' : ''}`).join(', ')]), EXPECTED);
    eq(validate(data).length, 10);
});

test('the source is recorded: Workrave, the commit, GPL-3.0-or-later', () => {
    eq(data.source, {
        project: 'Workrave',
        url: 'https://github.com/rcaelers/workrave',
        commit: 'f3936169a86c697f08415adc3baf965425a29dff',
        path: 'ui/data/exercises/exercises.xml.in',
        license: 'GPL-3.0-or-later',
    });
});

test('exactly the 18 pictures they use: no .xcf, nothing unused, at most 250 KB', () => {
    const used = [...new Set(data.exercises.flatMap(e => e.frames.map(f => f.image)))].sort();
    eq(used.length, 18);
    for (const name of used)
        ok(imageFile(name).query_exists(null), name);
    const dir = GLib.Dir.open(GLib.build_filenamev([FOLDER, 'images']), 0);
    const present = [];
    let name;
    while ((name = dir.read_name()) !== null)
        present.push(name);
    dir.close();
    eq(present.sort(), used);
    const bytes = used.reduce((sum, n) => sum + imageFile(n).query_info('standard::size',
        Gio.FileQueryInfoFlags.NONE, null).get_size(), 0);
    ok(bytes <= 250 * 1024, `${bytes} bytes`);
    const top = GLib.Dir.open(FOLDER, 0);
    const files = [];
    while ((name = top.read_name()) !== null)
        files.push(name);
    top.close();
    eq(files.sort(), ['README.md', 'exercises.json', 'images']);
});

test('the README credits Workrave: licence and commit', () => {
    const readme = read('README.md');
    ok(readme.includes('GPL-3.0-or-later'));
    ok(readme.includes('f3936169a86c697f08415adc3baf965425a29dff'));
    ok(readme.includes('https://github.com/rcaelers/workrave'));
});

test('loaded in the background; 7 stretches rotate, 3 eye exercises', async () => {
    const list = await loadExercises();
    eq(stretches(list).length, 7);
    eq(eyeExercises(list).map(e => e.id), ['move-the-eyes', 'train-focusing-the-eyes', 'look-into-the-darkness']);
    const order = Array.from({length: 8}, (_, i) => stretches(list)[i % 7].id);
    eq(order[7], order[0]);
    eq(validate({format: 2, exercises: data.exercises}), []);
    eq(validate({format: 1, exercises: [{...data.exercises[0], frames: [{image: '../x.png', seconds: 1}]}]}), []);
});

await done();
