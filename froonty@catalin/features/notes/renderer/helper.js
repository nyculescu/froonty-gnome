// SPDX-License-Identifier: GPL-3.0-or-later
// A hidden GTK 3 offscreen WebKit view renders tables, local images and the
// common offline Mermaid subset. The main Shell and GTK 4 processes exchange PNGs over JSONL.

import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import Gdk from 'gi://Gdk?version=3.0';
import GdkPixbuf from 'gi://GdkPixbuf';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=3.0';
import WebKit2 from 'gi://WebKit2?version=4.1';
import System from 'system';

Gio._promisify(Gio.DataInputStream.prototype, 'read_line_async');
Gio._promisify(WebKit2.WebView.prototype, 'run_javascript');

const MAX_WIDTH = 1600;
const MAX_HEIGHT = 5000;
const MAX_IMAGE_WIDTH = 360;
const MAX_IMAGE_HEIGHT = 320;

let output;

function htmlEscape(text) {
    return String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function inlineCell(source, baseUri) {
    const format = text => htmlEscape(text)
        .replace(/\*\*(\S(?:.*?\S)?)\*\*/g, '<strong>$1</strong>')
        .replace(/`([^`]+)`/g, '<code>$1</code>');
    const images = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
    const parts = [];
    let at = 0;
    for (let match; (match = images.exec(source)); ) {
        parts.push(format(source.slice(at, match.index)));
        const [, alt, path] = match;
        if (/^(?:[a-z]+:|\/)/i.test(path) || !baseUri) {
            parts.push(htmlEscape(alt));
        } else {
            const uri = Gio.File.new_for_uri(baseUri).resolve_relative_path(path).get_uri();
            parts.push(`<img src="${htmlEscape(uri)}" alt="${htmlEscape(alt)}">`);
        }
        at = match.index + match[0].length;
    }
    parts.push(format(source.slice(at)));
    return parts.join('');
}

function tableHtml(source, baseUri) {
    const lines = source.trim().split('\n');
    if (lines.length < 2)
        throw new Error('A Markdown table needs a header and separator row');
    const cells = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(s => s.trim());
    const heads = cells(lines[0]);
    const rules = cells(lines[1]);
    if (heads.length !== rules.length || rules.some(cell => !/^:?-{3,}:?$/.test(cell)))
        throw new Error('Invalid Markdown table separator');
    const align = cell => cell.startsWith(':') && cell.endsWith(':') ? 'center'
        : cell.endsWith(':') ? 'right' : 'left';
    const row = (items, tag) => `<tr>${heads.map((_, i) => `<${tag} style="text-align:${align(rules[i])}">${inlineCell(items[i] ?? '', baseUri)}</${tag}>`).join('')}</tr>`;
    return `<table>${row(heads, 'th')}${lines.slice(2).filter(Boolean).map(line => row(cells(line), 'td')).join('')}</table>`;
}

function diagramSvg(source, width) {
    const lines = source.split('\n').map(line => line.trim()).filter(Boolean);
    const type = lines[0]?.split(/\s+/)[0]?.toLowerCase();
    if (type === 'sequencediagram')
        return sequenceSvg(lines.slice(1), width);
    if (['flowchart', 'graph', 'statediagram', 'statediagram-v2'].includes(type))
        return flowchartSvg(lines, width);
    throw new Error('Offline diagrams support flowchart/graph, stateDiagram, and sequenceDiagram');
}

function flowchartSvg(lines, width) {
    const direction = lines[0]?.split(/\s+/)[1]?.toUpperCase() || 'TD';
    const vertical = direction !== 'LR' && direction !== 'RL';
    const reversed = direction === 'BT' || direction === 'RL';
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
    for (const line of lines.slice(1)) {
        if (line.startsWith('%%'))
            continue;
        const separators = [...line.matchAll(/(-->|---|-.->|==>|--o|--x)(?:\s*\|([^|]*)\|)?/g)];
        if (!separators.length) {
            node(line);
            continue;
        }
        let from = node(line.slice(0, separators[0].index).trim());
        for (let i = 0; i < separators.length; i++) {
            const separator = separators[i];
            const end = separators[i + 1]?.index ?? line.length;
            const target = line.slice(separator.index + separator[0].length, end).trim();
            const colon = target.indexOf(':');
            const to = node(colon < 0 ? target : target.slice(0, colon).trim(), 'to');
            if (from && to)
                edges.push({from, to, label: separator[2] ?? (colon < 0 ? '' : target.slice(colon + 1).trim())});
            from = to;
        }
    }
    if (!nodes.size)
        throw new Error('No flowchart nodes were found');
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

function sequenceSvg(lines, width) {
    const participants = [], messages = [];
    const add = (id, label = id) => {
        if (!participants.some(item => item.id === id))
            participants.push({id, label});
    };
    for (const line of lines) {
        const participant = /^(?:participant|actor)\s+([\w.-]+)(?:\s+as\s+(.+))?$/i.exec(line);
        if (participant) {
            add(participant[1], participant[2] ?? participant[1]);
            continue;
        }
        const message = /^([\w.-]+)\s*(-->>|->>|-->|->|--x)\s*([\w.-]+)\s*:\s*(.*)$/.exec(line);
        if (message) {
            add(message[1]); add(message[3]);
            messages.push({from: message[1], to: message[3], label: message[4], dashed: message[2].startsWith('--')});
        }
    }
    if (!participants.length)
        throw new Error('No sequence diagram participants were found');
    const gap = Math.max(180, (width - 60) / Math.max(1, participants.length - 1));
    const x = id => 30 + participants.findIndex(item => item.id === id) * gap;
    const top = 74, step = 54, height = top + messages.length * step + 24;
    const svgW = Math.max(width, 60 + (participants.length - 1) * gap);
    const heads = participants.map(item => `<g class="node"><rect x="${x(item.id) - 62}" y="14" width="124" height="44" rx="6"/><text x="${x(item.id)}" y="41" text-anchor="middle">${htmlEscape(item.label)}</text></g><path class="life" d="M${x(item.id)} 58 V${height - 10}"/>`).join('');
    const arrows = messages.map((item, i) => {
        const x1 = x(item.from), x2 = x(item.to), y = top + i * step;
        return `<path class="message ${item.dashed ? 'dashed' : ''}" d="M${x1} ${y} H${x2}" marker-end="url(#${x1 > x2 ? 'arrow-reverse' : 'arrow'})"/><text x="${(x1 + x2) / 2}" y="${y - 8}" text-anchor="middle">${htmlEscape(item.label)}</text>`;
    }).join('');
    return svgFrame(svgW, height, `${heads}${arrows}`);
}

function svgFrame(width, height, contents) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs><marker id="arrow" markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto"><path d="M0 0 L10 4 L0 8 Z"/></marker><marker id="arrow-reverse" markerWidth="10" markerHeight="8" refX="1" refY="4" orient="auto"><path d="M10 0 L0 4 L10 8 Z"/></marker></defs><style>text{font:14px sans-serif;fill:#222}.edge-label rect{fill:#fff;stroke:none}.edge-label text{font:14px sans-serif;fill:#222}.node rect,.node polygon,.node ellipse{fill:#f8f8f8;stroke:#555;stroke-width:1.5}path{fill:none;stroke:#555;stroke-width:1.5}marker path{fill:#555;stroke:none}.life{stroke:#999;stroke-dasharray:5 5}</style>${contents}</svg>`;
}

function page(request) {
    const css = `
        html,body{margin:0;padding:0;background:transparent;color:#222;font:14px sans-serif}
        body{padding:8px;box-sizing:border-box;width:${request.width}px}
        #render-content{display:flow-root;width:100%}
        table{border-collapse:collapse;width:auto;max-width:100%;font-size:14px}
        th,td{border:1px solid #888;padding:5px 8px;vertical-align:top}
        th{background:#8882;font-weight:600}
        img{max-width:100%;max-height:700px;height:auto;object-fit:contain}
        svg{max-width:100%;height:auto}
        .error{font:13px monospace;white-space:pre-wrap;color:#a00}
    `;
    const policy = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src file: data:; font-src file: data:; connect-src 'none'; object-src 'none'; base-uri file:">`;
    let content;
    if (request.kind === 'table')
        content = tableHtml(request.source, request.baseUri);
    else if (request.kind === 'image')
        content = `<img src="${htmlEscape(request.uri)}" alt="${htmlEscape(request.alt ?? '')}">`;
    else
        content = diagramSvg(request.source, request.width);
    return `<html><head><meta charset="utf-8">${policy}<style>${css}</style></head><body><div id="render-content">${content}</div></body></html>`;
}

async function js(web, script) {
    const result = await web.run_javascript(script, null);
    return result.get_js_value().to_string();
}

function wait(ms) {
    return new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
}

async function render(request) {
    const width = Math.min(MAX_WIDTH, Math.max(120, Math.round(request.width || 600)));
    if (request.kind === 'image') {
        const path = Gio.File.new_for_uri(request.uri).get_path();
        if (!path)
            throw new Error('The image path is not a local file');
        const source = GdkPixbuf.Pixbuf.new_from_file(path);
        const scale = Math.min(1, width / source.get_width(), MAX_IMAGE_WIDTH / source.get_width(),
            MAX_IMAGE_HEIGHT / source.get_height());
        const image = scale < 1
            ? source.scale_simple(Math.max(1, Math.round(source.get_width() * scale)),
                Math.max(1, Math.round(source.get_height() * scale)), GdkPixbuf.InterpType.BILINEAR)
            : source;
        const [, png] = image.save_to_bufferv('png', [], []);
        return {png, width: image.get_width(), height: image.get_height()};
    }
    const window = new Gtk.OffscreenWindow();
    try {
    window.set_app_paintable(true);
    const visual = Gdk.Screen.get_default()?.get_rgba_visual();
    if (visual)
        window.set_visual(visual);
    window.set_default_size(width, 800);
    const web = new WebKit2.WebView();
    web.set_size_request(width, 800);
    window.add(web);
    const transparent = new Gdk.RGBA();
    transparent.red = transparent.green = transparent.blue = transparent.alpha = 0;
    web.set_background_color(transparent);
    window.show_all();
    const loaded = new Promise((resolve, reject) => {
        web.connect('load-changed', (_web, event) => {
            if (event === WebKit2.LoadEvent.FINISHED)
                resolve();
        });
        web.connect('load-failed', (_web, _event, uri, error) => reject(new Error(`${uri}: ${error.message}`)));
    });
    web.load_html(page(request), request.baseUri || null);
    await loaded;
    // body.scrollHeight can equal the WebView's 800 px preview viewport even
    // when a table or diagram is only a few lines high. Measure the rendered
    // child instead, so the exported PNG contains only the block and padding.
    const contentHeight = Number(await js(web,
        'document.getElementById("render-content").getBoundingClientRect().height')) || 64;
    const height = Math.min(MAX_HEIGHT, Math.max(80, Math.ceil(contentHeight + 16)));
    window.resize(width, height);
    web.set_size_request(width, height);
    window.queue_draw();
    await wait(120);
    const pixbuf = window.get_pixbuf();
    if (!pixbuf)
        throw new Error('WebKit did not produce a picture');
    // OffscreenWindow/WebKit can keep the original 800 px viewport after a
    // resize. Crop to the DOM-measured block height so unused viewport pixels
    // do not become blank space after diagrams and tables in either editor.
    const cropHeight = Math.min(pixbuf.get_height(), height);
    const cropped = cropHeight < pixbuf.get_height()
        ? pixbuf.new_subpixbuf(0, 0, pixbuf.get_width(), cropHeight) : pixbuf;
    const [, bytes] = cropped.save_to_bufferv('png', [], []);
    return {png: bytes, width: cropped.get_width(), height: cropped.get_height()};
    } finally {
        window.destroy();
    }
}

function reply(message) {
    output.write_all(new TextEncoder().encode(`${JSON.stringify(message)}\n`), null);
}

async function handle(line) {
    let request;
    try { request = JSON.parse(line); } catch {
        reply({id: null, error: 'Malformed renderer request'});
        return;
    }
    try {
        const result = await render(request);
        reply({id: request.id, png: GLib.base64_encode(result.png),
            width: result.width, height: result.height});
    } catch (e) {
        reply({id: request?.id ?? null, error: String(e?.message ?? e)});
    }
}

async function serve(input) {
    for (;;) {
        const [line] = await input.read_line_async(GLib.PRIORITY_DEFAULT, null);
        if (line === null)
            break;
        await handle(new TextDecoder().decode(line));
    }
}

function main() {
    Gtk.init(null);
    const input = new Gio.DataInputStream({base_stream: new GioUnix.InputStream({fd: 0, close_fd: false})});
    output = new GioUnix.OutputStream({fd: 1, close_fd: false});
    const loop = new GLib.MainLoop(null, false);
    serve(input).catch(e => console.warn(`Froonty WebKit renderer: ${e.message}`)).finally(() => loop.quit());
    loop.run();
}

if (System.programPath === GLib.filename_from_uri(import.meta.url)[0])
    main();
