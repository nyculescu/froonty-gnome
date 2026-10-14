// SPDX-License-Identifier: GPL-3.0-or-later
// Flow based rendered Markdown view for the Notes island. Block pictures are
// ordinary children in the vertical layout, so following text can never
// occupy the same area as a table, image, or diagram.

import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {toggleTask} from '../render.js';
import {contentOf} from './island.js';

function escapeMarkup(text) {
    return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function inlineMarkup(text) {
    return escapeMarkup(text)
        .replace(/`([^`\n]+)`/g, '<tt>$1</tt>')
        .replace(/\*\*(\S(?:.*?\S)?)\*\*/g, '<b>$1</b>')
        .replace(/__(\S(?:.*?\S)?)__/g, '<b>$1</b>')
        .replace(/~~(\S(?:.*?\S)?)~~/g, '<s>$1</s>')
        .replace(/(?<![\w*])\*(\S(?:.*?\S)?)\*(?![\w*])/g, '<i>$1</i>')
        .replace(/(?<![\w_])_(\S(?:.*?\S)?)_(?![\w_])/g, '<i>$1</i>')
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<u>$1</u>');
}

export class IslandMarkdownPreview {
    constructor(entry) {
        this._entry = entry;
        this.widget = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: false,
            style_class: 'froonty-notes-editor froonty-notes-rendered',
        });
        this.widget.visible = false;
        this._editable = true;
        this._wrap = true;
    }

    setEditable(editable) {
        editable = Boolean(editable);
        if (editable === this._editable)
            return;
        this._editable = editable;
        this.update(this._text ?? '', this._pictures ?? []);
    }

    setWrap(wrap) {
        wrap = Boolean(wrap);
        if (wrap === this._wrap)
            return;
        this._wrap = wrap;
        this.update(this._text ?? '', this._pictures ?? []);
    }

    update(text, pictures) {
        this._text = text;
        this._pictures = pictures;
        for (const child of this.widget.get_children())
            child.destroy();

        const blocks = [...pictures].sort((a, b) => a.start - b.start);
        let at = 0;
        for (const block of blocks) {
            this._addText(text.slice(at, block.start), at);
            this._addPicture(block);
            at = block.end;
        }
        this._addText(text.slice(at), at);
    }

    _addText(source, sourceOffset) {
        if (!source)
            return;
        let lineOffset = 0;
        const lines = source.split('\n');
        let inFence = false;
        for (const line of lines) {
            const absolute = sourceOffset + lineOffset;
            lineOffset += line.length + 1;
            if (/^\s*```/.test(line)) {
                inFence = !inFence;
                continue;
            }
            if (!line.trim())
                continue;
            const task = /^(\s*[-*+]\s+\[([ xX])\]\s+)(.*)$/.exec(line);
            if (task && !inFence) {
                this._addTask(task, absolute);
                continue;
            }
            let body = line;
            let style = '';
            const heading = /^(#{1,6})\s+(.*)$/.exec(body);
            if (heading) {
                body = heading[2];
                style = `font-weight: bold; font-size: ${Math.max(1, 1.45 - heading[1].length * 0.07)}em;`;
            } else if (/^\s*>/.test(body)) {
                body = body.replace(/^\s*>\s?/, '');
                style = 'font-style: italic; color: #888;';
            } else if (/^\s*[-*+]\s+/.test(body)) {
                body = body.replace(/^\s*[-*+]\s+/, '•  ');
            } else if (/^\s*\d+[.)]\s+/.test(body)) {
                body = body.replace(/^(\s*)(\d+[.)])\s+/, '$1$2  ');
            }
            if (inFence)
                style = 'font-family: monospace;';
            const label = new St.Label({
                x_expand: true,
                y_align: Clutter.ActorAlign.START,
                style: `margin: 0; padding: 0; ${style}`,
                text: '',
            });
            label.clutter_text.line_wrap = this._wrap;
            label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
            label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            label.clutter_text.set_markup(inlineMarkup(body));
            this.widget.add_child(label);
        }
    }

    _addTask(match, lineOffset) {
        const indent = match[1].search(/[-*+]/);
        const row = new St.BoxLayout({
            x_expand: true,
            style: `margin: 0 0 0 ${Math.max(0, indent) * 8}px; padding: 0;`,
        });
        const boxOffset = lineOffset + match[1].indexOf('[');
        const checked = match[2].toLowerCase() === 'x';
        const button = new St.Button({
            reactive: this._editable,
            can_focus: this._editable,
            label: checked ? '✓' : '',
            style: checked
                ? 'width: 22px; height: 22px; padding: 0; margin: 0 7px 0 0; border: 2px solid #a9330c; border-radius: 4px; background-color: #d54b17; color: white;'
                : 'width: 22px; height: 22px; padding: 0; margin: 0 7px 0 0; border: 2px solid #444; border-radius: 4px; background-color: #fffdf0; color: #222;',
        });
        button.connect('clicked', () => {
            if (!this._editable)
                return;
            const replacement = toggleTask(this._entry.clutter_text.text, boxOffset);
            if (replacement !== null)
                this._entry.clutter_text.text = replacement;
        });
        row.add_child(button);
        const label = new St.Label({
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style: match[2].toLowerCase() === 'x' ? 'color: #888; text-decoration: line-through;' : '',
        });
        label.clutter_text.line_wrap = this._wrap;
        label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        label.clutter_text.set_markup(inlineMarkup(match[3]));
        row.add_child(label);
        this.widget.add_child(row);
    }

    _addPicture(block) {
        if (block.state !== 'ready') {
            const label = new St.Label({
                text: block.state === 'pending' ? `Rendering ${block.kind}…`
                    : `Could not render ${block.kind}`,
                x_align: Clutter.ActorAlign.START,
                style: 'color: #888; margin: 4px 0;'
            });
            this.widget.add_child(label);
            return;
        }
        const maxWidth = block.kind === 'mermaid' ? 380
            : block.kind === 'image' ? 340 : 620;
        const maxHeight = block.kind === 'mermaid' || block.kind === 'image' ? 320 : 420;
        const scale = Math.min(1, maxWidth / block.width, maxHeight / block.height);
        const width = Math.max(1, Math.round(block.width * scale));
        const height = Math.max(1, Math.round(block.height * scale));
        const content = contentOf(block.png, width, height);
        if (!content) {
            this.widget.add_child(new St.Label({text: `Could not display ${block.kind}`}));
            return;
        }
        const picture = new St.Widget({width, height, x_expand: false,
            x_align: Clutter.ActorAlign.START, style: 'margin: 2px 0;'});
        picture.content = content;
        picture.content_gravity = Clutter.ContentGravity.RESIZE_ASPECT;
        picture.set_size(width, height);
        this.widget.add_child(picture);
    }
}
