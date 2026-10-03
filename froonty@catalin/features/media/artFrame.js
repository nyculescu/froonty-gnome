// SPDX-License-Identifier: GPL-3.0-or-later
// A cover tile: the decoded cover (St.ImageContent, as GNOME Shell's
// screenshot notification makes one), rounded corners, and a halo in the
// cover's colour. Clutter has no rounded clip, so a mask paints the
// corners in the colour behind the tile (the island's black, or the
// pill's colour, which changes on hover).
//
//   frame   St.Widget, BinLayout: halo (box-shadow) and the pause scale
//    ├ placeholder  the app's icon (or a note) on a faint square
//    ├ image        St.Widget with the cover as content
//    └ mask         St.DrawingArea painting the corners
//
// Decorative to assistive technology; the button around it (if any) is
// what is named.

import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import St from 'gi://St';

import {tintCss} from './model.js';

const PAUSE_SCALE = 0.94;
const PAUSE_MS = 300;

/** The island's background behind the expanded tab: always black. */
export const BLACK = () => ({red: 0, green: 0, blue: 0, alpha: 255});

export const ArtFrame = GObject.registerClass(
class ArtFrame extends St.Widget {
    /**
     * @param {object} params
     * @param {Function} params.background () → {red, green, blue, alpha}
     *   (0-255) behind the tile, for the corners
     * @param {boolean} [params.halo] draw the coloured halo
     */
    _init({background = BLACK, halo = true} = {}) {
        super._init({
            style_class: 'froonty-media-art',
            layout_manager: new Clutter.BinLayout(),
            accessible_role: Atk.Role.REDUNDANT_OBJECT,
            pivot_point: new Graphene.Point({x: 0.5, y: 0.5}),
            y_align: Clutter.ActorAlign.CENTER,
            // Set, not computed: its layers expand inside it, and Clutter
            // would pass that up, stretching the tile in its row.
            x_expand: false,
            y_expand: false,
        });
        this._background = background;
        this._halo = halo;
        this._side = 0;
        this._radius = 0;
        this._tint = null;
        this._paused = false;
        this.hasImage = false;
        this._pixbuf = null;

        this._placeholder = new St.Widget({
            style_class: 'froonty-media-art-placeholder',
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });
        this._placeholderIcon = new St.Icon({
            icon_name: 'audio-x-generic-symbolic',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: true,
        });
        this._placeholder.add_child(this._placeholderIcon);
        this.add_child(this._placeholder);

        this._image = new St.Widget({
            x_expand: true,
            y_expand: true,
            visible: false,
            content_gravity: Clutter.ContentGravity.RESIZE_ASPECT,
        });
        this.add_child(this._image);

        this._mask = new St.DrawingArea({x_expand: true, y_expand: true});
        this._mask.connect('repaint', area => this._paintMask(area));
        this.add_child(this._mask);
    }

    /**
     * @param {number} side px
     * @param {number} radius px
     */
    setSize(side, radius) {
        if (side === this._side && radius === this._radius)
            return;
        this._side = side;
        this._radius = radius;
        this.set_size(side, side);
        this._placeholderIcon.icon_size = Math.max(8, Math.round(side * 0.5));
        this._style();
        this._mask.queue_repaint();
    }

    /** The corners' colour changed (the pill's hover). */
    repaintCorners() {
        this._mask.queue_repaint();
    }

    /**
     * @param {?GdkPixbuf.Pixbuf} pixbuf null shows the placeholder
     * @param {?Gio.Icon} appIcon the placeholder's icon (else a note)
     */
    setImage(pixbuf, appIcon = null) {
        // The same cover again (a sync for something else): not re-uploaded.
        if (pixbuf && pixbuf === this._pixbuf) {
            this._setPlaceholderIcon(appIcon);
            return;
        }
        this._pixbuf = pixbuf;
        if (pixbuf) {
            const context = global.stage.context.get_backend().get_cogl_context();
            const content = St.ImageContent.new_with_preferred_size(pixbuf.width, pixbuf.height);
            content.set_bytes(context, pixbuf.read_pixel_bytes(),
                pixbuf.get_has_alpha() ? Cogl.PixelFormat.RGBA_8888 : Cogl.PixelFormat.RGB_888,
                pixbuf.width, pixbuf.height, pixbuf.rowstride);
            this._image.content = content;
        } else {
            this._image.content = null;
        }
        this.hasImage = Boolean(pixbuf);
        this._image.visible = this.hasImage;
        this._placeholder.visible = !this.hasImage;
        this._setPlaceholderIcon(appIcon);
    }

    _setPlaceholderIcon(appIcon) {
        if (appIcon) {
            if (!appIcon.equal(this._placeholderIcon.gicon))
                this._placeholderIcon.gicon = appIcon;
        } else if (this._placeholderIcon.icon_name !== 'audio-x-generic-symbolic') {
            this._placeholderIcon.icon_name = 'audio-x-generic-symbolic';
        }
    }

    /** @param {?object} tint model.tint, or null (no halo) */
    setTint(tint) {
        this._tint = tint;
        this._style();
    }

    /** The tint the halo uses now (tests). */
    get tint() {
        return this._tint;
    }

    /**
     * Shrinks slightly while paused.
     *
     * @param {boolean} paused
     * @param {boolean} [animate]
     */
    setPaused(paused, animate = true) {
        if (paused === this._paused)
            return;
        this._paused = paused;
        const scale = paused ? PAUSE_SCALE : 1;
        this.remove_transition('scale-x');
        this.remove_transition('scale-y');
        if (animate && St.Settings.get().enable_animations) {
            this.ease({
                scale_x: scale,
                scale_y: scale,
                duration: PAUSE_MS,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        } else {
            this.set_scale(scale, scale);
        }
    }

    _style() {
        const radius = `border-radius: ${this._radius}px;`;
        // St draws a box-shadow only around a visible background: the
        // tile's is the colour behind it, so only the halo shows.
        let halo = '';
        if (this._halo && this._tint) {
            const {red, green, blue} = this._background();
            halo = `background-color: rgb(${red}, ${green}, ${blue}); ` +
                `box-shadow: 0 7px 20px ${tintCss(this._tint, 0.42)};`;
        }
        this.style = `${radius} ${halo}`;
        this._placeholder.style = radius;
    }

    // Paints everything outside the rounded square in the background colour.
    _paintMask(area) {
        const cr = area.get_context();
        const [width, height] = area.get_surface_size();
        const r = Math.min(this._radius, width / 2, height / 2);
        const {red, green, blue, alpha} = this._background();
        cr.setSourceRGBA(red / 255, green / 255, blue / 255, alpha / 255);
        cr.setFillRule(1); // EVEN_ODD
        cr.rectangle(0, 0, width, height);
        cr.newSubPath();
        cr.arc(width - r, r, r, -Math.PI / 2, 0);
        cr.arc(width - r, height - r, r, 0, Math.PI / 2);
        cr.arc(r, height - r, r, Math.PI / 2, Math.PI);
        cr.arc(r, r, r, Math.PI, 3 * Math.PI / 2);
        cr.closePath();
        cr.fill();
        cr.$dispose();
    }
});
