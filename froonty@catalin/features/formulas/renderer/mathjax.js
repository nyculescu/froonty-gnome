// SPDX-License-Identifier: GPL-3.0-or-later
// MathJax in plain GJS (docs/features/formulas.md §4): TeX in, SVG out
// through MathJax's own "lite" DOM, then a PNG drawn by librsvg. Loaded
// only by the renderer helper (helper.js), never by GNOME Shell or the
// settings window: loading takes ~150 ms and each formula a few ms, which
// neither should wait for.
//
// MathJax lives in third_party/mathjax, fetched by tools/fetch-mathjax.py;
// its modules are imported here at run time, so a missing tree is an
// error the helper can report instead of a module that fails to load.

import GLib from 'gi://GLib';
import Rsvg from 'gi://Rsvg?version=2.0';

// The TeX packages loaded (tools/fetch-mathjax.py's TEX_PACKAGES): name
// for TeX's `packages` option → its configuration module. Undefined
// commands stay errors (no noundefined), so the editor can name them.
export const TEX_PACKAGES = [
    ['base', 'base/BaseConfiguration'],
    ['ams', 'ams/AmsConfiguration'],
    ['newcommand', 'newcommand/NewcommandConfiguration'],
    ['mhchem', 'mhchem/MhchemConfiguration'],
    ['physics', 'physics/PhysicsConfiguration'],
    ['braket', 'braket/BraketConfiguration'],
    ['cancel', 'cancel/CancelConfiguration'],
    ['cases', 'cases/CasesConfiguration'],
    ['mathtools', 'mathtools/MathtoolsConfiguration'],
    ['boldsymbol', 'boldsymbol/BoldsymbolConfiguration'],
    ['upgreek', 'upgreek/UpgreekConfiguration'],
    ['textmacros', 'textmacros/TextMacrosConfiguration'],
    ['gensymb', 'gensymb/GensymbConfiguration'],
    ['units', 'units/UnitsConfiguration'],
    ['color', 'color/ColorConfiguration'],
];

// Logical px of 1em at scale 1 (MathJax's ex is half of it here).
export const EM_PX = 16;
// Transparent room around the drawing (in em): glyphs may reach slightly
// past MathJax's bounding box (italic overhangs, accents).
const PAD_EM = 0.08;
// The longest formula accepted, and the most pixels on a side drawn.
export const MAX_TEX_LENGTH = 4000;
const MAX_SIDE_PX = 4096;
const COLOR = /^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/;

/** The folder fetch-mathjax.py fills: froonty@catalin/third_party/mathjax. */
export function defaultMathJaxDir() {
    const here = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
    return GLib.build_filenamev([here, '..', '..', '..', 'third_party', 'mathjax']);
}

/** A formula MathJax refused; message is MathJax's own, first line. */
export class FormulaError extends Error {}

/**
 * Pixel geometry for a MathJax SVG: its viewBox (1/1000 em, y up to the
 * baseline at 0) drawn at emPx, padded, rounded up to whole pixels.
 *
 * @param {number[]} viewBox [x, y, width, height]
 * @param {number} emPx
 * @returns {{width: number, height: number, baseline: number, viewBox: number[]}}
 *   baseline: px from the image's top edge down to the text baseline;
 *   viewBox: the padded one that maps exactly onto width × height
 */
export function geometry([x, y, w, h], emPx) {
    const unitsPerPx = 1000 / emPx;
    const pad = PAD_EM * 1000;
    const width = Math.max(1, Math.ceil((w + 2 * pad) / unitsPerPx));
    const height = Math.max(1, Math.ceil((h + 2 * pad) / unitsPerPx));
    return {
        width,
        height,
        baseline: (pad - y) / unitsPerPx,
        viewBox: [x - pad, y - pad, width * unitsPerPx, height * unitsPerPx],
    };
}

export class MathRenderer {
    /**
     * Imports MathJax from dir and builds one TeX → SVG document.
     *
     * @param {string} dir a fetched third_party/mathjax
     * @returns {Promise<MathRenderer>}
     */
    static async load(dir = defaultMathJaxDir()) {
        const src = GLib.build_filenamev([dir, 'src', 'mjs']);
        const fontDir = GLib.build_filenamev([dir, 'mathjax-newcm-font', 'mjs']);
        const uri = path => GLib.filename_to_uri(path, null);
        const load = rel => import(uri(GLib.build_filenamev([src, rel])));

        const [{mathjax}, {TeX}, {SVG}, {liteAdaptor}, {RegisterHTMLHandler}] = await Promise.all([
            load('mathjax.js'), load('input/tex.js'), load('output/svg.js'),
            load('adaptors/liteAdaptor.js'), load('handlers/html.js'),
        ]);
        await Promise.all(TEX_PACKAGES.map(([, module]) => load(`input/tex/${module}.js`)));
        const {MathJaxNewcmFont} = await import(uri(GLib.build_filenamev([fontDir, 'svg.js'])));
        const {MathJaxMhchemFontExtension} = await import(uri(GLib.build_filenamev(
            [dir, 'mathjax-mhchem-font-extension', 'mjs', 'svg.js'])));

        // The font loads some characters (ℝ, say) only when first used,
        // by names under its package's dynamicPrefix; MathJax's entity
        // tables come as paths relative to src/mjs.
        mathjax.asyncLoad = file => {
            const dynamic = file.match(/^@mathjax\/mathjax-newcm-font\/m?js\/(.*)$/);
            if (dynamic)
                return import(uri(GLib.build_filenamev([fontDir, dynamic[1]])));
            if (file.startsWith('/'))
                return import(uri(file));
            if (file.startsWith('./'))
                return import(uri(GLib.build_filenamev([src, file])));
            return Promise.reject(new Error(`MathJax asked for ${file}`));
        };
        // \ce's arrows: without this extension they draw as empty boxes.
        // Static: the font class learns it before the output is made.
        MathJaxNewcmFont.addExtension(MathJaxMhchemFontExtension);

        const adaptor = liteAdaptor();
        RegisterHTMLHandler(adaptor);
        const document = mathjax.document('', {
            InputJax: new TeX({
                packages: TEX_PACKAGES.map(([name]) => name),
                // Errors are thrown, so the caller gets MathJax's message
                // instead of a red box in the picture.
                formatError: (_jax, err) => {
                    throw err;
                },
            }),
            OutputJax: new SVG({fontData: MathJaxNewcmFont, fontCache: 'local'}),
        });
        return new MathRenderer(mathjax, adaptor, document);
    }

    constructor(mathjax, adaptor, document) {
        this._mathjax = mathjax;
        this._adaptor = adaptor;
        this._document = document;
    }

    /**
     * The formula as MathJax's SVG element (lite DOM).
     *
     * @throws {FormulaError}
     */
    async _svgNode(tex, display) {
        try {
            const container = await this._mathjax.handleRetriesFor(() =>
                this._document.convert(tex, {display, em: EM_PX, ex: EM_PX / 2}));
            return this._adaptor.firstChild(container);
        } catch (e) {
            // A TeX error (TexError) or MathJax's own; either way its
            // first line is what to show.
            const message = String(e?.message ?? e).split('\n')[0];
            throw new FormulaError(message || 'MathJax could not read this formula');
        } finally {
            // One document for every formula: forget this one's math.
            this._document.clear();
        }
    }

    /**
     * Renders one formula to a PNG.
     *
     * @param {object} request
     * @param {string} request.tex
     * @param {boolean} [request.display] display style (centred, large
     *   operators) instead of inline
     * @param {string} [request.color] '#rrggbb' or '#rrggbbaa'
     * @param {number} [request.scale] 1 draws 1em as EM_PX px
     * @returns {Promise<{png: Uint8Array, width: number, height: number, baseline: number}>}
     * @throws {FormulaError}
     */
    async render({tex, display = false, color = '#000000', scale = 1}) {
        if (typeof tex !== 'string' || !tex.trim())
            throw new FormulaError('The formula is empty');
        if (tex.length > MAX_TEX_LENGTH)
            throw new FormulaError(`The formula is longer than ${MAX_TEX_LENGTH} characters`);
        if (!COLOR.test(color))
            throw new FormulaError(`Not a colour: ${color}`);
        if (!(scale > 0 && scale <= 16))
            throw new FormulaError(`Not a scale: ${scale}`);

        const svg = await this._svgNode(tex, Boolean(display));
        const adaptor = this._adaptor;
        const viewBox = (adaptor.getAttribute(svg, 'viewBox') ?? '').split(/[\s,]+/).map(Number);
        if (viewBox.length !== 4 || viewBox.some(n => !Number.isFinite(n)))
            throw new FormulaError('MathJax drew no picture');
        const size = geometry(viewBox, EM_PX * scale);
        if (size.width > MAX_SIDE_PX || size.height > MAX_SIDE_PX)
            throw new FormulaError('The formula is too large to draw');

        // librsvg sizes the picture from width and height (MathJax gives
        // them in ex), and fills with currentColor from `color`.
        adaptor.setAttribute(svg, 'width', `${size.width}px`);
        adaptor.setAttribute(svg, 'height', `${size.height}px`);
        adaptor.setAttribute(svg, 'viewBox', size.viewBox.join(' '));
        adaptor.setAttribute(svg, 'color', color.slice(0, 7));
        if (color.length === 9)
            adaptor.setAttribute(svg, 'opacity', (parseInt(color.slice(7), 16) / 255).toFixed(3));
        adaptor.removeAttribute(svg, 'style');
        // serializeXML, not innerHTML: librsvg needs well-formed XML.
        const xml = adaptor.serializeXML(svg);

        const handle = Rsvg.Handle.new_from_data(new TextEncoder().encode(xml));
        const pixbuf = handle.get_pixbuf_and_error();
        const [, png] = pixbuf.save_to_bufferv('png', [], []);
        return {png, width: size.width, height: size.height, baseline: size.baseline};
    }

    /** The SVG MathJax makes, as XML (for tests and debugging). */
    async svg(tex, display = false) {
        return this._adaptor.serializeXML(await this._svgNode(tex, display));
    }
}
