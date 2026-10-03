// SPDX-License-Identifier: GPL-3.0-or-later
// A GNOME popup menu under an actor of the island, for features' context
// menus (e.g. a note tab's labels). It is GNOME Shell's own PopupMenu, with
// its arrow, theme, keyboard handling and modal grab, and lives only while
// open: closing destroys it.
//
//   const menu = new ContextMenu(anchor, {styleClass, onClosed});
//   menu.addTitle('…'); menu.addEntry({…}); menu.addToggle('…', true, on => …);
//   menu.open();
//
// Items can be flipped or acted on without closing the menu: toggles and
// actions do not emit 'activate', which would close it
// (PopupMenuBase.itemActivated). Escape or a click outside closes only the
// menu; Main.popModal() gives the key focus back to where it was.
//
// The anchor must not be a widget that takes the key focus itself: a
// PopupMenu takes over its source's Space and Return (to toggle itself).

import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

// GNOME's menu items take the key focus when the pointer enters them. A
// menu that opens under a resting pointer (opened from the keyboard) would
// then take it from the entry before anyone moved: items follow the
// pointer only once it has moved over the menu (`pointerMoved`).
function followPointer(item, pointerMoved) {
    item.connect('notify::hover', () => {
        if (pointerMoved())
            item.active = item.hover;
    });
}

// Class definitions only: no objects are made at import time.
const ToggleItem = GObject.registerClass(
class FroontyToggleItem extends PopupMenu.PopupBaseMenuItem {
    _init(text, checked, onToggled, pointerMoved) {
        super._init({style_class: 'froonty-menu-toggle', hover: false});
        followPointer(this, pointerMoved);
        this.accessible_role = Atk.Role.CHECK_MENU_ITEM;
        this.label = new St.Label({text, y_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this.add_child(this.label);
        this.label_actor = this.label;
        this._onToggled = onToggled;
        this.setChecked(checked);
    }

    get checked() {
        return this._checked;
    }

    // A check mark, and Atk's CHECKED state with it.
    setChecked(checked) {
        this._checked = checked;
        this.setOrnament(checked ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
    }

    // Click, Space or Return: flip, and keep the menu open.
    activate(_event) {
        this.setChecked(!this._checked);
        this._onToggled(this._checked);
    }
});

const ActionItem = GObject.registerClass(
class FroontyActionItem extends PopupMenu.PopupBaseMenuItem {
    _init(text, onActivate, pointerMoved) {
        super._init({style_class: 'froonty-menu-action', hover: false});
        followPointer(this, pointerMoved);
        // Lines up with the toggles' labels.
        this.setOrnament(PopupMenu.Ornament.NONE);
        this.label = new St.Label({text, y_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this.add_child(this.label);
        this.label_actor = this.label;
        this._onActivate = onActivate;
    }

    activate(_event) {
        this._onActivate();
    }
});

const EntryItem = GObject.registerClass(
class FroontyEntryItem extends PopupMenu.PopupBaseMenuItem {
    _init(hint) {
        super._init({reactive: false, activate: false, can_focus: false});
        this.entry = new St.Entry({
            style_class: 'froonty-menu-entry',
            hint_text: hint,
            can_focus: true,
            x_expand: true,
        });
        this.add_child(this.entry);
    }
});

/** Items: a section, or the menu itself. */
class Items {
    constructor(menu, pointerMoved) {
        this._menu = menu;
        this._pointerMoved = pointerMoved;
        // The items added here, in order (PopupMenuBase lists them only
        // through a private method).
        this._items = [];
    }

    /**
     * @returns {{item: object, setChecked: Function, readonly checked: boolean}}
     */
    addToggle(text, checked, onToggled) {
        return this._add(new ToggleItem(text, checked, onToggled, this._pointerMoved));
    }

    addAction(text, onActivate) {
        return this._add(new ActionItem(text, onActivate, this._pointerMoved));
    }

    /** A muted line that is not an item (not focusable). */
    addHint(text) {
        const item = new PopupMenu.PopupMenuItem(text, {reactive: false, can_focus: false});
        item.add_style_class_name('froonty-menu-hint');
        return this._add(item);
    }

    removeAll() {
        this._menu.removeAll();
        this._items = [];
    }

    get items() {
        return [...this._items];
    }

    _add(item) {
        this._menu.addMenuItem(item);
        this._items.push(item);
        return item;
    }
}

export class ContextMenu extends Items {
    /**
     * @param {Clutter.Actor} source the menu hangs below it
     * @param {object} [params]
     * @param {string} [params.styleClass] added to the menu
     * @param {Function} [params.onClosed] once, when it closes or is destroyed
     */
    constructor(source, {styleClass = null, onClosed = null} = {}) {
        const menu = new PopupMenu.PopupMenu(source, 0.5, St.Side.TOP);
        let moved = false;
        super(menu, () => moved);
        menu.actor.connect('captured-event', (_actor, event) => {
            if (event.type() === Clutter.EventType.MOTION)
                moved = true;
            return Clutter.EVENT_PROPAGATE;
        });
        this._onClosed = onClosed;
        this._actor = menu.actor;
        if (styleClass)
            menu.actor.add_style_class_name(styleClass);
        Main.uiGroup.add_child(menu.actor);
        menu.actor.hide();
        // A manager of its own: the modal grab while open, Escape and
        // clicks outside.
        this._manager = new PopupMenu.PopupMenuManager(source);
        this._manager.addMenu(menu);
        // Closed (Escape, a click outside, close()): gone.
        this._closedId = menu.connect('menu-closed', () => this.destroy());
    }

    get isOpen() {
        return this._menu?.isOpen ?? false;
    }

    /** The menu's actor (a BoxPointer), for tests and positioning checks. */
    get actor() {
        return this._actor;
    }

    /** A muted title line (plain text, not markup). */
    addTitle(text) {
        const item = new PopupMenu.PopupMenuItem(text, {reactive: false, can_focus: false});
        item.add_style_class_name('froonty-menu-title');
        return this._add(item);
    }

    /**
     * A text entry.
     *
     * @param {object} params
     * @param {string} params.hint
     * @param {Function} [params.onChanged] (text)
     * @param {Function} [params.onActivate] Enter
     * @param {Function} [params.onDown] Down arrow
     * @returns {{entry: St.Entry}}
     */
    addEntry({hint, onChanged = null, onActivate = null, onDown = null}) {
        const item = this._add(new EntryItem(hint));
        const text = item.entry.clutter_text;
        text.connect('text-changed', () => onChanged?.(item.entry.text));
        text.connect('activate', () => onActivate?.(item.entry.text));
        text.connect('key-press-event', (_actor, event) => {
            if (event.get_key_symbol() !== Clutter.KEY_Down || !onDown)
                return Clutter.EVENT_PROPAGATE;
            onDown();
            return Clutter.EVENT_STOP;
        });
        return {entry: item.entry};
    }

    /** A section whose items can be replaced as a group. */
    addSection() {
        const section = this._add(new PopupMenu.PopupMenuSection());
        return new Items(section, this._pointerMoved);
    }

    open() {
        this._menu.open(BoxPointer.PopupAnimation.FULL);
    }

    close() {
        this._menu?.close(BoxPointer.PopupAnimation.FULL);
    }

    // Idempotent: the menu is let go first. onClosed runs once, first. The
    // menu's destroy() closes it, which pops the modal grab (Main.popModal
    // restores the focus) and would emit 'menu-closed' again, so that
    // handler goes before; destroying its actor removes it from the
    // manager, the focus manager and uiGroup.
    destroy() {
        const menu = this._menu;
        if (!menu)
            return;
        this._menu = null;
        menu.disconnect(this._closedId);
        this._onClosed?.();
        menu.destroy();
    }
}
