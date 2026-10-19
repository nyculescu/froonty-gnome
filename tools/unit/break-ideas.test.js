// SPDX-License-Identifier: GPL-3.0-or-later
// The break ideas as the Break tab ships them (features/break/exercises/
// ideas.json, from tools/import-break-ideas.py): Stretchly's and Safe Eyes'
// texts that are reminders only, each credited, with the licence file.

import GLib from 'gi://GLib';

import {EXTENSION_DIR, done, eq, ok, test} from './test.js';
import {loadIdeas, pickIdea, validate} from '../../froonty@catalin/features/break/ideas.js';

const FOLDER = GLib.build_filenamev([EXTENSION_DIR, 'features', 'break', 'exercises']);
const read = name => new TextDecoder().decode(GLib.file_get_contents(GLib.build_filenamev([FOLDER, name]))[1]);
const data = JSON.parse(read('ideas.json'));
const all = [...data.short, ...data.long];
const count = (list, id) => list.filter(idea => idea.source === id).length;

const STRETCHLY_COMMIT = '3cb3af2d480c352ed903007426fd86e1226bd6fc';
const SAFEEYES_COMMIT = '4637d80ae59ab1fc0d980431ebd95fe63a60d5df';

test('the JSON validates: every idea kept, 43 short and 10 long', () => {
    eq(data.format, 1);
    eq(validate(data), {short: data.short, long: data.long});
    eq([count(data.short, 'stretchly'), count(data.short, 'safeeyes')], [35, 8]);
    eq([count(data.long, 'stretchly'), count(data.long, 'safeeyes')], [6, 4]);
});

test('the sources are recorded: projects, pinned commits, files, licences', () => {
    eq(data.sources, [
        {
            id: 'stretchly',
            project: 'Stretchly',
            url: 'https://github.com/hovancik/stretchly',
            commit: STRETCHLY_COMMIT,
            files: ['app/utils/defaultMicrobreakIdeas.js', 'app/utils/defaultBreakIdeas.js'],
            license: 'BSD-2-Clause',
            copyright: 'Copyright (c) 2016-, Jan Hovancik',
        },
        {
            id: 'safeeyes',
            project: 'Safe Eyes',
            url: 'https://github.com/slgobinath/safeeyes',
            commit: SAFEEYES_COMMIT,
            files: ['safeeyes/config/safeeyes.json'],
            license: 'GPL-3.0-or-later',
            copyright: 'Copyright (C) Gobinath Loganathan and the Safe Eyes contributors',
        },
    ]);
});

test('every idea names a recorded source; only Stretchly\'s long ideas have titles', () => {
    const ids = data.sources.map(s => s.id);
    for (const idea of all)
        ok(ids.includes(idea.source), idea.text);
    for (const idea of data.short)
        eq(Object.keys(idea), ['text', 'source'], idea.text);
    for (const idea of data.long) {
        const keys = idea.source === 'stretchly' ? ['title', 'text', 'source'] : ['text', 'source'];
        eq(Object.keys(idea), keys, idea.text);
    }
});

test('no duplicates; one tidy line each; short ideas at most 160 characters', () => {
    const plain = text => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    eq(new Set(all.map(idea => plain(idea.text))).size, all.length);
    const titles = data.long.filter(idea => idea.title).map(idea => plain(idea.title));
    eq(new Set(titles).size, titles.length);
    for (const idea of all) {
        ok(!/[\r\n\t]| {2}/.test(idea.text) && idea.text === idea.text.trim(), idea.text);
        ok(/[.?!]$/.test(idea.text), `no closing stop: ${idea.text}`);
    }
    for (const idea of data.short)
        ok(idea.text.length <= 160, `${idea.text.length} characters: ${idea.text}`);
});

test('the licence file: Stretchly\'s BSD-2-Clause notice in full, Safe Eyes\' GPL', () => {
    const licence = read('IDEAS-LICENSE.md');
    for (const line of [
        'Copyright (c) 2016-, Jan Hovancik',
        'All rights reserved.',
        '* Redistributions of source code must retain the above copyright notice, this',
        '* Redistributions in binary form must reproduce the above copyright notice,',
        'THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"',
        'OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.',
        'GPL-3.0-or-later',
        STRETCHLY_COMMIT,
        SAFEEYES_COMMIT,
    ])
        ok(licence.includes(line), line);
});

test('the DROP rules hold: no claims, advice, missing equipment, substances, third-party text', () => {
    // Word beginnings each rule's texts upstream use (or would).
    const starts = list => new RegExp(`\\b(${list.join('|')})`, 'i');
    const RULES = {
        claim: starts(['stud(y|ies)', 'research', 'evidence', 'scien', 'productiv', 'risk', 'health',
            'benefit', 'improv', 'boost', 'reduc', 'prevent', 'calorie', 'heart', 'cardio', 'metabol',
            'circulat', 'anxiety', 'depress', 'stress', 'therap', 'relief', 'cure', 'injur', 'longevity']),
        advice: starts(['diet', 'fruit', 'eat\\b', 'vitamin', 'supplement', 'medic', 'doctor', 'natural light',
            'pulse', 'beats per minute', 'for every \\w+ minutes']),
        notAtHand: starts(['gym', 'stability ball', 'standing (work )?desk', 'rubber ball', 'socks', 'treadmill',
            'apps?\\b', 'workout', 'public transport', 'cycling', 'outside']),
        substance: starts(['alcohol', 'beer', 'wine', 'smok', 'cigarette', 'vap(e|ing)', 'drug', 'caffeine',
            'nicotine', 'cannabis']),
    };
    for (const idea of all) {
        const words = `${idea.title ?? ''} ${idea.text}`;
        for (const [rule, pattern] of Object.entries(RULES))
            ok(!pattern.test(words), `${rule}: ${words}`);
    }
    // Lines the converter found in pages Stretchly credits (THIRD_PARTY there).
    for (const fragment of [
        'Do one thing at a time', 'If you need help, ask for it', // Ron Padgett's poem
        'turn head to side', 'tilt head to side', // Stanford EH&S
        'to the tip of your thumb', 'telling someone to stop', // WebMD
        'with your eyes closed', 'brace elbows on the desk', 'Hold one finger close to the eye', // OnHealth
        'farthest bathroom', 'walk to their desks', // Len Kravitz
    ])
        ok(!all.some(idea => idea.text.toLowerCase().includes(fragment.toLowerCase())), fragment);
});

test('validate leaves out what it does not understand', () => {
    const empty = {short: [], long: []};
    eq(validate(null), empty);
    eq(validate({...data, format: 2}), empty);
    eq(validate({...data, sources: undefined}), empty);
    eq(validate({
        format: 1,
        sources: data.sources,
        short: [{text: 'Elsewhere.', source: 'elsewhere'}, {text: 'Kept.', source: 'stretchly'},
            {source: 'stretchly'}, {text: 'Two\nlines.', source: 'safeeyes'}],
        long: [{title: 3, text: 'Bad title.', source: 'stretchly'}, {text: 'No title.', source: 'safeeyes'}],
    }), {short: [{text: 'Kept.', source: 'stretchly'}], long: [{text: 'No title.', source: 'safeeyes'}]});
});

test('pickIdea counts round the list; null for an empty one', () => {
    const list = ['a', 'b', 'c'];
    eq([0, 1, 2, 3, 4, 7, -1, -4, 2.7, NaN].map(i => pickIdea(list, i)),
        ['a', 'b', 'c', 'a', 'b', 'b', 'c', 'c', 'c', 'a']);
    eq(pickIdea([], 0), null);
    eq(pickIdea(null, 3), null);
});

test('loaded once, in the background', async () => {
    const first = loadIdeas();
    ok(first === loadIdeas(), 'the same promise');
    const ideas = await first;
    eq(ideas, validate(data));
    eq(pickIdea(ideas.short, ideas.short.length), ideas.short[0]);
    eq(pickIdea(ideas.long, -1), ideas.long.at(-1));
});

await done();
