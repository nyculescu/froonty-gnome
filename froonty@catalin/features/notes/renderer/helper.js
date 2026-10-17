// SPDX-License-Identifier: GPL-3.0-or-later
// A hidden GTK 3 offscreen WebKit view renders tables and the common offline
// Mermaid subset (tableHtml.js, diagram.js); GdkPixbuf decodes local images.
// The main Shell and GTK 4 processes exchange PNGs over JSONL (client.js):
// a reply is {id, png, width, height, warnings} or {id, error}.

import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import Gdk from 'gi://Gdk?version=3.0';
import GdkPixbuf from 'gi://GdkPixbuf';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=3.0';
import WebKit2 from 'gi://WebKit2?version=4.1';
import System from 'system';

import {diagramSvg, limitWarnings} from './diagram.js';
import {imagePath} from './imageFile.js';
import {tableHtml} from './tableHtml.js';

Gio._promisify(Gio.DataInputStream.prototype, 'read_line_async');
Gio._promisify(WebKit2.WebView.prototype, 'run_javascript');

const MAX_WIDTH = 1600;
const MAX_HEIGHT = 5000;
// Images keep their own size up to this, so enlarging one or copying it
// stays sharp; the views show them smaller (renderer/blocks.js).
const MAX_IMAGE_SIZE = 1600;

let output;

// A table cell's image: its file's URI, or why it is not drawn.
const cellImage = baseUri => source => {
    const path = imagePath(source);
    if (path === null || !baseUri)
        return {problem: `Image ${source}: use a path relative to this note`};
    const file = Gio.File.new_for_uri(baseUri).resolve_relative_path(path);
    if (!file.query_exists(null))
        return {problem: `Image not found: ${source}`};
    return {uri: file.get_uri()};
};

// The page of a table or diagram, and what it leaves out.
function page(request) {
    const css = `
        html,body{margin:0;padding:0;background:#fff;color:#222;font:14px sans-serif}
        body{padding:8px;box-sizing:border-box;width:${request.width}px}
        #render-content{display:flow-root;width:100%}
        table{border-collapse:collapse;width:auto;max-width:100%;font-size:14px}
        th,td{border:1px solid #888;padding:5px 8px;vertical-align:top}
        th{background:#8882;font-weight:600}
        img{max-width:100%;max-height:700px;height:auto;object-fit:contain}
        svg{max-width:100%;height:auto}
    `;
    const policy = '<meta http-equiv="Content-Security-Policy" content="' +
        "default-src 'none'; style-src 'unsafe-inline'; img-src file: data:; font-src file: data:; " +
        "connect-src 'none'; object-src 'none'; base-uri file:\">";
    const {html, svg, warnings} = request.kind === 'table'
        ? tableHtml(request.source, cellImage(request.baseUri)) : diagramSvg(request.source, request.width);
    return {
        html: `<html><head><meta charset="utf-8">${policy}<style>${css}</style></head><body><div id="render-content">${html ?? svg}</div></body></html>`,
        warnings,
    };
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

// An image at its own size, up to MAX_IMAGE_SIZE, the right way up.
function renderImage(request) {
    const file = Gio.File.new_for_uri(request.uri);
    const name = file.get_basename();
    const path = file.get_path();
    if (!path)
        throw new Error('The image is not a local file');
    if (!file.query_exists(null))
        throw new Error(`Image not found: ${name}`);
    const [format, width, height] = GdkPixbuf.Pixbuf.get_file_info(path);
    if (!format)
        throw new Error(`${name} is not an image this system can read`);
    let image;
    try {
        // Decoded at the smaller size, not whole and then scaled.
        const scale = Math.min(1, MAX_IMAGE_SIZE / width, MAX_IMAGE_SIZE / height);
        image = scale < 1
            ? GdkPixbuf.Pixbuf.new_from_file_at_scale(path, Math.max(1, Math.round(width * scale)),
                Math.max(1, Math.round(height * scale)), true)
            : GdkPixbuf.Pixbuf.new_from_file(path);
    } catch (e) {
        throw new Error(`Could not read the image ${name}: ${e.message}`);
    }
    image = image.apply_embedded_orientation() ?? image;
    const [, png] = image.save_to_bufferv('png', [], []);
    return {png, width: image.get_width(), height: image.get_height(), warnings: []};
}

async function render(request) {
    if (request.kind === 'image')
        return renderImage(request);
    const width = Math.min(MAX_WIDTH, Math.max(120, Math.round(request.width || 600)));
    const {html, warnings} = page(request);
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
    web.load_html(html, request.baseUri || null);
    await loaded;
    // Cell images that were found but did not load: their alt text (or
    // path) instead, named in the warnings.
    const broken = JSON.parse(await js(web, 'JSON.stringify([...document.images]' +
        '.filter(image => image.complete && !image.naturalWidth).map(image => {' +
        'image.replaceWith(image.alt || image.dataset.path); return image.dataset.path; }))'));
    warnings.push(...broken.map(path => `Image could not be loaded: ${path}`));
    // body.scrollHeight can equal the WebView's 800 px preview viewport even
    // when a table or diagram is only a few lines high. Measure the rendered
    // child instead, so the exported PNG contains only the block and padding.
    const contentBounds = JSON.parse(await js(web,
        'JSON.stringify((document.querySelector("#render-content > *") || document.getElementById("render-content")).getBoundingClientRect().toJSON())'));
    const cropWidth = Math.min(width, Math.max(80, Math.ceil(contentBounds.width + 16)));
    const height = Math.min(MAX_HEIGHT, Math.max(80, Math.ceil(contentBounds.height + 16)));
    window.resize(width, height);
    web.set_size_request(width, height);
    window.queue_draw();
    await wait(120);
    const pixbuf = window.get_pixbuf();
    if (!pixbuf)
        throw new Error('WebKit did not produce a picture');
    // OffscreenWindow/WebKit can keep the original viewport after a resize.
    // Crop to the rendered block's own bounds so tables don't retain the
    // full-width wrapper's blank area (which also displaced their resize grip).
    const cropX = Math.max(0, Math.floor(contentBounds.left - 8));
    const cropY = Math.max(0, Math.floor(contentBounds.top - 8));
    const actualCropWidth = Math.min(pixbuf.get_width() - cropX, cropWidth);
    const cropHeight = Math.min(pixbuf.get_height() - cropY, height);
    const cropped = cropX || cropY || actualCropWidth < pixbuf.get_width() ||
        cropHeight < pixbuf.get_height()
        ? pixbuf.new_subpixbuf(cropX, cropY, actualCropWidth, cropHeight) : pixbuf;
    const [, bytes] = cropped.save_to_bufferv('png', [], []);
    return {png: bytes, width: cropped.get_width(), height: cropped.get_height(), warnings};
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
            width: result.width, height: result.height, warnings: limitWarnings(result.warnings)});
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
