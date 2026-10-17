// SPDX-License-Identifier: GPL-3.0-or-later
// A rendered Mermaid diagram edited in place in All notes
// (allNotesStyler.js, "Edit Mermaid code"): its code beside its picture,
// drawn again once typing pauses (mermaidEdit.js), or either alone.
//
//   [Code|Split|Preview]
//   ┌──────────────┐  ┌──────────────┐
//   │ flowchart TD │  │   A ──▶ B    │   a wide picture scrolls sideways
//   │ A-->B        │  └──────────────┘
//   └──────────────┘   Not drawn: …       or why it could not be drawn
//                               [Cancel] [Done]
//
// Enter starts a new line (it is code), Ctrl+Enter is Done, Escape cancels.

import Gdk from 'gi://Gdk';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {DiagramDraft, LAYOUTS, mermaidLayout, setMermaidLayout} from './mermaidEdit.js';

const ENTER = [Gdk.KEY_Return, Gdk.KEY_KP_Enter, Gdk.KEY_ISO_Enter];

export class MermaidEditor {
    /**
     * @param {string} code the diagram's code; `code` is the edited one
     * @param {number} width the editor's width
     * @param {Function} draw (source) → a promise of its picture
     *   ({png, width, height, warnings}); rejects with the reason
     * @param {Function} onDone () Done or Ctrl+Enter
     * @param {Function} onCancel () Cancel or Escape
     */
    constructor(code, width, draw, onDone, onCancel) {
        this.code = code;
        this._field = new Gtk.TextView({
            monospace: true, wrap_mode: Gtk.WrapMode.WORD_CHAR,
            top_margin: 6, bottom_margin: 6, left_margin: 6, right_margin: 6,
        });
        const buffer = this._field.buffer;
        buffer.text = code;
        buffer.place_cursor(buffer.get_start_iter());
        const codePane = new Gtk.Frame({
            child: new Gtk.ScrolledWindow({
                child: this._field,
                hscrollbar_policy: Gtk.PolicyType.NEVER,
                propagate_natural_height: true,
                min_content_height: 80,
                max_content_height: 480,
            }),
            valign: Gtk.Align.START,
        });

        this._picture = new Gtk.Picture({can_shrink: false, halign: Gtk.Align.START, valign: Gtk.Align.START});
        this._caption = new Gtk.Label({label: _('Rendering diagram…'), xalign: 0, wrap: true,
            wrap_mode: Pango.WrapMode.WORD_CHAR, css_classes: ['dim-label']});
        const preview = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 4, valign: Gtk.Align.START});
        preview.append(new Gtk.ScrolledWindow({
            child: this._picture,
            vscrollbar_policy: Gtk.PolicyType.NEVER,
            propagate_natural_height: true,
        }));
        preview.append(this._caption);

        // Halves of the width, side by side; one alone takes all of it.
        const panes = new Gtk.Box({spacing: 8, homogeneous: true});
        panes.append(codePane);
        panes.append(preview);

        const switcher = new Gtk.Box({css_classes: ['linked'], halign: Gtk.Align.START});
        const names = {code: _('Code'), split: _('Split'), preview: _('Preview')};
        const choose = layout => {
            setMermaidLayout(layout);
            codePane.visible = layout !== 'preview';
            preview.visible = layout !== 'code';
        };
        let first = null;
        for (const layout of LAYOUTS) {
            const toggle = new Gtk.ToggleButton({label: names[layout], group: first,
                active: layout === mermaidLayout()});
            toggle.connect('toggled', () => toggle.active && choose(layout));
            first ??= toggle;
            switcher.append(toggle);
        }
        choose(mermaidLayout());

        const buttons = new Gtk.Box({spacing: 6});
        const cancel = new Gtk.Button({label: _('Cancel'), hexpand: true, halign: Gtk.Align.END});
        cancel.connect('clicked', () => onCancel());
        this._done = new Gtk.Button({label: _('Done'), css_classes: ['suggested-action']});
        this._done.connect('clicked', () => onDone());
        buttons.append(cancel);
        buttons.append(this._done);

        this.widget = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL, spacing: 6,
            css_classes: ['card'], width_request: width,
            margin_top: 4, margin_bottom: 4,
        });
        const inner = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6,
            margin_start: 8, margin_end: 8, margin_top: 8, margin_bottom: 8});
        inner.append(switcher);
        inner.append(panes);
        inner.append(buttons);
        this.widget.append(inner);

        const keys = new Gtk.EventControllerKey();
        keys.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
        keys.connect('key-pressed', (_controller, keyval, _keycode, state) => {
            if (keyval === Gdk.KEY_Escape)
                onCancel();
            else if (ENTER.includes(keyval) && state & Gdk.ModifierType.CONTROL_MASK)
                onDone();
            else
                return false;
            return true;
        });
        this.widget.add_controller(keys);

        this._draft = new DiagramDraft(draw, result => this._show(result));
        buffer.connect('changed', () => {
            this.code = buffer.text;
            this._draft.set(this.code);
        });
        this._draft.set(code, true);
    }

    /** Gives the key focus to the code, or to Done while it is hidden. */
    focus() {
        (this._field.get_mapped() ? this._field : this._done).grab_focus();
    }

    /** Stops drawing: the editor is gone. */
    close() {
        this._draft.destroy();
    }

    // The latest code's picture, and under it what it left out; a failure
    // says why under the last picture, faded.
    _show({picture, error}) {
        let texture = null;
        try {
            texture = picture ? Gdk.Texture.new_from_bytes(new GLib.Bytes(picture.png)) : null;
        } catch {}
        if (texture)
            this._picture.paintable = texture;
        this._picture.opacity = texture ? 1 : 0.5;
        const warnings = texture ? picture.warnings : [];
        const reason = texture ? null : error ?? _('the picture could not be read');
        const caption = this._caption;
        caption.label = reason ? _('Could not render diagram: %s').format(reason)
            : _('Not drawn: %s').format(warnings[0] ?? '');
        caption.css_classes = reason ? [] : ['dim-label'];
        caption.tooltip_text = warnings.length ? warnings.join('\n') : null;
        caption.visible = Boolean(reason || warnings.length);
    }
}
