// SPDX-License-Identifier: GPL-3.0-or-later
// A pipe table as HTML, for the WebKit helper (helper.js). Pure: no GI.
//
//   tableHtml(source, image) → {html, warnings}
//       image(path) → {uri} to load a cell image (`![alt](path)`), or
//       {problem: string} when it cannot be (named in `warnings`; the
//       cell shows the image's alt text, or its path). Extra cells past
//       the header are named in `warnings` too. A source that is no table
//       throws an Error with a short human reason (parseTable's).
//   Images that are found but do not load are the helper's to name: each
//   <img> carries its Markdown path in data-path.

import {parseTable} from '../table.js';
import {htmlEscape} from './diagram.js';

const IMAGE = /!\[([^\]]*)\]\(([^)\s]+)\)/g;

function inlineCell(source, image, warnings) {
    const format = text => htmlEscape(text.replaceAll('\\|', '|'))
        .replace(/\*\*(\S(?:.*?\S)?)\*\*/g, '<strong>$1</strong>')
        .replace(/`([^`]+)`/g, '<code>$1</code>');
    const parts = [];
    let at = 0;
    for (const match of source.matchAll(IMAGE)) {
        parts.push(format(source.slice(at, match.index)));
        const [, alt, path] = match;
        const found = image(path);
        if (found.uri) {
            parts.push(`<img src="${htmlEscape(found.uri)}" alt="${htmlEscape(alt)}" data-path="${htmlEscape(path)}">`);
        } else {
            warnings.push(found.problem);
            parts.push(htmlEscape(alt || path));
        }
        at = match.index + match[0].length;
    }
    parts.push(format(source.slice(at)));
    return parts.join('');
}

export function tableHtml(source, image) {
    const {header, align, rows} = parseTable(source);
    const warnings = [];
    rows.forEach((cells, i) => {
        if (cells.length > header.length)
            warnings.push(`Row ${i + 1} has ${cells.length} cells, the header ${header.length}: the extra ones are not shown`);
    });
    const row = (cells, tag) => `<tr>${header.map((_, i) =>
        `<${tag} style="text-align:${align[i] ?? 'left'}">${inlineCell(cells[i], image, warnings)}</${tag}>`).join('')}</tr>`;
    const html = `<table>${row(header, 'th')}${rows.map(cells => row(cells, 'td')).join('')}</table>`;
    return {html, warnings};
}
