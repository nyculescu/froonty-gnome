// SPDX-License-Identifier: GPL-3.0-or-later
// Where each desktop item goes (owner, 2026-11-23: dragged anywhere on a
// picture of the desktop in Settings, beside another as well as under it;
// no corners or shifts). An item keeps a position and a size. Its position
// is per ten thousand of the room it can move in (fine enough for a pixel):
// 0 at the room's left (top) edge, 10000 at its right (bottom) edge, so an item at an edge stays there
// when its size or the screen changes. Items never overlap each other or a
// dock: one in the way is pushed down. Pure; desktopLayer.js puts them on
// screen, desktopPrefs.js draws and drags them.

// The widgets, in the order they are placed when their positions tie.
// Each note pinned to the desktop is an item too: STICKY_PREFIX and its
// name, after the widgets, in the order the notes were pinned.
export const ITEMS = ['markets', 'news', 'system', 'weather'];
export const STICKY_PREFIX = 'sticky:';

export const stickyId = name => `${STICKY_PREFIX}${name}`;
export const isSticky = id => id.startsWith(STICKY_PREFIX);

export const MAX_POSITION = 10000;

// Sizes in logical pixels: a card's content width, and its height cap
// (0: as tall as its content, Markets 8 rows).
export const MIN_WIDTH = 200;
export const MAX_WIDTH = 1200;
export const MIN_HEIGHT = 120;
export const MAX_HEIGHT = 2000;

// Between items, and between an item and a dock.
export const GAP = 12;

// A side dock leaves its strip to the items only with this much room above
// or below it; less, and the strip is the dock's.
export const MIN_DOCK_ROOM = 150;

// A dropped box's edge this close to another's (or the room's) lines up
// with it, as GNOME Settings' Displays page does with screens.
export const SNAP = 24;

// The widgets stack in the top left, in ITEMS order; each sticky starts in
// the top right, under the ones before it.
export const DEFAULT_PLACEMENT = {
    markets: {x: 0, y: 0, width: 360, height: 0},
    news: {x: 0, y: 0, width: 360, height: 420},
    system: {x: 0, y: 0, width: 260, height: 0},
    weather: {x: 0, y: 0, width: 360, height: 0},
};
export const DEFAULT_STICKY = {x: MAX_POSITION, y: 0, width: 300, height: 300};

export const defaultFor = id => ({...(DEFAULT_PLACEMENT[id] ?? DEFAULT_STICKY)});

const clamp = (value, low, high) => Math.max(low, Math.min(value, high));
const position = value => clamp(Math.round(value), 0, MAX_POSITION);

export const overlaps = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width &&
    a.y < b.y + b.height && b.y < a.y + a.height;

/**
 * The placement of the items `ids` from the setting
 * (`widgets-desktop-positions`, id → [x, y, width, height]): defaults for
 * missing or odd entries, values kept in range.
 *
 * @param {object} stored as deepUnpack() gives it
 * @param {string[]} [ids] the widgets and the stickies' ids
 * @returns {object} id → {x, y, width, height}
 */
export function normalizePlacement(stored, ids = ITEMS) {
    const placement = {};
    for (const id of ids) {
        const entry = stored?.[id];
        if (!Array.isArray(entry) || entry.length !== 4 || !entry.every(Number.isFinite)) {
            placement[id] = defaultFor(id);
            continue;
        }
        const [x, y, width, height] = entry;
        placement[id] = {
            x: position(x),
            y: position(y),
            width: clamp(Math.round(width), MIN_WIDTH, MAX_WIDTH),
            height: height > 0 ? clamp(Math.round(height), MIN_HEIGHT, MAX_HEIGHT) : 0,
        };
    }
    return placement;
}

/** The setting's value for `placement` (normalizePlacement's form). */
export function storedPlacement(placement) {
    return Object.fromEntries(Object.keys(placement).map(id => {
        const {x, y, width, height} = placement[id];
        return [id, [x, y, width, height]];
    }));
}

/**
 * The room items go in, and what is in their way. A fixed dock on a side
 * edge reserves its whole strip though it may cover only part of it
 * (owner's choice, 2026-11-23: use the space above it, cut at its top), so
 * with MIN_DOCK_ROOM above or below it the room takes in the strip and the
 * dock itself is in the way. A dock elsewhere is already outside the work
 * area.
 *
 * @param {{work, monitor, dock}} screen rectangles {x, y, width, height};
 *   dock as shown, or null
 * @returns {{area, obstacles: Array}}
 */
export function desktopRoom(screen) {
    // Field by field: the Shell's are boxed rectangles, which spread to {}.
    const plain = r => r && {x: r.x, y: r.y, width: r.width, height: r.height};
    const [work, monitor, dock] = [plain(screen.work), plain(screen.monitor), plain(screen.dock)];
    if (!dock)
        return {area: work, obstacles: []};
    const near = (a, b) => Math.abs(a - b) < 2;
    const workRight = work.x + work.width;
    const monitorRight = monitor.x + monitor.width;
    const left = near(dock.x, monitor.x) && work.x > monitor.x && work.x >= dock.x + dock.width - 2;
    const right = near(dock.x + dock.width, monitorRight) && workRight < monitorRight &&
        workRight <= dock.x + 2;
    const room = Math.max(dock.y - work.y, work.y + work.height - (dock.y + dock.height));
    if ((!left && !right) || room < MIN_DOCK_ROOM)
        return {area: work, obstacles: []};
    const area = left
        ? {x: monitor.x, y: work.y, width: workRight - monitor.x, height: work.height}
        : {x: work.x, y: work.y, width: monitorRight - work.x, height: work.height};
    return {area, obstacles: [dock]};
}

// Where a box of `size` wants to be, from its position in the room.
function wanted(item, size, area) {
    return {
        x: area.x + Math.round(Math.max(0, area.width - size.width) * item.x / MAX_POSITION),
        y: area.y + Math.round(Math.max(0, area.height - size.height) * item.y / MAX_POSITION),
    };
}

// Where an item settles, and the lowest its bottom may go. Something in
// the way that starts below it leaves it the room above, cut to fit, if
// that is at least MIN_HEIGHT (or its height); else it goes down past what
// it would overlap. Without room left below either, it moves right past
// what was in its way at the height it wanted, and tries again.
function settle(spot, size, taken, area) {
    const bottom = area.y + area.height;
    const least = Math.min(size.height, MIN_HEIGHT);
    const box = (x, y) => ({x, y, width: size.width, height: size.height});
    let x = spot.x;
    for (let attempt = 0; attempt <= taken.length; attempt++) {
        let y = spot.y;
        for (let tries = 0; tries <= taken.length && y + least <= bottom; tries++) {
            const hits = taken.filter(other => overlaps(box(x, y), other));
            if (!hits.length)
                return {x, y, limit: bottom};
            const below = Math.min(...hits.map(other => other.y)) - GAP;
            if (hits.every(other => other.y > y) && below - y >= least)
                return {x, y, limit: below};
            y = Math.max(...hits.map(other => other.y + other.height)) + GAP;
        }
        const first = taken.filter(other => overlaps(box(x, spot.y), other));
        const beside = Math.max(...first.map(other => other.x + other.width)) + GAP;
        if (!first.length || beside + size.width > area.x + area.width)
            break;
        x = beside;
    }
    return {...spot, limit: bottom};
}

/**
 * Where each shown item goes, and the height it may take: each at its
 * position, the higher ones first; one that would overlap an item placed
 * before it (or a dock) is cut to fit above it, or goes down past it, or
 * beside it when there is no room below (settle). One cut to fit scrolls.
 *
 * @param {{work, monitor, dock}} screen as desktopRoom takes it
 * @param {Array<{id, x, y, width, height}>} items the shown ones, with
 *   their placement (normalizePlacement)
 * @param {Function} measure (id, cap) → {width, height}: the item's outer
 *   size when it may be at most `cap` tall (its own height cap included)
 * @param {Array<{x, y, width, height}>} [already] boxes already there
 *   (the editor: the shown items, the others placed around them)
 * @returns {Map<string, {x, y, width, height, cap}>}
 */
export function layoutItems(screen, items, measure, already = []) {
    const {area, obstacles} = desktopRoom(screen);
    const bottom = area.y + area.height;
    const taken = [...obstacles, ...already];
    const placed = new Map();
    // A stable sort: ties keep the order given (widgets, then stickies).
    const order = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
    for (const item of order) {
        const own = item.height > 0 ? item.height : Infinity;
        let size = measure(item.id, Math.min(own, area.height));
        const spot = settle(wanted(item, size, area), size, taken, area);
        const cap = Math.max(1, Math.min(own, spot.limit - spot.y));
        if (size.height > cap)
            size = measure(item.id, cap);
        const at = {
            x: clamp(spot.x, area.x, area.x + area.width - size.width),
            y: clamp(spot.y, area.y, bottom - size.height),
            width: size.width,
            height: size.height,
            cap,
        };
        placed.set(item.id, at);
        taken.push(at);
    }
    return placed;
}

/**
 * Where a box dropped at `box` settles (the editor): its edges line up
 * with another box's or the room's within SNAP; dropped over another box,
 * it goes to that box's nearest free side.
 *
 * @param {{x, y, width, height}} box
 * @param {Array<{x, y, width, height}>} others the other shown boxes and
 *   what is in the way (desktopRoom's obstacles)
 * @param {{x, y, width, height}} area desktopRoom's
 * @returns {{x, y, width, height}}
 */
export function snapBox(box, others, area) {
    const {width, height} = box;
    const nearest = (value, targets) => {
        const close = targets.filter(t => Math.abs(t - value) <= SNAP)
            .sort((a, b) => Math.abs(a - value) - Math.abs(b - value));
        return close.length ? close[0] : value;
    };
    const xs = [area.x, area.x + area.width - width,
        ...others.flatMap(o => [o.x, o.x + o.width - width, o.x + o.width + GAP, o.x - GAP - width])];
    const ys = [area.y, area.y + area.height - height,
        ...others.flatMap(o => [o.y, o.y + o.height - height, o.y + o.height + GAP, o.y - GAP - height])];
    const inArea = b => ({
        ...b,
        x: clamp(b.x, area.x, area.x + area.width - width),
        y: clamp(b.y, area.y, area.y + area.height - height),
    });
    let at = inArea({x: nearest(box.x, xs), y: nearest(box.y, ys), width, height});
    const hit = others.find(other => overlaps(at, other));
    if (hit) {
        const free = [
            {x: hit.x - GAP - width, y: at.y},
            {x: hit.x + hit.width + GAP, y: at.y},
            {x: at.x, y: hit.y - GAP - height},
            {x: at.x, y: hit.y + hit.height + GAP},
        ].map(c => ({...c, width, height}))
            .filter(c => c.x >= area.x && c.y >= area.y &&
                c.x + width <= area.x + area.width && c.y + height <= area.y + area.height &&
                !others.some(other => overlaps(c, other)))
            .sort((a, b) => Math.hypot(a.x - at.x, a.y - at.y) - Math.hypot(b.x - at.x, b.y - at.y));
        if (free.length)
            at = free[0];
    }
    return at;
}

/**
 * The position for a box settled at `box` (snapBox): where it is in the
 * room it can move in, per ten thousand.
 *
 * @param {{x, y, width, height}} box
 * @param {{x, y, width, height}} area desktopRoom's
 * @returns {{x, y}}
 */
export function placementFromBox(box, area) {
    const share = (offset, room) => room > 0 ? position(offset / room * MAX_POSITION) : 0;
    return {
        x: share(box.x - area.x, area.width - box.width),
        y: share(box.y - area.y, area.height - box.height),
    };
}
