// SPDX-License-Identifier: GPL-3.0-or-later
// Which moves the Break tab shows (features/break/routines.js) and the
// catalog they come from (features/break/exercises/catalog.json,
// exercises.js). Pure, and the committed files.

import GLib from 'gi://GLib';

import {EXTENSION_DIR, done, eq, ok, test} from './test.js';
import {
    pictureOf, validateArt, validateCatalog,
} from '../../froonty@catalin/features/break/exercises.js';
import {DRAWN_KINDS} from '../../froonty@catalin/features/break/drawnKinds.js';
import {nextMove, orderMoves, routine, routineSeconds} from '../../froonty@catalin/features/break/routines.js';

const read = path => JSON.parse(new TextDecoder().decode(GLib.file_get_contents(path)[1]));
const catalog = read(GLib.build_filenamev([EXTENSION_DIR, 'features', 'break', 'exercises', 'catalog.json']));
const workrave = read(GLib.build_filenamev([EXTENSION_DIR, 'features', 'break', 'exercises', 'exercises.json']));
const links = read(GLib.build_filenamev([EXTENSION_DIR, '..', 'tools', 'break-art', 'workoutlabs.json']));
const moves = validateCatalog(catalog);

test('every move of the catalog validates, once, with a text and a picture source', () => {
    eq(moves.length, catalog.moves.length);
    eq(new Set(moves.map(m => m.id)).size, moves.length, 'ids are unique');
    for (const m of moves) {
        ok(m.text.length > 20 && m.text.length < 260, `${m.id}: text length`);
        ok(m.art.workoutlabs || m.art.workrave || m.art.drawn, `${m.id}: a picture source`);
    }
});

test('every picture source exists: a link, a Workrave exercise, a drawn kind', () => {
    const workraveIds = workrave.exercises.map(e => e.id);
    for (const m of moves) {
        if (m.art.workoutlabs && m.art.workoutlabs !== 'finger-stretch')
            ok(m.art.workoutlabs in links.moves, `${m.id}: ${m.art.workoutlabs} has a link`);
        if (m.art.workrave)
            ok(workraveIds.includes(m.art.workrave), `${m.id}: ${m.art.workrave} is Workrave's`);
        if (m.art.drawn)
            ok(DRAWN_KINDS.includes(m.art.drawn), `${m.id}: ${m.art.drawn} is drawn`);
    }
    for (const link of Object.values(links.moves))
        ok(/^https:\/\/workoutlabs\.com\//.test(link.url) && ['gif', 'svg'].includes(link.kind), link.url);
});

test('pictures: fetched frames first, then drawn, then Workrave\'s, else none', () => {
    const neck = moves.find(m => m.id === 'neck-side-tilt');
    const art = {'neck-side-tilt': [{file: 'neck-side-tilt/0.png', ms: 1120}]};
    eq(pictureOf(neck, {art, workrave: workrave.exercises}).source, 'workoutlabs');
    eq(pictureOf(neck, {art: {}, workrave: workrave.exercises}).source, 'workrave');
    eq(pictureOf(moves.find(m => m.id === 'eye-circle'), {art: {}, workrave: workrave.exercises}).kind, 'drawn');
    eq(pictureOf(moves.find(m => m.id === 'chin-tuck'), {art: {}, workrave: []}), null);
});

test('fetched art: only safe relative files with a time', () => {
    eq(validateArt({format: 1, moves: {a: {frames: [{file: 'a/0.png', ms: 100}, {file: '../x.png', ms: 1},
        {file: '/etc/passwd.png', ms: 1}, {file: 'a/1.png', ms: 0}]}}}), {a: [{file: 'a/0.png', ms: 100}]});
    eq(validateArt({format: 2, moves: {}}), {});
});

test('in a call only discreet moves; standing moves first when standing', () => {
    ok(orderMoves(moves, {discreet: true}).every(m => m.discreet));
    eq(orderMoves(moves, {posture: 'standing'})[0].posture, 'standing');
    eq(orderMoves(moves, {posture: 'sitting'})[0].posture, 'seated');
    ok(orderMoves(moves).every(m => ['stretch', 'move'].includes(m.kind)), 'body moves only by default');
});

test('recent moves come last, and the seed turns the order', () => {
    const first = nextMove(moves, {seed: 0});
    eq(orderMoves(moves, {recent: [first.id]}).at(-1).id, first.id);
    ok(nextMove(moves, {seed: 1}).id !== first.id);
});

test('a movement break routine gets you up first, fits its time and spreads the body', () => {
    const steps = routine(moves, {kind: 'movement', seconds: 300});
    ok(steps.length >= 3 && steps.length <= 8, `${steps.length} moves`);
    eq(steps[0].posture, 'standing', 'gets up first');
    ok(routineSeconds(steps) <= 300 + 120, `${routineSeconds(steps)} s`);
    const regions = steps.map(m => m.region);
    ok(new Set(regions).size >= Math.min(steps.length, 4), regions.join());
});

test('in a call a routine stays seated and quiet; a long rest walks, drinks and breathes', () => {
    ok(routine(moves, {kind: 'movement', seconds: 300, discreet: true}).every(m => m.discreet));
    const rest = routine(moves, {kind: 'long-rest', seconds: 900, breathing: true});
    eq([rest[0].id, rest[1].id, rest.at(-1).id], ['walk', 'water', 'breath-box']);
    eq(routine(moves, {kind: 'long-rest', seconds: 900, breathing: true, breathingPattern: 'slow'}).at(-1).id,
        'breath-slow');
});

await done();
