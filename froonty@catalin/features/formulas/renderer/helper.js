// SPDX-License-Identifier: GPL-3.0-or-later
// The math renderer helper: a separate gjs process (`gjs -m helper.js`)
// that client.js starts, so MathJax never runs inside GNOME Shell or the
// settings window (docs/features/formulas.md §4).
//
// Protocol: one JSON object per line on stdin, one reply per line on
// stdout, in request order:
//
//   → {"id": 7, "tex": "x^2", "display": false, "color": "#ffffff", "scale": 1}
//   ← {"id": 7, "png": "<base64>", "width": 38, "height": 33, "baseline": 29.2}
//   ← {"id": 7, "error": "Missing close brace", "kind": "tex"}
//
// width and height are pixels; baseline is the pixels from the image's
// top edge down to the text baseline (below the image for a formula that
// sits above it, ° say). kind is 'tex' (MathJax refused the formula: the
// message is MathJax's own), 'unavailable' (MathJax is not fetched) or
// 'request' (not a valid request). MathJax loads on the first request. The
// helper ends when stdin closes. Imported as a module (the unit tests'
// parse check), it does nothing.

import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';
import System from 'system';

import {defaultMathJaxDir, FormulaError, MathRenderer} from './mathjax.js';

Gio._promisify(Gio.DataInputStream.prototype, 'read_line_async');

let renderer = null;
let output = null;

function reply(message) {
    output.write_all(new TextEncoder().encode(`${JSON.stringify(message)}\n`), null);
}

async function load(dir) {
    renderer ??= MathRenderer.load(dir).catch(e => {
        // Not fetched, or a broken tree: every request says so.
        throw new FormulaError(`MathJax is not available (${e.message})`);
    });
    return renderer;
}

async function handle(line, dir) {
    let request;
    try {
        request = JSON.parse(line);
    } catch (e) {
        reply({id: null, error: 'Not JSON', kind: 'request'});
        return;
    }
    const id = request?.id ?? null;
    if (typeof id !== 'number' && typeof id !== 'string') {
        reply({id: null, error: 'No id', kind: 'request'});
        return;
    }
    let mathjax;
    try {
        mathjax = await load(dir);
    } catch (e) {
        reply({id, error: e.message, kind: 'unavailable'});
        return;
    }
    try {
        const {png, width, height, baseline} = await mathjax.render(request);
        reply({id, png: GLib.base64_encode(png), width, height,
            baseline: Math.round(baseline * 100) / 100});
    } catch (e) {
        if (!(e instanceof FormulaError))
            console.warn(`Froonty math renderer: ${e.message}`);
        reply({id, error: e.message, kind: 'tex'});
    }
}

async function serve(input, dir) {
    try {
        for (;;) {
            // eslint-disable-next-line no-await-in-loop
            const [line] = await input.read_line_async(GLib.PRIORITY_DEFAULT, null);
            if (line === null)
                break;
            const text = new TextDecoder().decode(line).trim();
            if (text)
                // One at a time: replies keep the requests' order.
                // eslint-disable-next-line no-await-in-loop
                await handle(text, dir);
        }
    } catch (e) {
        console.warn(`Froonty math renderer: ${e.message}`);
    }
}

function main() {
    const dir = GLib.getenv('FROONTY_MATHJAX_DIR') || defaultMathJaxDir();
    const input = new Gio.DataInputStream({
        base_stream: new GioUnix.InputStream({fd: 0, close_fd: false}),
    });
    output = new GioUnix.OutputStream({fd: 1, close_fd: false});
    const loop = new GLib.MainLoop(null, false);
    serve(input, dir).finally(() => loop.quit());
    loop.run();
}

if (System.programPath === GLib.filename_from_uri(import.meta.url)[0])
    main();
