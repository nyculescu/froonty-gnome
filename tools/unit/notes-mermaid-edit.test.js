// SPDX-License-Identifier: GPL-3.0-or-later
// Notes: Edit Mermaid code (mermaidEdit.js): the code written back between
// its fence lines, and the live picture, drawn once typing pauses, only
// the latest code's shown.

import {markdownBlocks} from '../../froonty@catalin/features/notes/blocks.js';
import {DiagramDraft, mermaidLayout, setMermaidLayout, withFenceSource}
    from '../../froonty@catalin/features/notes/mermaidEdit.js';
import {done, eq, ok, sleep, test} from './test.js';

test('mermaid edit: the code goes between the fence lines, their info string kept', () => {
    const note = 'Intro\n\n```mermaid\nflowchart TD\nA-->B\n```\n\nend';
    const [block] = markdownBlocks(note);
    const fence = note.slice(block.start, block.end);
    eq(withFenceSource(fence, block.source), fence, 'its own code: the same fence');
    eq(withFenceSource(fence, 'flowchart TD\nA-->B\nB-->C'), '```mermaid\nflowchart TD\nA-->B\nB-->C\n```');
    eq(withFenceSource('~~~~ Mermaid \ngraph LR\n~~~~', 'graph TD'), '~~~~ Mermaid \ngraph TD\n~~~~',
        'tildes, a longer fence, spacing: as written');
    eq(withFenceSource('```\ngraph TD\n```', 'graph LR'), '```\ngraph LR\n```', 'an unlabeled fence stays unlabeled');
    eq(withFenceSource('```mermaid\ngraph TD\n```', ''), '```mermaid\n```', 'no code: the fence lines alone');
    const edited = note.slice(0, block.start) + withFenceSource(fence, 'graph LR\nX-->Y') + note.slice(block.end);
    eq(markdownBlocks(edited)[0].source, 'graph LR\nX-->Y', 'read back as the new code');
});

test('mermaid edit: the layout is kept for the session, Split first', () => {
    eq(mermaidLayout(), 'split');
    setMermaidLayout('preview');
    eq(mermaidLayout(), 'preview');
    setMermaidLayout('split');
});

// A draw() whose drawings finish when the test says.
function drawings() {
    const asked = [];
    const draw = source => new Promise((resolve, reject) => asked.push({source, resolve, reject}));
    return {asked, draw};
}

test('mermaid edit: drawn after a pause in typing, at once when asked', async () => {
    const {asked, draw} = drawings();
    const shown = [];
    const draft = new DiagramDraft(draw, result => shown.push(result), 60);
    draft.set('a', true);
    eq(asked.map(a => a.source), ['a'], 'at once');
    asked[0].resolve({png: 1, warnings: []});
    await sleep(0);
    eq(shown, [{picture: {png: 1, warnings: []}}]);
    draft.set('ab');
    await sleep(20);
    draft.set('abc');
    await sleep(20);
    eq(asked.length, 1, 'not while typing');
    await sleep(80);
    eq(asked.map(a => a.source), ['a', 'abc'], 'once it paused: the latest code only');
    asked[1].reject(new Error('Parse error on line 1'));
    await sleep(0);
    eq(shown.at(-1), {error: 'Parse error on line 1'}, 'a failure says why');
    draft.destroy();
});

test('mermaid edit: one drawing at a time; an older code\'s picture never shows', async () => {
    const {asked, draw} = drawings();
    const shown = [];
    const draft = new DiagramDraft(draw, result => shown.push(result.picture), 10);
    draft.set('a', true);
    draft.set('ab');
    await sleep(40);
    eq(asked.length, 1, 'the next waits for the drawing under way');
    asked[0].resolve('picture of a');
    await sleep(0);
    eq(shown, [], 'older code: dropped');
    eq(asked.map(a => a.source), ['a', 'ab'], 'then the latest is drawn');
    asked[1].resolve('picture of ab');
    await sleep(0);
    eq(shown, ['picture of ab']);

    // Gone: nothing drawn or shown any more.
    draft.set('abc');
    draft.destroy();
    await sleep(40);
    eq(asked.length, 2, 'no drawing after destroy()');
    const late = new DiagramDraft(draw, result => shown.push(result.picture), 10);
    late.set('x', true);
    late.destroy();
    asked[2].resolve('picture of x');
    await sleep(0);
    ok(!shown.includes('picture of x'), 'a drawing finished after destroy() is not shown');
});

await done();
