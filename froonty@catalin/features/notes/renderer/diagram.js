// SPDX-License-Identifier: GPL-3.0-or-later
// The common offline Mermaid subset as SVG, for the WebKit helper
// (helper.js). Pure: no GI, so it is unit-tested without WebKit.
//
//   diagramSvg(source, width) → {svg, warnings}
//       source: a fenced block's body; width: the canvas width in px.
//       What it cannot draw (a statement it does not know, a node it
//       cannot read) is left out and named in `warnings` (short strings,
//       "Line 3 not drawn: classDef big fill:#f9f"; lines count from the
//       diagram's first line, 1); the rest is drawn. A diagram it cannot
//       draw at all throws an Error with a short human reason.
//   htmlEscape(text): shared with tableHtml.js.
//   limitWarnings(warnings): a block's warnings cut to a few, for the reply.

const MAX_WARNINGS = 8;

export function htmlEscape(text) {
    return String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

/** At most MAX_WARNINGS, the last one saying how many more there were. */
export function limitWarnings(warnings) {
    if (warnings.length <= MAX_WARNINGS)
        return warnings;
    return [...warnings.slice(0, MAX_WARNINGS - 1),
        `${warnings.length - MAX_WARNINGS + 1} more problems not listed`];
}

const clip = text => text.length > 60 ? `${text.slice(0, 59)}…` : text;

export function diagramSvg(source, width) {
    // {text, number}: trimmed, numbered from the diagram's first line.
    const lines = String(source).split('\n')
        .map((text, i) => ({text: text.trim(), number: i + 1}))
        .filter(line => line.text && !line.text.startsWith('%%'));
    if (!lines.length)
        throw new Error('The diagram is empty');
    const name = lines[0].text.split(/\s+/)[0];
    const type = name.toLowerCase();
    const warnings = [];
    let svg;
    if (type === 'sequencediagram')
        svg = sequenceSvg(lines.slice(1), width, warnings);
    else if (['flowchart', 'graph', 'statediagram', 'statediagram-v2'].includes(type))
        svg = flowchartSvg(lines, width, warnings);
    else
        throw new Error(`${clip(name)} diagrams cannot be drawn offline; use flowchart, graph, stateDiagram or sequenceDiagram`);
    return {svg, warnings};
}

// Statements the layout does not draw (styles, subgraph frames, notes…).
const FLOW_KEYWORD = /^(?:classDef|class|style|linkStyle|click|subgraph|end|direction|accTitle|accDescr|note|state)\b|^[{}]|^--$/;

// What to throw when nothing could be drawn: the first problem says why.
const nothingDrawn = warnings => new Error(warnings.length
    ? `Nothing in this diagram could be drawn (${warnings[0]})` : 'The diagram has nothing to draw');

function flowchartSvg(lines, width, warnings) {
    const direction = lines[0].text.split(/\s+/)[1]?.toUpperCase() || 'TD';
    const vertical = direction !== 'LR' && direction !== 'RL';
    const reversed = direction === 'BT' || direction === 'RL';
    // `s1 --> s2 : event` labels a state transition; a flowchart's colon is
    // only text (`A --> B[Step 1: fetch]`).
    const transitions = lines[0].text.toLowerCase().startsWith('statediagram');
    const nodes = new Map(), edges = [];
    const nodeRe = /^(\[\*\]|[\w.-]+)(?:\[\[([^\]]*)\]\]|\(\(([^)]*)\)\)|\[([^\]]*)\]|\(([^)]*)\)|\{([^}]*)\})?$/;
    const node = (token, endpoint = 'from') => {
        const match = nodeRe.exec(token);
        if (!match)
            return null;
        const id = match[1] === '[*]' ? `__${endpoint}` : match[1];
        if (!nodes.has(id))
            nodes.set(id, {id, label: match[1] === '[*]' ? '●'
                : match.slice(2).find(value => value !== undefined) ?? id,
                shape: match[1] === '[*]' ? '((●))' : match[0].slice(match[1].length)});
        return nodes.get(id);
    };
    for (const {text, number} of lines.slice(1)) {
        const line = text.replace(/;$/, '').trim();
        const separators = [...line.matchAll(/(-\.+->|-{2,}>|={2,}>|-{3,}|--o|--x)(?:\s*\|([^|]*)\|)?/g)];
        if (!separators.length) {
            if (FLOW_KEYWORD.test(line) || !node(line))
                warnings.push(`Line ${number} not drawn: ${clip(text)}`);
            continue;
        }
        // A part of the line that is no node: the arrows at it are left out.
        const endpoint = (token, end) => {
            const found = node(token, end);
            if (!found)
                warnings.push(token ? `Line ${number}: arrow not drawn, "${clip(token)}" not understood`
                    : `Line ${number} not drawn: ${clip(text)}`);
            return found;
        };
        let from = endpoint(line.slice(0, separators[0].index).trim(), 'from');
        for (let i = 0; i < separators.length; i++) {
            const separator = separators[i];
            const end = separators[i + 1]?.index ?? line.length;
            const target = line.slice(separator.index + separator[0].length, end).trim();
            const colon = transitions ? target.indexOf(':') : -1;
            const to = endpoint(colon < 0 ? target : target.slice(0, colon).trim(), 'to');
            if (from && to)
                edges.push({from, to, label: separator[2] ?? (colon < 0 ? '' : target.slice(colon + 1).trim())});
            from = to;
        }
    }
    if (!nodes.size)
        throw nothingDrawn(warnings);
    const list = [...nodes.values()];
    const outgoing = new Map(list.map(item => [item.id, []]));
    for (const edge of edges)
        outgoing.get(edge.from.id).push(edge);

    // Remove DFS back-edges from the ranking pass. They are routed around
    // the chart edge below, so cycles such as D --> B stay readable.
    const state = new Map(), backEdges = new Set();
    const visit = item => {
        state.set(item.id, 1);
        for (const edge of outgoing.get(item.id)) {
            if (state.get(edge.to.id) === 1)
                backEdges.add(edge);
            else if (!state.has(edge.to.id))
                visit(edge.to);
        }
        state.set(item.id, 2);
    };
    for (const item of list) {
        if (!state.has(item.id))
            visit(item);
    }

    // Longest-path ranks put branch outcomes on the same row/column.
    const ranks = new Map(list.map(item => [item.id, 0]));
    const indegree = new Map(list.map(item => [item.id, 0]));
    for (const edge of edges) {
        if (!backEdges.has(edge))
            indegree.set(edge.to.id, indegree.get(edge.to.id) + 1);
    }
    const queue = list.filter(item => indegree.get(item.id) === 0);
    for (let at = 0; at < queue.length; at++) {
        const item = queue[at];
        for (const edge of outgoing.get(item.id)) {
            if (backEdges.has(edge))
                continue;
            ranks.set(edge.to.id, Math.max(ranks.get(edge.to.id), ranks.get(item.id) + 1));
            indegree.set(edge.to.id, indegree.get(edge.to.id) - 1);
            if (indegree.get(edge.to.id) === 0)
                queue.push(edge.to);
        }
    }

    const groups = new Map();
    for (const item of list) {
        const rank = ranks.get(item.id);
        if (!groups.has(rank))
            groups.set(rank, []);
        groups.get(rank).push(item);
    }
    const rankCount = Math.max(...groups.keys()) + 1;
    const largestGroup = Math.max(...[...groups.values()].map(group => group.length));
    const margin = 32, nodeH = 56, nodeGap = 28, rankGap = vertical ? 76 : 36;
    const nodeW = vertical
        ? Math.max(110, Math.min(280,
            Math.floor((width - margin * 2 - nodeGap * (largestGroup - 1)) / largestGroup)))
        : Math.max(110, Math.min(220,
            Math.floor((width - margin * 2 - rankGap * (rankCount - 1)) / rankCount)));
    const crossGap = vertical ? nodeGap : 34;
    const crossExtent = largestGroup * (vertical ? nodeW : nodeH) +
        Math.max(0, largestGroup - 1) * crossGap;
    const svgW = vertical ? Math.max(width, crossExtent + margin * 2)
        : Math.max(width, rankCount * nodeW + (rankCount - 1) * rankGap + margin * 2);
    const svgH = vertical ? rankCount * nodeH + (rankCount - 1) * rankGap + margin * 2
        : Math.max(190, crossExtent + margin * 2);
    const pos = new Map();
    for (const [rank, group] of groups) {
        const layer = reversed ? rankCount - rank - 1 : rank;
        const extent = group.length * (vertical ? nodeW : nodeH) +
            Math.max(0, group.length - 1) * crossGap;
        if (vertical) {
            const left = margin;
            group.forEach((item, i) => pos.set(item.id, {
                x: left + i * (nodeW + crossGap),
                y: margin + layer * (nodeH + rankGap),
            }));
        } else {
            const top = (svgH - extent) / 2;
            group.forEach((item, i) => pos.set(item.id, {
                x: margin + layer * (nodeW + rankGap),
                y: top + i * (nodeH + crossGap),
            }));
        }
    }
    const edgeText = (label, x, y, anchor = 'middle') => {
        if (!label)
            return '';
        const boxWidth = Math.max(28, label.length * 8 + 12);
        const left = anchor === 'end' ? x - boxWidth : anchor === 'start' ? x : x - boxWidth / 2;
        return `<g class="edge-label"><rect x="${left}" y="${y - 16}" width="${boxWidth}" height="22" rx="4"/><text x="${x}" y="${y}" text-anchor="${anchor}">${htmlEscape(label)}</text></g>`;
    };
    const paths = edges.map(edge => {
        const a = pos.get(edge.from.id), b = pos.get(edge.to.id);
        let d, label;
        if (vertical && backEdges.has(edge)) {
            const outer = svgW - margin / 2;
            const x1 = a.x + nodeW, y1 = a.y + nodeH / 2;
            const x2 = b.x + nodeW, y2 = b.y + nodeH / 2;
            d = `M${x1} ${y1} H${outer} V${y2} H${x2}`;
            label = edgeText(edge.label, outer - 5, (y1 + y2) / 2 - 4, 'end');
        } else if (!vertical && backEdges.has(edge)) {
            const outer = svgH - margin / 2;
            const x1 = a.x + nodeW / 2, y1 = a.y + nodeH;
            const x2 = b.x + nodeW / 2, y2 = b.y + nodeH;
            d = `M${x1} ${y1} V${outer} H${x2} V${y2}`;
            label = edgeText(edge.label, (x1 + x2) / 2, outer - 5);
        } else if (vertical) {
            const x1 = a.x + nodeW / 2, x2 = b.x + nodeW / 2;
            const y1 = reversed ? a.y : a.y + nodeH;
            const y2 = reversed ? b.y + nodeH : b.y;
            const mid = (y1 + y2) / 2;
            d = `M${x1} ${y1} V${mid} H${x2} V${y2}`;
            label = edgeText(edge.label, (x1 + x2) / 2, mid - 6);
        } else {
            const x1 = reversed ? a.x : a.x + nodeW;
            const x2 = reversed ? b.x + nodeW : b.x;
            const y1 = a.y + nodeH / 2, y2 = b.y + nodeH / 2;
            const mid = (x1 + x2) / 2;
            d = `M${x1} ${y1} H${mid} V${y2} H${x2}`;
            label = edgeText(edge.label, mid, (y1 + y2) / 2 - 6);
        }
        return `<path d="${d}" marker-end="url(#arrow)"/>${label}`;
    }).join('');
    const shapes = list.map(item => {
        const p = pos.get(item.id);
        const form = item.shape.includes('{')
            ? `<polygon points="${p.x + nodeW / 2},${p.y} ${p.x + nodeW},${p.y + nodeH / 2} ${p.x + nodeW / 2},${p.y + nodeH} ${p.x},${p.y + nodeH / 2}"/>`
            : item.shape.includes('((')
                ? `<ellipse cx="${p.x + nodeW / 2}" cy="${p.y + nodeH / 2}" rx="${nodeW / 2}" ry="${nodeH / 2}"/>`
                : `<rect x="${p.x}" y="${p.y}" width="${nodeW}" height="${nodeH}" rx="${item.shape.includes('(') ? nodeH / 2 : 6}"/>`;
        const fontSize = Math.max(10, Math.min(14, 1.8 * (nodeW - 20) / Math.max(1, item.label.length)));
        return `<g class="node">${form}<text x="${p.x + nodeW / 2}" y="${p.y + nodeH / 2 + 5}" text-anchor="middle" style="font-size:${fontSize}px">${htmlEscape(item.label)}</text></g>`;
    }).join('');
    return svgFrame(svgW, svgH, `${paths}${shapes}`);
}

function sequenceSvg(lines, width, warnings) {
    const participants = [], messages = [];
    const add = (id, label = id) => {
        if (!participants.some(item => item.id === id))
            participants.push({id, label});
    };
    for (const {text, number} of lines) {
        const participant = /^(?:participant|actor)\s+([\w.-]+)(?:\s+as\s+(.+))?$/i.exec(text);
        if (participant) {
            add(participant[1], participant[2] ?? participant[1]);
            continue;
        }
        const message = /^([\w.-]+)\s*(-->>|->>|--x|-x|--\)|-\)|-->|->)\s*([\w.-]+)\s*:\s*(.*)$/.exec(text);
        if (message) {
            add(message[1]); add(message[3]);
            messages.push({from: message[1], to: message[3], label: message[4], dashed: message[2].startsWith('--')});
        } else {
            // Notes, loops, alt/else, activation: not drawn.
            warnings.push(`Line ${number} not drawn: ${clip(text)}`);
        }
    }
    if (!participants.length)
        throw nothingDrawn(warnings);
    const gap = Math.max(180, (width - 60) / Math.max(1, participants.length - 1));
    const x = id => 30 + participants.findIndex(item => item.id === id) * gap;
    const top = 74, step = 54, height = top + messages.length * step + 24;
    const svgW = Math.max(width, 60 + (participants.length - 1) * gap);
    const heads = participants.map(item => '<g class="node">' +
        `<rect x="${x(item.id) - 62}" y="14" width="124" height="44" rx="6"/>` +
        `<text x="${x(item.id)}" y="41" text-anchor="middle">${htmlEscape(item.label)}</text></g>` +
        `<path class="life" d="M${x(item.id)} 58 V${height - 10}"/>`).join('');
    const arrows = messages.map((item, i) => {
        const x1 = x(item.from), x2 = x(item.to), y = top + i * step;
        return `<path class="message ${item.dashed ? 'dashed' : ''}" d="M${x1} ${y} H${x2}" ` +
            `marker-end="url(#${x1 > x2 ? 'arrow-reverse' : 'arrow'})"/>` +
            `<text x="${(x1 + x2) / 2}" y="${y - 8}" text-anchor="middle">${htmlEscape(item.label)}</text>`;
    }).join('');
    return svgFrame(svgW, height, `${heads}${arrows}`);
}

function svgFrame(width, height, contents) {
    return [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
        '<defs><marker id="arrow" markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto">',
        '<path d="M0 0 L10 4 L0 8 Z"/></marker>',
        '<marker id="arrow-reverse" markerWidth="10" markerHeight="8" refX="1" refY="4" orient="auto">',
        '<path d="M10 0 L0 4 L10 8 Z"/></marker></defs>',
        '<style>text{font:14px sans-serif;fill:#222}',
        '.edge-label rect{fill:#fff;stroke:none}.edge-label text{font:14px sans-serif;fill:#222}',
        '.node rect,.node polygon,.node ellipse{fill:#f8f8f8;stroke:#555;stroke-width:1.5}',
        'path{fill:none;stroke:#555;stroke-width:1.5}marker path{fill:#555;stroke:none}',
        '.life{stroke:#999;stroke-dasharray:5 5}</style>',
        contents,
        '</svg>',
    ].join('');
}
