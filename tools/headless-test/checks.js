// SPDX-License-Identifier: GPL-3.0-or-later
// Froonty headless test checks. Loaded INSIDE the isolated test gnome-shell
// by run.sh via org.gnome.Shell.Eval + dynamic import().
//
// Reaches into Shell and Froonty private fields on purpose. This is a test
// probe, not product code.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {ExtensionState} from 'resource:///org/gnome/shell/misc/extensionUtils.js';

const UUID = 'froonty@catalin';
const SETTLE_MS = 150;

const results = [];

function check(name, ok, detail = '') {
    results.push({name, ok: Boolean(ok), detail: String(detail)});
}

const sleep = ms => new Promise(resolve => {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    });
});

const extension = () => Main.extensionManager.lookup(UUID);
const stateName = () => {
    const state = extension()?.state;
    return Object.keys(ExtensionState).find(k => ExtensionState[k] === state) ?? `${state}`;
};
const island = () => extension()?.stateObj?._island ?? null;
const settings = () => extension()?.stateObj?._settings ?? null;
const strip = () => Main.layoutManager.uiGroup.get_children()
    .find(actor => actor.name === 'froontyStrip') ?? null;
const pill = () => strip()?.get_first_child() ?? null;
const scale = () => St.ThemeContext.get_for_stage(global.stage).scale_factor;
const animationWait = () =>
    (settings()?.get_int('animation-duration') ?? 250) + 2 * SETTLE_MS;

// Generous: toggling Froonty makes GNOME Shell 46 disable and re-enable every
// extension enabled after it (e.g. Ubuntu's dock and DING in Ubuntu mode).
async function waitForState(wanted, timeoutMs = 15000) {
    for (let waited = 0; waited < timeoutMs; waited += 50) {
        if (stateName() === wanted)
            return true;
        await sleep(50);
    }
    return false;
}

// Also waits for ExtensionManager to go quiet. In GNOME Shell 46,
// enable/disableExtension() write two keys, each starting an async
// _onEnabledExtensionsChanged() that awaits the "rebasing" of every
// extension enabled after Froonty and only then assigns _enabledExtensions
// (ui/extensionSystem.js:614-648, 736-739). Toggling again before all of
// that has finished can be silently dropped by the Shell itself.
async function setExtensionEnabled(enabled) {
    if (enabled)
        Main.extensionManager.enableExtension(UUID);
    else
        Main.extensionManager.disableExtension(UUID);
    return await waitForState(enabled ? 'ACTIVE' : 'INACTIVE') &&
        await waitForExtensionManagerQuiet();
}

async function waitForExtensionManagerQuiet(quietMs = 500, timeoutMs = 15000) {
    const manager = Main.extensionManager;
    const describe = () => JSON.stringify([
        manager._enabledExtensions,
        manager._extensionOrder,
        manager.getUuids().map(uuid => manager.lookup(uuid)?.state),
    ]);
    let last = describe();
    let quietFor = 0;
    for (let waited = 0; waited < timeoutMs; waited += 50) {
        await sleep(50);
        const now = describe();
        quietFor = now === last ? quietFor + 50 : 0;
        last = now;
        if (quietFor >= quietMs)
            return true;
    }
    return false;
}

// ---------------------------------------------------------------- input

const seat = Clutter.get_default_backend().get_default_seat();
const pointer = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
const keyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
const now = () => GLib.get_monotonic_time();

async function clickAt(x, y) {
    pointer.notify_absolute_motion(now(), x, y);
    await sleep(50);
    pointer.notify_button(now(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
    await sleep(30);
    pointer.notify_button(now(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
    await sleep(SETTLE_MS);
}

async function pressKeys(...keyvals) {
    for (const keyval of keyvals) {
        keyboard.notify_keyval(now(), keyval, Clutter.KeyState.PRESSED);
        await sleep(20);
    }
    for (const keyval of [...keyvals].reverse()) {
        keyboard.notify_keyval(now(), keyval, Clutter.KeyState.RELEASED);
        await sleep(20);
    }
    await sleep(SETTLE_MS);
}

function pillCenter() {
    const [x, y] = pill().get_transformed_position();
    const [w, h] = pill().get_transformed_size();
    return [x + w / 2, y + h / 2];
}

// ---------------------------------------------------------------- probes

async function screenshotTop(outDir, name) {
    const monitor = Main.layoutManager.primaryMonitor;
    const width = 640, height = 240;
    const x = monitor.x + Math.round((monitor.width - width) / 2);
    const path = GLib.build_filenamev([outDir, `${name}.png`]);
    const stream = Gio.File.new_for_path(path)
        .replace(null, false, Gio.FileCreateFlags.NONE, null);
    await new Shell.Screenshot().screenshot_area(x, monitor.y, width, height, stream);
    stream.close(null);
    return path;
}

function countHandlers(instance, signal) {
    try {
        const [name, detail] = signal.split('::');
        const match = detail ? {signalId: name, detail} : {signalId: name};
        const count = GObject.signal_handlers_block_matched(instance, match);
        GObject.signal_handlers_unblock_matched(instance, match);
        return count;
    } catch (e) {
        return `n/a (${e.message})`;
    }
}

const describeActor = actor =>
    `${actor.constructor.name}${actor.name ? `#${actor.name}` : ''}` +
    `${actor.style_class ? `.${actor.style_class.split(' ').join('.')}` : ''}`;

// Everything Froonty may touch in the Shell; must be identical before
// the first enable and after the last disable.
function shellFootprint() {
    const themeContext = St.ThemeContext.get_for_stage(global.stage);
    const dateMenu = Main.panel.statusArea.dateMenu.container;
    return {
        uiGroupChildren: Main.layoutManager.uiGroup.get_children().map(describeActor).sort(),
        trackedChrome: Main.layoutManager._trackedActors.map(d => describeActor(d.actor)).sort(),
        ctrlAltTabItems: Main.ctrlAltTabManager._items.length,
        dateMenuOpacity: dateMenu.opacity,
        keybindingModes: Main.wm._allowedKeybindings['toggle-shortcut'] ?? null,
        modalCount: Main.modalCount,
        actionMode: Main.actionMode,
        stripPresent: strip() !== null,
        handlers: {
            monitorsChanged: countHandlers(Main.layoutManager, 'monitors-changed'),
            systemModalOpened: countHandlers(Main.layoutManager, 'system-modal-opened'),
            panelBoxHeight: countHandlers(Main.layoutManager.panelBox, 'notify::height'),
            panelBoxAllocation: countHandlers(Main.layoutManager.panelBox, 'notify::allocation'),
            scaleFactor: countHandlers(themeContext, 'notify::scale-factor'),
            dateMenuDestroy: countHandlers(dateMenu, 'destroy'),
        },
    };
}

// Lists only what differs, including actors added to or removed from lists.
function footprintDiff(before, after) {
    const lines = [];
    for (const key of Object.keys(before)) {
        const [a, b] = [before[key], after[key]];
        if (Array.isArray(a)) {
            const added = b.filter(x => !a.includes(x) || b.filter(y => y === x).length > a.filter(y => y === x).length);
            const removed = a.filter(x => !b.includes(x));
            if (added.length || removed.length)
                lines.push(`${key}: +[${[...new Set(added)].join(', ')}] -[${removed.join(', ')}]`);
        } else if (JSON.stringify(a) !== JSON.stringify(b)) {
            lines.push(`${key}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
        }
    }
    return lines.join('\n     ');
}

// ---------------------------------------------------------------- tests

function testLoaded() {
    check('extension is ACTIVE', stateName() === 'ACTIVE',
        `state=${stateName()} error=${extension()?.error ?? ''}`);
    check('island strip is in uiGroup', strip() !== null);
    check('top bar clock concealed but still mapped',
        Main.panel.statusArea.dateMenu.container.opacity === 0 &&
        Main.panel.statusArea.dateMenu.mapped);
}

// Box of an actor in stage coordinates.
function boxOf(actor) {
    const [x, y] = actor.get_transformed_position();
    const [w, h] = actor.get_transformed_size();
    return {x1: x, y1: y, x2: x + w, y2: y + h};
}

// The concealed top bar clock stays clickable, so the collapsed pill must
// contain its whole button on both axes.
function pillCoversClock() {
    const p = boxOf(pill());
    const c = boxOf(Main.panel.statusArea.dateMenu.container);
    const ok = p.x1 <= c.x1 && p.x2 >= c.x2 && p.y1 <= c.y1 && p.y2 >= c.y2;
    const fmt = b => `[${b.x1},${b.y1} - ${b.x2},${b.y2}]`;
    return {ok, detail: `pill=${fmt(p)} clock=${fmt(c)}`};
}

function testGeometry(label = '') {
    const monitor = Main.layoutManager.primaryMonitor;
    const [cx, cy] = pillCenter();
    const [w, h] = pill().get_transformed_size();
    const s = settings();
    const minW = s.get_int('collapsed-width') * scale();
    const minH = s.get_int('collapsed-height') * scale();
    const panelHeight = Main.layoutManager.panelBox.height;
    check(`${label}pill horizontally centered on primary monitor`,
        Math.abs(cx - (monitor.x + monitor.width / 2)) <= 1,
        `center=${cx} monitor=${monitor.x}+${monitor.width}`);
    check(`${label}pill vertically inside top bar`,
        cy >= monitor.y && cy <= monitor.y + Math.max(panelHeight, h),
        `centerY=${cy} panel=${panelHeight}`);
    check(`${label}collapsed size is at least the settings`,
        w >= minW && h >= minH, `${w}x${h}, minimum ${minW}x${minH}`);
    const covers = pillCoversClock();
    check(`${label}collapsed pill covers the top bar clock button`, covers.ok, covers.detail);
}

async function testPointer(outDir) {
    const modalBefore = Main.modalCount;
    await screenshotTop(outDir, 'collapsed');

    await clickAt(...pillCenter());
    await sleep(animationWait());
    const [w, h] = pill().get_transformed_size();
    const s = settings();
    check('click on pill expands', island().expanded);
    check('expanded size matches settings',
        w === s.get_int('expanded-width') * scale() &&
        h === s.get_int('expanded-height') * scale(), `${w}x${h}`);
    check('expanded island holds one modal grab', Main.modalCount === modalBefore + 1,
        `modalCount ${modalBefore} -> ${Main.modalCount}`);
    check('expanded pill has key focus', global.stage.key_focus === pill());
    await screenshotTop(outDir, 'expanded');

    const monitor = Main.layoutManager.primaryMonitor;
    await clickAt(monitor.x + 40, monitor.y + monitor.height / 2);
    await sleep(animationWait());
    check('click outside collapses', !island().expanded);
    check('grab released after collapse', Main.modalCount === modalBefore,
        `modalCount=${Main.modalCount}`);

    // Next to the pill, inside the strip's area: must hit the top bar.
    const [px, py] = pill().get_transformed_position();
    const hit = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, px - 20, py + 2);
    check('collapsed strip is click-through', hit !== strip() && !strip().contains(hit),
        `${hit}`);

    await clickAt(...pillCenter());
    await sleep(animationWait());
    await clickAt(...pillCenter());
    await sleep(animationWait());
    check('second click on pill collapses', !island().expanded);
}

async function testKeyboard() {
    await pressKeys(Clutter.KEY_Super_L, Clutter.KEY_Alt_L, Clutter.KEY_i);
    await sleep(animationWait());
    check('<Super><Alt>i expands', island().expanded);

    await pressKeys(Clutter.KEY_Escape);
    await sleep(animationWait());
    check('Escape collapses', !island().expanded);

    await pressKeys(Clutter.KEY_Super_L, Clutter.KEY_Alt_L, Clutter.KEY_i);
    await sleep(animationWait());
    await pressKeys(Clutter.KEY_Super_L, Clutter.KEY_Alt_L, Clutter.KEY_i);
    await sleep(animationWait());
    check('shortcut toggles back to collapsed', !island().expanded);

    island().expand();
    await sleep(animationWait());
    await pressKeys(Clutter.KEY_Return);
    await sleep(animationWait());
    check('Enter on focused pill collapses', !island().expanded);
}

async function testSettings(outDir) {
    const s = settings();

    s.set_int('collapsed-width', 220);
    await sleep(SETTLE_MS);
    check('collapsed-width applies live',
        pill().get_transformed_size()[0] ===
        Math.max(220 * scale(), island()._coverSize().width));
    s.reset('collapsed-width');

    s.set_boolean('show-date', true);
    s.set_string('clock-format', '12h');
    await sleep(SETTLE_MS);
    const text = pill().accessible_name;
    check('show-date + 12h reach the label', /[AP]M/.test(text) && text.includes(' '),
        `label="${text}"`);
    await screenshotTop(outDir, 'collapsed-date-12h');
    s.reset('show-date');
    s.reset('clock-format');

    // Visual check only: St should clamp an oversized radius to a pill.
    s.set_int('corner-radius', 40);
    await sleep(SETTLE_MS);
    await screenshotTop(outDir, 'collapsed-radius-40');
    island().expand();
    await sleep(animationWait());
    await screenshotTop(outDir, 'expanded-radius-40');
    island().collapse();
    await sleep(animationWait());
    s.reset('corner-radius');

    s.set_boolean('hide-panel-clock', false);
    await sleep(SETTLE_MS);
    check('hide-panel-clock=false restores top bar clock',
        Main.panel.statusArea.dateMenu.container.opacity === 255);
    s.reset('hide-panel-clock');
    await sleep(SETTLE_MS);

    s.set_boolean('island-enabled', false);
    await sleep(SETTLE_MS);
    check('island-enabled=false removes island and restores clock',
        strip() === null && Main.panel.statusArea.dateMenu.container.opacity === 255);
    s.reset('island-enabled');
    await sleep(SETTLE_MS);
    check('island-enabled=true brings it back', strip() !== null && pill().mapped);
}

// The concealed top bar clock stays clickable, so the collapsed pill must
// cover its whole button, also when the clock is wider than collapsed-width.
async function testCoversPanelClock(outDir) {
    const iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
    const keys = ['clock-show-date', 'clock-show-weekday', 'clock-show-seconds'];
    for (const key of keys)
        iface.set_boolean(key, true);
    await sleep(2 * SETTLE_MS);

    const container = Main.panel.statusArea.dateMenu.container;
    const [clockW, clockH] = container.get_transformed_size();
    const minW = settings().get_int('collapsed-width') * scale();
    const minH = settings().get_int('collapsed-height') * scale();
    check('wide clock is wider than collapsed-width (test precondition)', clockW > minW,
        `clock=${clockW} minimum=${minW}`);
    check('clock is taller than collapsed-height (test precondition)', clockH > minH,
        `clock=${clockH} minimum=${minH}`);
    const [widePillW] = pill().get_transformed_size();
    let covers = pillCoversClock();
    check('collapsed pill covers the wide clock button', covers.ok, covers.detail);
    await screenshotTop(outDir, 'covers-wide-clock');

    // Collapsing must land on the cover size too, not the plain settings.
    island().expand();
    await sleep(animationWait());
    island().collapse();
    await sleep(animationWait());
    covers = pillCoversClock();
    check('pill still covers the clock after expand/collapse', covers.ok, covers.detail);

    for (const key of keys)
        iface.reset(key);
    await sleep(2 * SETTLE_MS);
    const [w] = pill().get_transformed_size();
    covers = pillCoversClock();
    check('pill shrinks back when the clock narrows, still covering it',
        w < widePillW && covers.ok, `pill width ${widePillW} -> ${w}; ${covers.detail}`);
}

// Switches the primary monitor through Mutter's real D-Bus API, which goes
// through the same monitors-changed path as a hotplug.
async function switchPrimary() {
    const call = (method, params, replyType) => new Promise((resolve, reject) => {
        Gio.DBus.session.call('org.gnome.Mutter.DisplayConfig',
            '/org/gnome/Mutter/DisplayConfig', 'org.gnome.Mutter.DisplayConfig',
            method, params, replyType ? new GLib.VariantType(replyType) : null,
            Gio.DBusCallFlags.NONE, -1, null, (conn, res) => {
                try {
                    resolve(conn.call_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
    });

    const state = (await call('GetCurrentState', null, null)).recursiveUnpack();
    const [serial, monitors, logicalMonitors] = state;
    const currentMode = connector => {
        const monitor = monitors.find(m => m[0][0] === connector);
        return monitor[1].find(mode => mode[6]['is-current'])[0];
    };
    const config = logicalMonitors.map(([x, y, lmScale, transform, primary, lmMonitors]) =>
        [x, y, lmScale, transform, !primary,
            lmMonitors.map(([connector]) => [connector, currentMode(connector), {}])]);
    await call('ApplyMonitorsConfig',
        new GLib.Variant('(uua(iiduba(ssa{sv}))a{sv})', [serial, 1, config, {}]), null);
}

async function testMonitors() {
    const count = Main.layoutManager.monitors.length;
    check('test session has two monitors', count === 2, `monitors=${count}`);
    if (count < 2)
        return;

    const before = Main.layoutManager.primaryIndex;
    try {
        await switchPrimary();
    } catch (e) {
        check('switch primary via DisplayConfig', false, e.message);
        return;
    }
    await sleep(1000);
    check('primary monitor changed', Main.layoutManager.primaryIndex !== before,
        `${before} -> ${Main.layoutManager.primaryIndex}`);
    testGeometry('[after primary switch] ');

    await switchPrimary();
    await sleep(1000);
    testGeometry('[after switching back] ');
}

async function testLifecycle() {
    check('disable succeeds', await setExtensionEnabled(false), stateName());
    const baseline = shellFootprint();
    check('disabled: no strip, clock restored',
        !baseline.stripPresent && baseline.dateMenuOpacity === 255);

    // Proves the probe is sensitive: every counted signal gains handlers
    // while Froonty is enabled. (connectObject() on an actor also adds
    // SignalTracker's own 'destroy' handler, hence "more", not "+1".)
    const reenabled = await setExtensionEnabled(true);
    const enabled = shellFootprint();
    const unchanged = Object.keys(baseline.handlers)
        .filter(k => !(enabled.handlers[k] > baseline.handlers[k]));
    const manager = Main.extensionManager;
    check('footprint probe sees Froonty\'s handlers while enabled', unchanged.length === 0,
        `reenabled=${reenabled} state=${stateName()} strip=${enabled.stripPresent} ` +
        `setting=${manager._getEnabledExtensions().includes(UUID)} ` +
        `list=${manager._enabledExtensions.includes(UUID)} order=${manager._extensionOrder} ` +
        `unchanged: ${unchanged.join(', ')}`);
    await setExtensionEnabled(false);

    const cycles = 25;
    const failures = [];
    for (let i = 0; i < cycles; i++) {
        if (!await setExtensionEnabled(true)) {
            failures.push(`enable #${i}: ${stateName()}`);
            continue;
        }
        // Every fifth cycle, disable while expanded and mid-animation.
        if (i % 5 === 0) {
            island().expand();
            await sleep(40);
        }
        if (!await setExtensionEnabled(false))
            failures.push(`disable #${i}: ${stateName()}`);
    }
    check(`${cycles} enable/disable cycles`, failures.length === 0, failures.join('; '));

    // Other extensions (Ubuntu mode) are disabled and re-enabled with every
    // Froonty toggle and may leave their own leftovers. Actor differences
    // that are not Froonty's are reported as a note, not a failure. Any
    // other difference fails.
    const after = shellFootprint();
    const same = JSON.stringify(after) === JSON.stringify(baseline);
    const isOurs = actor => /froonty/i.test(actor);
    const scrub = footprint => ({
        ...footprint,
        uiGroupChildren: footprint.uiGroupChildren.filter(isOurs),
        trackedChrome: footprint.trackedChrome.filter(isOurs),
    });
    const sameForFroonty = JSON.stringify(scrub(after)) === JSON.stringify(scrub(baseline));
    check('shell footprint identical after cycles', sameForFroonty,
        same ? '' : `${sameForFroonty ? 'note: other extensions changed: ' : ''}${footprintDiff(baseline, after)}`);

    // Poke every signal Froonty ever connected to. A leaked handler would
    // now run against destroyed actors and log errors (run.sh greps them).
    Main.layoutManager.emit('monitors-changed');
    Main.layoutManager.emit('system-modal-opened');
    Main.layoutManager.panelBox.notify('height');
    St.ThemeContext.get_for_stage(global.stage).notify('scale-factor');
    const probe = extension().stateObj.getSettings();
    probe.set_int('collapsed-width', 200);
    probe.set_boolean('show-date', true);
    probe.set_boolean('island-enabled', false);
    await sleep(SETTLE_MS);
    probe.reset('collapsed-width');
    probe.reset('show-date');
    probe.reset('island-enabled');
    const iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
    iface.set_string('clock-format', '12h');
    await sleep(SETTLE_MS);
    iface.reset('clock-format');
    check('disabled: no strip after signal/settings pokes', strip() === null);

    check('re-enable succeeds', await setExtensionEnabled(true), stateName());
    await sleep(SETTLE_MS);
}

export async function runAll(outDir) {
    results.length = 0;
    try {
        testLoaded();
        testGeometry();
        await testPointer(outDir);
        await testKeyboard();
        await testSettings(outDir);
        await testCoversPanelClock(outDir);
        await testMonitors();
        await testLifecycle();
        testLoaded();
    } catch (e) {
        check('test run completed without exception', false, `${e}\n${e.stack}`);
    }
    return results;
}
