// SPDX-License-Identifier: GPL-3.0-or-later
// Settings → Widgets → On the desktop: a switch for all desktop items and
// one for each, then a picture of the primary monitor (its top bar and
// dock drawn in) with each item's box where the Shell put it. Drag a box to
// move it anywhere: its edges line up with another's nearby, and dropped
// over another box it goes beside it. Drag any of its edges or corners to
// resize it. Arrow keys move the focused box by 1 % of its room,
// Shift+arrows resize it by 10 px. The selected box's size is below. placement.js keeps the rules; the Shell writes the
// picture's geometry (widgets-desktop-geometry, desktopLayer.js).

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {switchRow} from '../../prefs/rows.js';
import {
    ITEMS, MIN_HEIGHT, STICKY_PREFIX,
    desktopRoom, isSticky, layoutItems, normalizePlacement, placementFromBox, snapBox, storedPlacement,
} from './placement.js';

const KEY = 'widgets-desktop-positions';
const GEOMETRY_KEY = 'widgets-desktop-geometry';
const DESKTOP_KEY = 'widgets-desktop-enabled';
const CANVAS_WIDTH = 560;
// A card's padding and border, outside its content width (.froonty-desktop-widget).
const OUTSIDE = 26;
// The edge a drag resizes from, in the picture's pixels.
const EDGE = 8;
const KEY_SIZE_STEP = 10;
// How long a dropped box waits for the Shell's geometry.
const PENDING_MS = 1500;
// An arrow key's move: 1 % of the box's room (placement.js).
const KEY_MOVE_STEP = 100;
// Heights of items the Shell has not shown yet.
const GUESS = {markets: 440, news: 420, system: 300, weather: 220};
const STICKY_GUESS = 300;
// Without the Shell's geometry: a common screen.
const FALLBACK = {monitor: [0, 0, 1920, 1080], work: [0, 32, 1920, 1048]};

const ITEM = {
    markets: {
        title: () => _('Markets'),
        subtitle: () => _('Needs Markets on, in Settings → Markets'),
        key: 'widgets-markets-pin-desktop',
        keys: [DESKTOP_KEY, 'widgets-markets-pin-desktop', 'markets-enabled'],
    },
    news: {
        title: () => _('Horizon news'),
        subtitle: () => _('Needs Horizon on, in Settings → Horizon'),
        key: 'widgets-news-pin-desktop',
        keys: [DESKTOP_KEY, 'widgets-news-pin-desktop', 'horizon-enabled'],
    },
    weather: {
        title: () => _('Weather'),
        subtitle: () => _('Needs Weather on, in Settings → Weather'),
        key: 'widgets-weather-pin-desktop',
        keys: [DESKTOP_KEY, 'widgets-weather-pin-desktop', 'weather-enabled'],
    },
    system: {
        title: () => _('System'),
        subtitle: () => _('Btop’s readings with their last 30 minutes; choose them under System below'),
        key: 'widgets-system-pin-desktop',
        keys: [DESKTOP_KEY, 'widgets-system-pin-desktop'],
    },
};

// The switch for every note pinned to the desktop; each is an item of its
// own in the picture, "Notes sticky 1, 2, …" in the order they were pinned.
const STICKIES = {
    title: () => _('Notes stickies'),
    subtitle: () => _('Notes you pin with Pin to Desktop, from a note tab\'s right-click menu; each is placed on its own below'),
    key: 'widgets-stickies-on-desktop',
    keys: [DESKTOP_KEY, 'widgets-stickies-on-desktop', 'notes-enabled'],
};

// The geometry's stickies, in pin order (desktopLayer.js writes them so).
const stickyIds = geometry => Object.keys(geometry).filter(isSticky);

/** An item's title: a widget's name, or "Notes sticky N" by pin order. */
function titleOf(id, stickies) {
    if (!isSticky(id))
        return ITEM[id].title();
    return _('Notes sticky %d').replace('%d', String(stickies.indexOf(id) + 1));
}

const CSS = `
.froonty-desktop-picture { padding: 12px; border-radius: 12px; background-color: alpha(currentColor, 0.05); }
.froonty-desktop-box { border-radius: 6px; background-color: var(--accent-bg-color); color: var(--accent-fg-color); }
.froonty-desktop-box.off { background-color: alpha(currentColor, 0.18); color: inherit; }
.froonty-desktop-box.selected { outline: 3px solid alpha(currentColor, 0.8); outline-offset: -3px; }
.froonty-desktop-box label { font-size: smaller; }
`;
let cssAdded = false;

function addCss() {
    if (cssAdded)
        return;
    cssAdded = true;
    const provider = new Gtk.CssProvider();
    provider.load_from_string(CSS);
    Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), provider,
        Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
}

const rect = ([x, y, width, height]) => ({x, y, width, height});

/**
 * The screen and every item's box on it: the shown items where the Shell
 * put them (its geometry), the others where they would go after them.
 *
 * @param {Gio.Settings} settings
 * @returns {{monitor, work, dock, area, obstacles, ids, stickies, placement, boxes: Map, shown: Set}}
 */
export function screenLayout(settings) {
    const geometry = settings.get_value(GEOMETRY_KEY).deepUnpack();
    const known = Boolean(geometry.monitor && geometry.work);
    const monitor = rect(known ? geometry.monitor : FALLBACK.monitor);
    const work = rect(known ? geometry.work : FALLBACK.work);
    const dock = geometry.dock ? rect(geometry.dock) : null;
    // Only the Shell knows the pinned notes: their stickies show as it
    // last wrote them, and not at all while they are off.
    const stickies = stickyIds(geometry);
    const ids = [...ITEMS, ...stickies];
    const placement = normalizePlacement(settings.get_value(KEY).deepUnpack(), ids);
    const shown = new Set(known
        ? ids.filter(id => geometry[id])
        : ITEMS.filter(id => ITEM[id].keys.every(key => settings.get_boolean(key))));
    const measure = (id, cap) => {
        const seen = geometry[id];
        // As the Shell measured it: a card may be wider than its width
        // setting when its content needs it.
        const width = seen ? seen[2] : placement[id].width + OUTSIDE;
        const height = seen ? seen[3] : placement[id].height || (GUESS[id] ?? STICKY_GUESS);
        return {width, height: Math.min(height, cap)};
    };
    const screen = {work, monitor, dock};
    // Shown items exactly where the Shell put them; the others as the
    // rules would place them.
    const boxes = known
        ? new Map([...shown].map(id => [id, rect(geometry[id])]))
        : layoutItems(screen, [...shown].map(id => ({id, ...placement[id]})), measure);
    // Around the shown ones as they really are, never over them.
    const rest = layoutItems(screen, ids.filter(id => !shown.has(id)).map(id => ({id, ...placement[id]})),
        measure, [...boxes.values()]);
    for (const [id, box] of rest)
        boxes.set(id, box);
    const {area, obstacles} = desktopRoom(screen);
    return {monitor, work, dock, area, obstacles, ids, stickies, placement, boxes, shown};
}

/** Changes item `id`'s placement, kept in range (placement.js). */
export function changePlacement(settings, id, change) {
    // Every sticky's place is kept, also while it is not on the desktop.
    const stored = settings.get_value(KEY).deepUnpack();
    const ids = [...new Set([...ITEMS, ...Object.keys(stored).filter(isSticky), id])];
    const placement = normalizePlacement(stored, ids);
    placement[id] = {...placement[id], ...change};
    const kept = storedPlacement(normalizePlacement(storedPlacement(placement), ids));
    settings.set_value(KEY, new GLib.Variant('a{s(iiii)}', kept));
}

/**
 * The change an arrow key makes to a placement: without Shift it moves the
 * box 1 % of its room that way, with Shift it resizes it by KEY_SIZE_STEP.
 *
 * @returns {object|null} the change, or null for another key
 */
export function keyChange({x, y, width, height}, keyval, shift, shownHeight) {
    const dx = {[Gdk.KEY_Left]: -1, [Gdk.KEY_Right]: 1}[keyval] ?? 0;
    const dy = {[Gdk.KEY_Up]: -1, [Gdk.KEY_Down]: 1}[keyval] ?? 0;
    if (!dx && !dy)
        return null;
    if (shift) {
        return dx
            ? {width: width + dx * KEY_SIZE_STEP}
            : {height: Math.max(MIN_HEIGHT, (height || shownHeight) + dy * KEY_SIZE_STEP)};
    }
    return dx ? {x: x + dx * KEY_MOVE_STEP} : {y: y + dy * KEY_MOVE_STEP};
}

/**
 * The page's groups: the switches; the picture (two groups, as a
 * preferences group puts its rows above any other widget in it). Sizes are
 * set on the picture, by dragging an edge or a corner.
 */
export function desktopGroups(settings) {
    addCss();
    const switches = new Adw.PreferencesGroup({
        title: _('On the desktop'),
        description: _('What shows on the desktop, whatever the Widgets tab\'s switch says, and where. Drag a box below anywhere: dropped over another, it goes beside it, and widgets never overlap. Drag any edge or corner to resize it. Arrow keys move the selected box, Shift+arrows resize it.'),
    });
    switches.add(switchRow(settings, DESKTOP_KEY, _('Show widgets on the desktop')));
    for (const item of [...ITEMS.map(id => ITEM[id]), STICKIES]) {
        const row = switchRow(settings, item.key, item.title(), item.subtitle?.() ?? '');
        settings.bind(DESKTOP_KEY, row, 'sensitive', Gio.SettingsBindFlags.GET);
        switches.add(row);
    }
    // The Desktop widgets panic button sets it too.
    const actions = switchRow(settings, 'widgets-desktop-actions', _('Clicks on Markets and Horizon'),
        _('Open an index\'s or a headline\'s page; off, the cards only scroll'));
    settings.bind(DESKTOP_KEY, actions, 'sensitive', Gio.SettingsBindFlags.GET);
    switches.add(actions);
    const reset = new Gtk.Button({label: _('Reset layout'), valign: Gtk.Align.CENTER, css_classes: ['flat']});
    reset.connect('clicked', () => settings.reset(KEY));
    switches.set_header_suffix(reset);

    const pictureGroup = new Adw.PreferencesGroup();
    const drawing = new Gtk.DrawingArea();
    const fixed = new Gtk.Fixed();
    const overlay = new Gtk.Overlay({child: drawing, halign: Gtk.Align.CENTER, hexpand: true});
    overlay.add_overlay(fixed);
    const picture = new Gtk.Box({css_classes: ['froonty-desktop-picture'], halign: Gtk.Align.FILL});
    picture.append(overlay);
    pictureGroup.add(picture);
    pictureGroup.add(new Gtk.Label({
        label: _('Dimmed boxes are not on the desktop now; they show where they would go.'),
        css_classes: ['dim-label'],
        xalign: 0,
        wrap: true,
        margin_top: 6,
    }));
    settings.bind(DESKTOP_KEY, picture, 'sensitive', Gio.SettingsBindFlags.GET);

    let selected = 'markets';
    const write = change => changePlacement(settings, selected, change);
    // A box just dropped, kept where it landed until the Shell's geometry
    // follows (or PENDING_MS), so it does not jump back for a moment.
    let pending = null;
    let pendingId = 0;

    let layout = null;
    let scale = 1;
    // The boxes as render() put them, in drawing order: {id, box, left, top}.
    let placed = [];
    // A drag under way, else null: {item, mode, left, top, width, height}.
    let start = null;
    let focusAfter = false;

    const select = id => {
        if (selected === id)
            return;
        selected = id;
        for (const item of placed) {
            if (item.id === id)
                item.box.add_css_class('selected');
            else
                item.box.remove_css_class('selected');
        }
    };

    // The box under a point of the picture, the topmost first; and which
    // of its edges the point is on.
    const hit = (x, y) => [...placed].reverse().find(item =>
        x >= item.left && x < item.left + item.box.get_width() &&
        y >= item.top && y < item.top + item.box.get_height());
    // Between the picture's pixels ({left, top, width, height}) and the
    // screen's ({x, y, width, height}).
    const toScreen = b => ({
        x: layout.monitor.x + b.left / scale,
        y: layout.monitor.y + b.top / scale,
        width: b.width / scale,
        height: b.height / scale,
    });
    const toPicture = b => ({
        left: Math.round((b.x - layout.monitor.x) * scale),
        top: Math.round((b.y - layout.monitor.y) * scale),
    });
    // The other shown boxes and the dock: what a box must not cover.
    const othersOf = id => [...layout.shown].filter(other => other !== id)
        .map(other => layout.boxes.get(other)).concat(layout.obstacles);
    const keepUntilShell = (id, box) => {
        pending = {id, box};
        if (pendingId)
            GLib.source_remove(pendingId);
        pendingId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PENDING_MS, () => {
            pendingId = 0;
            pending = null;
            render();
            return GLib.SOURCE_REMOVE;
        });
    };

    // The edges a point is near (every side resizes: a box at the
    // screen's right edge is widened from its left), or null inside.
    const edgeOf = (item, x, y) => {
        const width = item.box.get_width();
        const height = item.box.get_height();
        const right = x > item.left + width - EDGE;
        const left = !right && x < item.left + EDGE;
        const bottom = y > item.top + height - EDGE;
        const top = !bottom && y < item.top + EDGE;
        return left || right || top || bottom ? {left, right, top, bottom} : null;
    };
    const cursorOf = edges => {
        if (!edges)
            return 'grab';
        const {left, right, top, bottom} = edges;
        if ((left && top) || (right && bottom))
            return 'nwse-resize';
        if ((right && top) || (left && bottom))
            return 'nesw-resize';
        return left || right ? 'ew-resize' : 'ns-resize';
    };
    // The box a resize gives, in the picture's pixels.
    const resized = ({left, top, width, height, edges}, dx, dy) => ({
        left: edges.left ? left + Math.min(dx, width - 16) : left,
        top: edges.top ? top + Math.min(dy, height - 16) : top,
        width: Math.max(16, width + (edges.left ? -dx : edges.right ? dx : 0)),
        height: Math.max(16, height + (edges.top ? -dy : edges.bottom ? dy : 0)),
    });

    // One gesture on the picture, which stays put: a gesture on the box
    // itself measures from the box, and moving the box under the pointer
    // fed back into the drag (the boxes shook).
    const motion = new Gtk.EventControllerMotion();
    motion.connect('motion', (_c, x, y) => {
        if (start)
            return;
        const item = hit(x, y);
        fixed.set_cursor_from_name(item ? cursorOf(edgeOf(item, x, y)) : null);
    });
    fixed.add_controller(motion);

    const drag = new Gtk.GestureDrag();
    drag.connect('drag-begin', (_g, x, y) => {
        const item = hit(x, y);
        if (!item) {
            start = null;
            return;
        }
        select(item.id);
        item.box.grab_focus();
        const edges = edgeOf(item, x, y);
        start = {item, mode: edges ? 'resize' : 'move', edges, left: item.left, top: item.top,
            width: item.box.get_width(), height: item.box.get_height()};
        if (!edges)
            fixed.set_cursor_from_name('grabbing');
    });
    drag.connect('drag-update', (_g, dx, dy) => {
        if (!start)
            return;
        const {item, mode} = start;
        if (mode === 'move') {
            // Where it would settle, shown as it is dragged: lined up with
            // a box nearby, beside one it is over, clear of the top bar and
            // the dock.
            start.snapped = snapBox(toScreen({...start, left: start.left + dx, top: start.top + dy}),
                othersOf(item.id), layout.area);
            const at = toPicture(start.snapped);
            fixed.move(item.box, at.left, at.top);
            return;
        }
        const box = resized(start, dx, dy);
        fixed.move(item.box, box.left, box.top);
        item.box.width_request = Math.round(box.width);
        item.box.height_request = Math.round(box.height);
    });
    drag.connect('drag-end', (_g, dx, dy) => {
        if (!start)
            return;
        const {item, mode, edges, snapped} = start;
        const screenBox = mode === 'move' ? snapped : toScreen(resized(start, dx, dy));
        start = null;
        fixed.set_cursor_from_name(null);
        focusAfter = true;
        if ((!dx && !dy) || !screenBox) {
            render();
            return;
        }
        keepUntilShell(item.id, screenBox);
        if (mode === 'move') {
            write(placementFromBox(screenBox, layout.area));
            return;
        }
        // From the left or the top, the box moves as well: its far edge stays.
        const change = {};
        if (edges.left || edges.right)
            change.width = Math.round(screenBox.width - OUTSIDE);
        if (edges.top || edges.bottom)
            change.height = Math.round(screenBox.height);
        const at = placementFromBox(screenBox, layout.area);
        if (edges.left)
            change.x = at.x;
        if (edges.top)
            change.y = at.y;
        write(change);
    });
    fixed.add_controller(drag);

    const itemBox = id => {
        const at = layout.boxes.get(id);
        const box = new Gtk.Box({
            css_classes: ['froonty-desktop-box'],
            focusable: true,
            width_request: Math.max(16, Math.round(at.width * scale)),
            height_request: Math.max(16, Math.round(at.height * scale)),
            tooltip_text: isSticky(id)
                ? `${titleOf(id, layout.stickies)}: ${id.slice(STICKY_PREFIX.length)}`
                : titleOf(id, layout.stickies),
        });
        // One line, cut short: a label never makes a box wider than its item.
        box.append(new Gtk.Label({label: titleOf(id, layout.stickies), hexpand: true,
            ellipsize: Pango.EllipsizeMode.END, max_width_chars: 1, margin_start: 4, margin_end: 4}));
        if (!layout.shown.has(id))
            box.add_css_class('off');
        if (id === selected)
            box.add_css_class('selected');
        const keys = new Gtk.EventControllerKey();
        keys.connect('key-pressed', (_c, keyval, _code, state) => {
            const change = keyChange(layout.placement[id], keyval,
                Boolean(state & Gdk.ModifierType.SHIFT_MASK), Math.round(at.height));
            if (!change)
                return false;
            select(id);
            focusAfter = true;
            write(change);
            return true;
        });
        box.add_controller(keys);
        const focus = new Gtk.EventControllerFocus();
        focus.connect('enter', () => select(id));
        box.add_controller(focus);
        return box;
    };

    const render = () => {
        if (start)
            return;
        layout = screenLayout(settings);
        if (pending)
            layout.boxes.set(pending.id, pending.box);
        scale = CANVAS_WIDTH / layout.monitor.width;
        const {monitor, work, dock} = layout;
        drawing.set_content_width(CANVAS_WIDTH);
        drawing.set_content_height(Math.round(monitor.height * scale));
        drawing.set_draw_func((_area, cr) => {
            const fill = (r, alpha) => {
                cr.setSourceRGBA(0.5, 0.5, 0.5, alpha);
                cr.rectangle((r.x - monitor.x) * scale, (r.y - monitor.y) * scale, r.width * scale, r.height * scale);
                cr.fill();
            };
            fill(monitor, 0.18);
            fill({x: monitor.x, y: monitor.y, width: monitor.width, height: work.y - monitor.y}, 0.7);
            if (dock)
                fill(dock, 0.6);
            cr.$dispose();
        });
        for (let child = fixed.get_first_child(); child; child = fixed.get_first_child())
            fixed.remove(child);
        // A sticky selected and since unpinned: back to the first widget.
        if (!layout.ids.includes(selected))
            selected = 'markets';
        placed = layout.ids.map(id => {
            const at = layout.boxes.get(id);
            const item = {id, box: itemBox(id),
                left: Math.round((at.x - monitor.x) * scale), top: Math.round((at.y - monitor.y) * scale)};
            fixed.put(item.box, item.left, item.top);
            return item;
        });
        if (focusAfter) {
            focusAfter = false;
            placed.find(item => item.id === selected)?.box.grab_focus();
        }
    };

    for (const key of new Set([KEY, ...ITEMS.flatMap(id => ITEM[id].keys), ...STICKIES.keys]))
        settings.connect(`changed::${key}`, render);
    // The Shell placed it: the box as it really is.
    settings.connect(`changed::${GEOMETRY_KEY}`, () => {
        pending = null;
        render();
    });
    pictureGroup.connect('destroy', () => {
        if (pendingId)
            GLib.source_remove(pendingId);
        pendingId = 0;
    });
    render();
    return [switches, pictureGroup];
}
