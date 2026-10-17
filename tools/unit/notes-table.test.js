// SPDX-License-Identifier: GPL-3.0-or-later
// Notes' pipe tables as a model (table.js): parsing, writing back, edits.

import {addColumn, addRow, parseTable, removeColumn, removeRow, serializeTable, setAlign, setCell}
    from '../../froonty@catalin/features/notes/table.js';
import {done, eq, ok, test} from './test.js';

const throws = (fn, pattern, message) => {
    try {
        fn();
    } catch (e) {
        ok(pattern.test(e.message), `${message}: ${e.message}`);
        return;
    }
    throw new Error(`${message}: did not throw`);
};

test('table: header, alignment and rows; outer pipes optional; escaped pipes kept', () => {
    eq(parseTable('| a | b | c | d |\n|---|:--|:-:|--:|\n| 1 | x \\| y | `z` |'), {
        header: ['a', 'b', 'c', 'd'],
        align: [null, 'left', 'center', 'right'],
        rows: [['1', 'x \\| y', '`z`', '']],
    });
    eq(parseTable('a | b\n--- | ---\n1 | 2\n3 | 4 | 5').rows, [['1', '2'], ['3', '4', '5']],
        'no outer pipes; a long row keeps its extra cell');
    eq(parseTable('| a |\n| --- |\n| ends with \\| |').rows, [['ends with \\|']]);
});

test('table: not a table says why', () => {
    throws(() => parseTable('| a |'), /header row and a separator/, 'one row');
    throws(() => parseTable('| a | b |\n| x | y |'), /separator/, 'no separator');
    throws(() => parseTable('| a | b | c |\n| --- | --- |'), /2 cells; the header has 3/, 'count');
});

test('table: written back with aligned columns, by code point', () => {
    const model = parseTable('|Name|Qty|\n|:-:|--:|\n|é😀|5|\n|longer name|12|');
    eq(serializeTable(model), [
        '|    Name     | Qty |',
        '| :---------: | --: |',
        '|     é😀      |   5 |',
        '| longer name |  12 |',
    ].join('\n'));
    eq(serializeTable({header: ['a'], align: [null], rows: []}), '| a   |\n| --- |');
});

test('table: round trip is stable; pipes escaped, line breaks spaces', () => {
    const sources = [
        '| a | b |\n|---|---|\n| 1 | 2 |',
        'x|y\n:--|--:\n1|2|3\n4',
        '| p \\| q | `c` |\n| --- | :-: |\n|  | **b** |',
    ];
    for (const source of sources) {
        const once = serializeTable(parseTable(source));
        eq(serializeTable(parseTable(once)), once, source);
    }
    const typed = setCell(parseTable('| a |\n| --- |\n| x |'), 0, 0, 'one | two\nthree');
    eq(serializeTable(typed).split('\n')[2], '| one \\| two three |');
    eq(parseTable(serializeTable(typed)).rows, [['one \\| two three']]);
});

test('table: edits return a new model', () => {
    const model = parseTable('| a | b |\n| --- | --: |\n| 1 | 2 |');
    const wider = addColumn(model, 1, 'new');
    eq(wider, {header: ['a', 'new', 'b'], align: [null, null, 'right'], rows: [['1', '', '2']]});
    eq(model.header, ['a', 'b'], 'unchanged');
    eq(addRow(model).rows, [['1', '2'], ['', '']]);
    eq(addRow(model, 0).rows, [['', ''], ['1', '2']]);
    eq(removeRow(model, 0).rows, []);
    eq(removeColumn(model, 0), {header: ['b'], align: ['right'], rows: [['2']]});
    const single = removeColumn(model, 0);
    eq(removeColumn(single, 0), single, 'the last column stays');
    eq(setCell(model, -1, 1, 'B').header, ['a', 'B']);
    eq(setAlign(model, 0, 'center').align, ['center', 'right']);
    eq(serializeTable(addColumn(model)), '| a   |   b |     |\n| --- | --: | --- |\n| 1   |   2 |     |');
});

await done();
