// SPDX-License-Identifier: GPL-3.0-or-later
// Pipe tables as a model, for editing a table in place and for the
// renderer (renderer/tableHtml.js). Pure: no GI.
//
//   parseTable(source) → {header, align, rows}
//       source: a table as blocks.js finds it (header row, separator row,
//       body rows; outer pipes optional). Cells are trimmed Markdown, an
//       escaped pipe (\|) kept as written. Short rows are padded with ''
//       to the header's width; longer rows keep their extra cells (they are
//       not drawn, but an edit does not lose them). align[i] is 'left',
//       'center', 'right' or null (no colon). Throws an Error with a short
//       human reason when the source is not a pipe table.
//   serializeTable(model) → Markdown, columns padded to one width (code
//       points), pipes in cells escaped, line breaks made spaces.
//       serializeTable(parseTable(serializeTable(m))) === serializeTable(m).
//   addRow, addColumn, removeRow, removeColumn, setCell, setAlign:
//       return a new model; the one given is not changed.

const RULE_CELL = /^:?-+:?$/;

// The cells of one row: split at pipes not escaped by a backslash.
function splitRow(line) {
    let row = line.trim();
    if (row.startsWith('|'))
        row = row.slice(1);
    if (row.endsWith('|') && !row.endsWith('\\|'))
        row = row.slice(0, -1);
    const cells = [];
    let cell = '';
    for (let i = 0; i < row.length; i++) {
        if (row[i] === '\\' && row[i + 1] === '|') {
            cell += '\\|';
            i++;
        } else if (row[i] === '|') {
            cells.push(cell.trim());
            cell = '';
        } else {
            cell += row[i];
        }
    }
    cells.push(cell.trim());
    return cells;
}

const alignOf = rule => rule.startsWith(':') && rule.endsWith(':') ? 'center'
    : rule.endsWith(':') ? 'right' : rule.startsWith(':') ? 'left' : null;

export function parseTable(source) {
    const lines = String(source).split('\n').filter(line => line.trim());
    if (lines.length < 2)
        throw new Error('A table needs a header row and a separator row');
    const header = splitRow(lines[0]);
    const rules = splitRow(lines[1]);
    if (!rules.every(rule => RULE_CELL.test(rule)))
        throw new Error('The second row of a table must be its separator, like | --- | --- |');
    if (rules.length !== header.length)
        throw new Error(`The separator row has ${rules.length} cells; the header has ${header.length}`);
    const rows = lines.slice(2).map(line => {
        const cells = splitRow(line);
        while (cells.length < header.length)
            cells.push('');
        return cells;
    });
    return {header, align: rules.map(alignOf), rows};
}

const length = text => [...text].length;

// A cell as one line of Markdown: unescaped pipes escaped.
const cellText = text => String(text ?? '').replace(/\r?\n/g, ' ').trim()
    .replace(/\\?\|/g, pipe => pipe === '|' ? '\\|' : pipe);

function pad(text, width, align) {
    const room = width - length(text);
    if (align === 'right')
        return ' '.repeat(room) + text;
    if (align === 'center') {
        const left = Math.floor(room / 2);
        return ' '.repeat(left) + text + ' '.repeat(room - left);
    }
    return text + ' '.repeat(room);
}

function rule(width, align) {
    if (align === 'center')
        return `:${'-'.repeat(width - 2)}:`;
    if (align === 'right')
        return `${'-'.repeat(width - 1)}:`;
    if (align === 'left')
        return `:${'-'.repeat(width - 1)}`;
    return '-'.repeat(width);
}

export function serializeTable({header, align = [], rows = []}) {
    const head = header.map(cellText);
    const body = rows.map(row => row.map(cellText));
    const columns = Math.max(head.length, ...body.map(row => row.length));
    const widths = [];
    for (let i = 0; i < columns; i++) {
        // At least 3, the shortest separator ("---", ":-:").
        widths.push(Math.max(3, ...[head, ...body].map(row => length(row[i] ?? ''))));
    }
    const line = cells => `| ${cells.join(' | ')} |`;
    return [
        line(head.map((cell, i) => pad(cell, widths[i], align[i]))),
        line(head.map((_, i) => rule(widths[i], align[i]))),
        ...body.map(row => line(row.map((cell, i) => pad(cell, widths[i], align[i])))),
    ].join('\n');
}

const insert = (list, index, item) => [...list.slice(0, index), item, ...list.slice(index)];
const remove = (list, index) => list.filter((_, i) => i !== index);

/** A row of empty cells at `index` (default: the end). */
export function addRow(model, index = model.rows.length) {
    return {...model, rows: insert(model.rows, index, model.header.map(() => ''))};
}

/** An empty column at `index` (default: the end), titled `title`. */
export function addColumn(model, index = model.header.length, title = '') {
    return {
        header: insert(model.header, index, title),
        align: insert(model.align, index, null),
        rows: model.rows.map(row => insert(row, index, '')),
    };
}

export function removeRow(model, index) {
    return {...model, rows: remove(model.rows, index)};
}

/** The model without column `index`; a table keeps at least one column. */
export function removeColumn(model, index) {
    if (model.header.length < 2)
        return model;
    return {
        header: remove(model.header, index),
        align: remove(model.align, index),
        rows: model.rows.map(row => remove(row, index)),
    };
}

/** Sets a cell's Markdown; `row` -1 is the header. */
export function setCell(model, row, column, text) {
    const set = cells => cells.map((cell, i) => i === column ? text : cell);
    return row < 0 ? {...model, header: set(model.header)}
        : {...model, rows: model.rows.map((cells, i) => i === row ? set(cells) : cells)};
}

/** Sets a column's alignment: 'left', 'center', 'right' or null. */
export function setAlign(model, column, align) {
    return {...model, align: model.align.map((value, i) => i === column ? align : value)};
}
