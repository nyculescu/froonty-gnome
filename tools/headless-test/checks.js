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
import GdkPixbuf from 'gi://GdkPixbuf';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Volume from 'resource:///org/gnome/shell/ui/status/volume.js';
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

async function screenshotTop(outDir, name, height = 260) {
    const monitor = Main.layoutManager.primaryMonitor;
    const width = 840;
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
        statusArea: Object.keys(Main.panel.statusArea).sort().join(','),
        handlers: {
            monitorsChanged: countHandlers(Main.layoutManager, 'monitors-changed'),
            systemModalOpened: countHandlers(Main.layoutManager, 'system-modal-opened'),
            panelBoxHeight: countHandlers(Main.layoutManager.panelBox, 'notify::height'),
            panelBoxAllocation: countHandlers(Main.layoutManager.panelBox, 'notify::allocation'),
            scaleFactor: countHandlers(themeContext, 'notify::scale-factor'),
            dateMenuDestroy: countHandlers(dateMenu, 'destroy'),
            // The clock service listens to the top bar's own WallClock.
            topBarClock: countHandlers(Main.panel.statusArea.dateMenu._clock, 'notify::clock'),
            topBarTimezone: countHandlers(Main.panel.statusArea.dateMenu._clock, 'notify::timezone'),
            mixerState: countHandlers(Volume.getMixerControl(), 'state-changed'),
            mixerSink: countHandlers(Volume.getMixerControl(), 'default-sink-changed'),
            mixerSource: countHandlers(Volume.getMixerControl(), 'default-source-changed'),
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
    check('the clock follows the top bar\'s WallClock (no clock of its own to dispose)',
        extension().stateObj._clock?._wallClock === Main.panel.statusArea.dateMenu._clock);
    // expanded-height is a minimum: the island grows to show every tab.
    const tabs = island()._hub._tabColumn.get_children().map(boxOf);
    check('expanded size matches settings, tall enough for every tab',
        w === s.get_int('expanded-width') * scale() &&
        h >= s.get_int('expanded-height') * scale() && tabs.at(-1).y2 <= boxOf(pill()).y2 &&
        (h === s.get_int('expanded-height') * scale() || h - (tabs.at(-1).y2 - boxOf(pill()).y1) <= 16 * scale()),
        `${w}x${h}`);
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
    check('a click inside the expanded hub does not collapse it', island().expanded);
    island().collapse();
    await sleep(animationWait());
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
        Math.max(220 * scale(), island()._geometry._coverSize().width));
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

// ---------------------------------------------------------------- hub

// A fake feature that records its lifecycle, used to test the hub host
// before real multi-tab features exist. It is added to the extension's
// own registry module (same URL, so the same module instance).
function makeFakeFeature(log) {
    return {
        id: 'test-fake',
        title: 'Fake',
        icon: 'dialog-information-symbolic',
        enabledKey: null,
        hubSize: {width: 420, height: 220},
        createService: () => ({
            start: () => log.push('start'),
            stop: () => log.push('stop'),
            setActive: active => log.push(active ? 'active' : 'inactive'),
        }),
        createView: () => {
            log.push('view');
            const actor = new St.Label({text: 'fake feature'});
            return {actor, destroy: () => {
                log.push('destroy');
                actor.destroy();
            }};
        },
    };
}

const tabButton = id => island()._hub._entries.get(id)?.button;

async function clickActor(actor) {
    const b = boxOf(actor);
    await clickAt((b.x1 + b.x2) / 2, (b.y1 + b.y2) / 2);
}

async function testHub(outDir) {
    const hub = island()._hub;
    settings().set_boolean('notes-enabled', false);
    settings().set_boolean('claude-enabled', false);
    settings().set_boolean('sysmon-enabled', false);
    settings().set_boolean('zerotier-enabled', false);
    await sleep(SETTLE_MS);
    check('hub: a single feature hides the tab row', !hub._tabColumn.visible);
    settings().reset('notes-enabled');
    await sleep(SETTLE_MS);
    check('hub: enabling a feature adds its tab',
        hub._tabColumn.visible && hub._tabColumn.get_n_children() === 2);
    settings().reset('claude-enabled');
    await sleep(SETTLE_MS);
    settings().reset('sysmon-enabled');
    await sleep(SETTLE_MS);
    settings().reset('zerotier-enabled');
    await sleep(SETTLE_MS);
    check('hub: tabs follow the registry order (Clock, Notes, Claude, Btop, ZeroTier)',
        hub._tabColumn.get_children().map(b => b.accessible_name).join(',') ===
            'Clock,Notes,Claude,Btop,ZeroTier',
        hub._tabColumn.get_children().map(b => b.accessible_name).join(','));
    check('hub: clock is the active tab', hub.activeFeature?.id === 'clock');
    check('hub: tab icons are 20 px (25% over other icon buttons)',
        tabButton('clock').child.get_width() === 20 * scale() &&
        hub.settingsButton.child.get_width() === 16 * scale(),
        `${tabButton('clock').child.get_width()} / ${hub.settingsButton.child.get_width()}`);

    island().expand();
    await sleep(animationWait());
    await clickActor(tabButton('zerotier'));
    await sleep(animationWait());
    const zeroTierView = hub._entries.get('zerotier')?.view;
    const [zeroTierWidth, zeroTierHeight] = pill().get_transformed_size();
    // Header, summary, notices, networks: informative, no join controls.
    check('hub: ZeroTier opens its status at the configured size',
        hub.activeFeature?.id === 'zerotier' && zeroTierView?.actor.get_children().length === 4 &&
        zeroTierWidth === 420 * scale() && zeroTierHeight === 280 * scale(),
        `${zeroTierWidth}x${zeroTierHeight}`);
    check('zerotier: the first start recorded its install check',
        settings().get_boolean('zerotier-install-checked'));

    await clickActor(tabButton('sysmon'));
    await sleep(animationWait());
    const sysmon = hub._entries.get('sysmon');
    const [sysmonWidth, sysmonHeight] = pill().get_transformed_size();
    check('hub: Btop opens at the configured size and polls while on screen',
        hub.activeFeature?.id === 'sysmon' && sysmon?.service.polling === true &&
        sysmonWidth === 460 * scale() && sysmonHeight === 480 * scale(),
        `${sysmonWidth}x${sysmonHeight} polling=${sysmon?.service.polling}`);
    await sleep(2500);
    check('sysmon: a sample reached the tab',
        sysmon?.service.snapshot?.memory?.total > 0 && sysmon.view._memory._part('value').text !== '—',
        sysmon?.view._memory._part('value').text);
    await screenshotTop(outDir, 'sysmon', 600);
    // An iGPU goes between idle (no detail) and busy every sample; its row
    // must not change height, or a list scrolled to its end jumps.
    const gpuRow = sysmon?.view._gpus[0];
    const rowHeight = () => gpuRow.get_preferred_height(-1)[1];
    gpuRow?.update({name: 'GPU', value: 'Idle', fraction: null, detail: ''});
    const idleHeight = gpuRow ? rowHeight() : -1;
    gpuRow?.update({name: 'GPU', value: '5%', fraction: 0.05, detail: '650 MHz'});
    check('sysmon: a GPU row keeps its height between idle and busy',
        gpuRow && idleHeight === rowHeight(), `${idleHeight} vs ${gpuRow && rowHeight()}`);
    settings().set_boolean('sysmon-cores-expanded', true);
    await sleep(2500);
    check('sysmon: unfolding lists each thread with its load',
        sysmon?.view._cores.visible && sysmon.view._coreCells.length > 0 &&
        sysmon.view._coreCells[0].load.text.endsWith('%') && sysmon.view._coreCells[0].level.visible,
        `${sysmon?.view._coreCells.length} threads`);
    await screenshotTop(outDir, 'sysmon-cores', 520);
    check('sysmon: at the default width, two threads share a row',
        sysmon?.view._coreColumns === 2, `${sysmon?.view._coreColumns} columns`);
    settings().set_int('sysmon-width', 380);
    await sleep(animationWait() + 2500);
    const [narrowWidth] = pill().get_transformed_size();
    check('sysmon: a width set in Settings resizes the open island; narrow, a thread per row',
        narrowWidth === 380 * scale() && sysmon?.view._coreColumns === 1,
        `${narrowWidth} ${sysmon?.view._coreColumns} columns`);
    await screenshotTop(outDir, 'sysmon-narrow', 520);
    settings().reset('sysmon-width');
    settings().reset('sysmon-cores-expanded');
    await sleep(animationWait());
    await clickActor(tabButton('clock'));
    await sleep(animationWait());
    check('sysmon: another tab stops the polling', sysmon?.service.polling === false);
    await clickActor(tabButton('sysmon'));
    await sleep(animationWait());
    island().collapse();
    await sleep(animationWait());
    check('sysmon: collapsing the island stops the polling', sysmon?.service.polling === false);
    island().expand();
    await sleep(animationWait());
    await clickActor(tabButton('clock'));
    await sleep(animationWait());
    island().collapse();
    await sleep(animationWait());

    const {FEATURES} = await import(`file://${extension().path}/features/registry.js`);
    const log = [];
    FEATURES.push(makeFakeFeature(log));
    try {
        await setExtensionEnabled(false);
        await setExtensionEnabled(true);
        check('hub: a registered feature adds a tab',
            island()._hub._tabColumn.get_n_children() === 6);
        check('hub: a feature is not created before its tab is selected',
            log.length === 0, log.join(','));

        island().expand();
        await sleep(animationWait());
        await clickActor(tabButton('test-fake'));
        await sleep(animationWait());
        const [w, h] = pill().get_transformed_size();
        check('hub: selecting a tab creates, starts and activates it',
            log.join(',') === 'start,view,active', log.join(','));
        check('hub: island resizes to the feature\'s hubSize',
            w === 420 * scale() && h === 220 * scale(), `${w}x${h}`);
        check('hub: selected tab is remembered',
            settings().get_string('hub-last-tab') === 'test-fake');
        await screenshotTop(outDir, 'hub-two-tabs');

        island().collapse();
        await sleep(animationWait());
        island().expand();
        await sleep(animationWait());
        check('hub: collapse/expand deactivates and reactivates the service',
            log.join(',') === 'start,view,active,inactive,active', log.join(','));

        await clickActor(tabButton('clock'));
        await sleep(animationWait());
        const [cw] = pill().get_transformed_size();
        check('hub: switching away deactivates the service and resizes back',
            log.at(-1) === 'inactive' && cw === settings().get_int('expanded-width') * scale(),
            `${log.join(',')} width=${cw}`);

        await clickActor(tabButton('test-fake'));
        await sleep(animationWait());
        island().collapse();
        await sleep(animationWait());
        log.length = 0;
        await setExtensionEnabled(false);
        check('hub: disable destroys the view and stops the service',
            log.includes('destroy') && log.includes('stop'), log.join(','));
    } finally {
        FEATURES.splice(FEATURES.findIndex(f => f.id === 'test-fake'), 1);
        await setExtensionEnabled(false);
        await setExtensionEnabled(true);
    }
    check('hub: a remembered tab that no longer exists falls back to the first',
        island()._hub.activeFeature?.id === 'clock');
}

// ---------------------------------------------------------------- notes

// Pixel check: the fraction of dark (text) pixels in the editor on its light
// note colour. Catches text that is scrolled or clipped out of sight, which
// adjustment values alone do not.
async function editorInk(outDir, view, name) {
    const b = boxOf(view._scroll);
    return inkIn(outDir, name, b.x1 + 8, b.y1 + 8, b.x2 - b.x1 - 16, b.y2 - b.y1 - 16);
}

// The same measure for any stage rectangle.
async function inkIn(outDir, name, x, y, width, height) {
    const path = GLib.build_filenamev([outDir, `${name}.png`]);
    const stream = Gio.File.new_for_path(path).replace(null, false, Gio.FileCreateFlags.NONE, null);
    await new Shell.Screenshot().screenshot_area(Math.round(x), Math.round(y),
        Math.round(width), Math.round(height), stream);
    stream.close(null);
    const pixbuf = GdkPixbuf.Pixbuf.new_from_file(path);
    const pixels = pixbuf.get_pixels();
    const [n, stride] = [pixbuf.get_n_channels(), pixbuf.get_rowstride()];
    let dark = 0;
    for (let y = 0; y < pixbuf.get_height(); y++) {
        for (let x = 0; x < pixbuf.get_width(); x++) {
            const i = y * stride + x * n;
            if (pixels[i] + pixels[i + 1] + pixels[i + 2] < 3 * 110)
                dark++;
        }
    }
    return dark / (pixbuf.get_width() * pixbuf.get_height());
}

async function typeText(text) {
    for (const ch of text) {
        const keyval = Clutter.unicode_to_keysym(ch.codePointAt(0));
        keyboard.notify_keyval(now(), keyval, Clutter.KeyState.PRESSED);
        keyboard.notify_keyval(now(), keyval, Clutter.KeyState.RELEASED);
        // eslint-disable-next-line no-await-in-loop
        await sleep(15);
    }
    await sleep(SETTLE_MS);
}

const notesFolder = () => Gio.File.new_for_path(GLib.build_filenamev(
    [GLib.get_user_data_dir(), 'froonty', 'notes']));

function noteFiles() {
    const names = [];
    const enumerator = notesFolder().enumerate_children('standard::name', 0, null);
    for (let info; (info = enumerator.next_file(null));)
        names.push(info.get_name());
    // Notes only: .froonty.json (order and colours) sits next to them.
    return names.filter(n => n.endsWith('.md')).sort();
}

function readNote(file) {
    const [, bytes] = notesFolder().get_child(file).load_contents(null);
    return new TextDecoder().decode(bytes);
}

async function testNotes(outDir) {
    const hub = () => island()._hub;
    island().expand();
    await sleep(animationWait());
    await clickActor(tabButton('notes'));
    await sleep(animationWait());

    const view = hub()._entries.get('notes')?.view;
    const [w, h] = pill().get_transformed_size();
    check('notes: tab opens and resizes the island to 428x319',
        view && w === 428 * scale() && h === 319 * scale(), `${w}x${h}`);
    // Settings → Notes → Size applies live; "Default size" resets it.
    settings().set_int('notes-width', 500);
    settings().set_int('notes-height', 400);
    await sleep(animationWait());
    const [sw, sh] = pill().get_transformed_size();
    settings().reset('notes-width');
    settings().reset('notes-height');
    await sleep(animationWait());
    const [rw, rh] = pill().get_transformed_size();
    check('notes: the size settings resize the open island, and reset',
        sw === 500 * scale() && sh === 400 * scale() &&
        rw === 428 * scale() && rh === 319 * scale(), `${sw}x${sh} -> ${rw}x${rh}`);
    check('notes: empty folder shows the empty state',
        view._empty.visible && !view._scroll.visible);
    await screenshotTop(outDir, 'notes-empty');

    await clickActor(view._empty.get_child_at_index(1));
    await sleep(2 * SETTLE_MS);
    const files = noteFiles();
    check('notes: "New note" creates a timestamped .md file',
        files.length === 1 && /^\d\d\.\d\d\.\d\d \d\d\.\d\d\.md$/.test(files[0]), files.join(","));

    await clickActor(view._entry);
    await typeText('hello world');
    check('notes: typing reaches the editor', view._entry.text === 'hello world', view._entry.text);
    check('notes: nothing is written before the autosave delay', readNote(files[0]) === '');
    await sleep(1200);
    check('notes: autosave writes the file', readNote(files[0]) === 'hello world',
        JSON.stringify(readNote(files[0])));

    view._entry.clutter_text.set_selection(6, 11);
    await clickActor(view._formatBar.actor.get_child_at_index(0)); // Bold
    check('notes: Bold wraps the selection', view._entry.text === 'hello **world**',
        view._entry.text);
    await pressKeys(Clutter.KEY_End); // the bold word stays selected by design
    await typeText('!');
    island().collapse();
    await sleep(SETTLE_MS);
    check('notes: collapsing saves immediately',
        readNote(files[0]) === 'hello **world**!', JSON.stringify(readNote(files[0])));

    island().expand();
    await sleep(animationWait());
    check('notes: reopens on the Notes tab with the same note',
        hub().activeFeature?.id === 'notes' && view._entry.text === 'hello **world**!');
    check('notes: the editor has the key focus when shown',
        global.stage.key_focus === view._entry.clutter_text, ``);
    await clickActor(view._tabs.addButton);
    await sleep(2 * SETTLE_MS);
    check('notes: "+" adds a second note and selects it',
        noteFiles().length === 2 && view._entry.text === '' &&
        view._tabs._box.get_n_children() === 2);
    await typeText('second');
    await screenshotTop(outDir, 'notes-two');

    // Rename the selected (second) note: double-click its tab, type, Enter.
    const secondTab = view._tabs._box.get_child_at_index(1);
    const b = boxOf(secondTab);
    const [tx, ty] = [(b.x1 + b.x2) / 2 - 10, (b.y1 + b.y2) / 2];
    pointer.notify_absolute_motion(now(), tx, ty);
    await sleep(50);
    for (let i = 0; i < 2; i++) {
        pointer.notify_button(now(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
        pointer.notify_button(now(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
        // eslint-disable-next-line no-await-in-loop
        await sleep(40);
    }
    await sleep(SETTLE_MS);
    await typeText('plan');
    await pressKeys(Clutter.KEY_Return);
    await sleep(2 * SETTLE_MS);
    check('notes: double-click rename renames the file and keeps the text',
        noteFiles().includes('plan.md') && readNote('plan.md') === 'second',
        noteFiles().join(','));

    // An external edit of the clean first note shows up (inotify).
    const service = hub()._entries.get('notes').service;
    await service.select(service.notes.find(n => n !== 'plan'));
    await sleep(SETTLE_MS);
    notesFolder().get_child(files[0]).replace_contents('edited elsewhere', null, false, 0, null);
    await sleep(1500);
    check('notes: an external edit reloads the open note',
        view._entry.text === 'edited elsewhere', view._entry.text);

    // × twice moves the selected note to the (isolated) Trash.
    // Tab content: [colour dot, name, ×].
    const close = view._tabs._box.get_child_at_index(0).child.get_child_at_index(2);
    await clickActor(close);
    await clickActor(close);
    await sleep(2 * SETTLE_MS);
    check('notes: × twice moves the note to the Trash and selects the other',
        noteFiles().join(',') === 'plan.md' && service.selected === 'plan',
        `${noteFiles().join(',')} selected=${service.selected}`);

    settings().set_boolean('notes-enabled', false);
    await sleep(animationWait());
    const [cw] = pill().get_transformed_size();
    check('notes: disabling removes the tab, stops the service, resizes back',
        !hub()._entries.has('notes') && service._monitor === null &&
        cw === settings().get_int('expanded-width') * scale(), `width=${cw}`);
    settings().reset('notes-enabled');
    island().collapse();
    await sleep(animationWait());
}

async function testNotesTabsAndColors(outDir) {
    const hub = () => island()._hub;
    island().expand();
    await sleep(animationWait());
    await clickActor(tabButton('notes'));
    await sleep(animationWait());
    const view = hub()._entries.get('notes').view;
    const service = hub()._entries.get('notes').service;

    // ---- colour
    check('colour: a new note is yellow',
        service.color === 'yellow' && view._scroll.has_style_class_name('froonty-note-color-yellow'));
    await clickActor(view._colorPicker.button);
    await sleep(SETTLE_MS);
    check('colour: the colour button swaps the formatting bar for swatches',
        view._colorPicker.swatches.visible && !view._formatBar.actor.visible);
    await screenshotTop(outDir, 'notes-color-swatches');
    await clickActor(view._colorPicker.swatches.get_child_at_index(1)); // green
    await sleep(2 * SETTLE_MS);
    const [, metaBytes] = notesFolder().get_child('.froonty.json').load_contents(null);
    const meta = JSON.parse(new TextDecoder().decode(metaBytes));
    check('colour: picking green tints the editor and closes the swatches',
        view._scroll.has_style_class_name('froonty-note-color-green') &&
        !view._scroll.has_style_class_name('froonty-note-color-yellow') &&
        !view._colorPicker.swatches.visible && view._formatBar.actor.visible);
    check('colour: saved in .froonty.json, not in the .md file',
        meta.colors[service.selected] === 'green' &&
        !readNote(`${service.selected}.md`).includes('green'), JSON.stringify(meta));
    const selectedTab = view._tabs._box.get_children().find(t => t.checked);
    check('colour: the tab dot shows the colour',
        selectedTab.child.get_child_at_index(0).has_style_class_name('froonty-note-color-green'));
    await screenshotTop(outDir, 'notes-green');

    // ---- tab strip: tabs as wide as their names (up to ~14 characters)
    while (service.notes.length < 8)
        // eslint-disable-next-line no-await-in-loop
        await service.create();
    await sleep(3 * SETTLE_MS);
    const tabs = view._tabs._box.get_children();
    const scroll = view._tabs._scroll;
    const widths = tabs.map(t => t.get_transformed_size()[0]);
    const [scrollW] = scroll.get_transformed_size();
    // Names of up to 14 characters are shown whole; longer ones end in "…".
    const ellipsized = tabs.filter(t => {
        const shown = t.child.get_child_at_index(1).text;
        return [...t.accessible_name].length <= 14
            ? shown !== t.accessible_name : !shown.endsWith('…');
    });
    check('tabs: 8 tabs, names up to 14 characters are never cut, the row overflows',
        tabs.length === 8 && ellipsized.length === 0 &&
        widths.reduce((a, b) => a + b) > scrollW,
        `widths=${widths.join(',')} row=${scrollW} cut=${ellipsized.length}`);

    // A short name gives a short tab (it "wraps" the title).
    const shortTab = tabs.find(t => !t.checked);
    await service.select(shortTab.accessible_name);
    await service.rename('as');
    await sleep(2 * SETTLE_MS);
    const asTab = view._tabs._box.get_children().find(t => t.accessible_name === 'as');
    const stampTab = view._tabs._box.get_children().find(t => t.accessible_name !== 'as');
    const [asW] = asTab.get_transformed_size();
    const [stampW] = stampTab.get_transformed_size();
    check('tabs: a 2-character name gives a much narrower tab',
        asW < stampW * 0.7, `as=${asW} timestamp=${stampW}`);
    await service.select(service.notes.at(-1));
    await sleep(2 * SETTLE_MS);
    // The rename and select rebuilt the tabs.
    const rowTabs = view._tabs._box.get_children();

    const adjustment = scroll.hadjustment;
    const last = boxOf(rowTabs.at(-1));
    const row = boxOf(scroll);
    check('tabs: the selected (newest) tab is scrolled into view',
        rowTabs.at(-1).checked && last.x1 >= row.x1 - 1 && last.x2 <= row.x2 + 1,
        `tab=[${last.x1},${last.x2}] row=[${row.x1},${row.x2}] value=${adjustment.value}`);

    // Double-click rename on the last tab of an overflowing row: the entry
    // keeps a usable width (it used to shrink to a sliver) and stays in view.
    pointer.notify_absolute_motion(now(), (last.x1 + last.x2) / 2 - 10, (last.y1 + last.y2) / 2);
    await sleep(50);
    for (let i = 0; i < 2; i++) {
        pointer.notify_button(now(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
        pointer.notify_button(now(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
        // eslint-disable-next-line no-await-in-loop
        await sleep(40);
    }
    await sleep(SETTLE_MS);
    const renameEntry = rowTabs.at(-1).child;
    const entryBox = renameEntry instanceof St.Entry ? boxOf(renameEntry) : null;
    check('tabs: renaming the last tab of a full row gives a wide entry, in view',
        entryBox && entryBox.x2 - entryBox.x1 >= 80 * scale() &&
        entryBox.x1 >= row.x1 - 1 && entryBox.x2 <= row.x2 + 1,
        entryBox ? `entry=[${entryBox.x1},${entryBox.x2}] row=[${row.x1},${row.x2}]` : 'no entry');
    await screenshotTop(outDir, 'notes-rename-last-tab');
    await pressKeys(Clutter.KEY_Return); // same name: nothing changes
    await sleep(2 * SETTLE_MS);

    // Wheel over the strip scrolls it horizontally.
    const before = adjustment.value;
    const [cx, cy] = [(row.x1 + row.x2) / 2, (row.y1 + row.y2) / 2];
    pointer.notify_absolute_motion(now(), cx, cy);
    await sleep(50);
    pointer.notify_discrete_scroll(now(), Clutter.ScrollDirection.UP, Clutter.ScrollSource.WHEEL);
    await sleep(SETTLE_MS);
    check('tabs: the mouse wheel scrolls the tab row',
        adjustment.value < before, `${before} -> ${adjustment.value}`);
    await screenshotTop(outDir, 'notes-many-tabs');

    // Middle-click an unselected tab: that note goes to the Trash at once.
    const inRow = t => {
        const b = boxOf(t);
        const r = boxOf(view._tabs._scroll);
        return b.x1 >= r.x1 - 1 && b.x2 <= r.x2 + 1;
    };
    const victim = view._tabs._box.get_children().find(t => !t.checked && inRow(t));
    const victimName = victim.accessible_name;
    const selectedBefore = service.selected;
    const vb = boxOf(victim);
    pointer.notify_absolute_motion(now(), (vb.x1 + vb.x2) / 2, (vb.y1 + vb.y2) / 2);
    await sleep(50);
    pointer.notify_button(now(), Clutter.BUTTON_MIDDLE, Clutter.ButtonState.PRESSED);
    await sleep(30);
    pointer.notify_button(now(), Clutter.BUTTON_MIDDLE, Clutter.ButtonState.RELEASED);
    await sleep(2 * SETTLE_MS);
    check('tabs: middle-click trashes that note and keeps the selection',
        !noteFiles().includes(`${victimName}.md`) && service.notes.length === 7 &&
        service.selected === selectedBefore,
        `${victimName} files=${noteFiles().length} selected=${service.selected}`);

    // Long titles are cut and shown whole in a bubble while hovered.
    const hoverTab = async tab => {
        const b = boxOf(tab);
        pointer.notify_absolute_motion(now(), (b.x1 + b.x2) / 2, (b.y1 + b.y2) / 2);
        await sleep(SETTLE_MS);
    };
    const tooltip = view._tabs.tooltip;
    const fourteen = view._tabs._box.get_children()
        .find(t => [...t.accessible_name].length === 14);
    view._tabs._scrollTo(fourteen);
    await sleep(SETTLE_MS);
    await hoverTab(fourteen);
    check('tabs: a 14-character name is not cut and shows no bubble',
        !tooltip.visible && fourteen.child.get_child_at_index(1).text === fourteen.accessible_name,
        fourteen.accessible_name);
    await service.rename('Weekly planning and shopping list');
    await sleep(2 * SETTLE_MS);
    const longTab = view._tabs._box.get_children().find(t => t.checked);
    const longLabel = longTab.child.get_child_at_index(1);
    await hoverTab(longTab);
    check('tabs: a long name is cut and shown whole in a bubble on hover',
        longLabel.text === 'Weekly planni…' && tooltip.visible &&
        tooltip.text === 'Weekly planning and shopping list', `visible=${tooltip.visible}`);
    await screenshotTop(outDir, 'notes-tooltip');
    const e = boxOf(view._scroll);
    pointer.notify_absolute_motion(now(), (e.x1 + e.x2) / 2, (e.y1 + e.y2) / 2);
    await sleep(SETTLE_MS);
    check('tabs: the bubble hides when the pointer leaves', !tooltip.visible);

    // ---- editor scrolling with a long note
    view._entry.text = Array.from({length: 40}, (_, i) => `line ${i + 1}`).join('\n');
    view._entry.clutter_text.grab_key_focus();
    view._entry.clutter_text.set_cursor_position(-1);
    await typeText('!');
    const vadj = view._scroll.vadjustment;
    const editorText = view._entry.clutter_text;
    const [, , cursorY, lineH] = editorText.position_to_coords(editorText.cursor_position);
    // In the scrolled box's coordinates: the text sits inside the entry's padding.
    const lineBottom = view._entry.y + editorText.y + cursorY + lineH;
    const gap = view._entry.get_theme_node().get_padding(St.Side.BOTTOM);
    check('editor: typing on the last line keeps it a gap above the bottom edge',
        vadj.upper > vadj.page_size && gap >= 12 * scale() &&
        lineBottom + gap <= vadj.value + vadj.page_size + 1,
        `upper=${vadj.upper} page=${vadj.page_size} value=${vadj.value} ` +
        `lineBottom=${lineBottom} gap=${gap}`);
    await screenshotTop(outDir, 'notes-long-bottom');
    // Pixels: no text in the rounded bottom band (the right edge holds the
    // overlay scrollbar, which is dark too).
    const sb = boxOf(view._scroll);
    const corner = 12 * scale();
    const bandInk = await inkIn(outDir, 'ink-bottom-band', sb.x1 + corner, sb.y2 - corner,
        sb.x2 - sb.x1 - 2 * corner - 12 * scale(), corner);
    check('editor: no text overlaps the rounded bottom corners', bandInk === 0,
        `ink=${bandInk.toFixed(4)}`);
    const inkBottom = await editorInk(outDir, view, 'ink-long-bottom');
    check('editor: text is visible when scrolled to the bottom', inkBottom > 0.01,
        `ink=${inkBottom.toFixed(4)}`);
    const eb = boxOf(view._scroll);
    pointer.notify_absolute_motion(now(), (eb.x1 + eb.x2) / 2, (eb.y1 + eb.y2) / 2);
    await sleep(50);
    const bottom = vadj.value;
    for (let i = 0; i < 3; i++) {
        pointer.notify_discrete_scroll(now(), Clutter.ScrollDirection.UP, Clutter.ScrollSource.WHEEL);
        // eslint-disable-next-line no-await-in-loop
        await sleep(60);
    }
    check('editor: the mouse wheel scrolls the note', vadj.value < bottom,
        `${bottom} -> ${vadj.value}`);
    const inkWheel = await editorInk(outDir, view, 'ink-after-wheel');
    check('editor: text is visible after wheel scrolling', inkWheel > 0.01,
        `ink=${inkWheel.toFixed(4)}`);

    // ---- wrap toggle: off = one line per line, horizontal scrolling
    const wrapButton = view._formatBar.wrapButton;
    const hadj = view._scroll.hadjustment;
    check('wrap: on by default, button checked',
        wrapButton.checked && view._entry.clutter_text.line_wrap);
    await clickActor(wrapButton);
    await sleep(SETTLE_MS);
    view._entry.text = `short\n${'a long line without breaks '.repeat(12)}END`;
    view._entry.clutter_text.grab_key_focus();
    view._entry.clutter_text.set_cursor_position(-1);
    await typeText('!');
    const [, cursorX] = view._entry.clutter_text.position_to_coords(
        view._entry.clutter_text.cursor_position);
    check('wrap: off stops wrapping, is saved, and scrolls horizontally to the cursor',
        !wrapButton.checked && !settings().get_boolean('notes-wrap') &&
        !view._entry.clutter_text.line_wrap && hadj.upper > hadj.page_size &&
        hadj.value > 0 && cursorX <= hadj.value + hadj.page_size,
        `checked=${wrapButton.checked} setting=${settings().get_boolean('notes-wrap')} ` +
        `checked=${wrapButton.checked} setting=${settings().get_boolean('notes-wrap')} ` +
        `upper=${hadj.upper} page=${hadj.page_size} value=${hadj.value} cursorX=${cursorX}`);
    await screenshotTop(outDir, 'notes-nowrap');
    const inkNoWrap = await editorInk(outDir, view, 'ink-nowrap');
    check('wrap: text is visible while scrolled sideways', inkNoWrap > 0.005,
        `ink=${inkNoWrap.toFixed(4)}`);
    await clickActor(wrapButton);
    await sleep(SETTLE_MS);
    check('wrap: on again wraps and drops the horizontal scroll',
        wrapButton.checked && view._entry.clutter_text.line_wrap &&
        hadj.upper <= hadj.page_size + 1, `upper=${hadj.upper} page=${hadj.page_size}`);

    await testFormatState(outDir, view);
    await testToolsFold(outDir, view);

    island().collapse();
    await sleep(animationWait());
}

// Formatting toggles light up for the formatting at the cursor.
async function testFormatState(outDir, view) {
    const text = view._entry.clutter_text;
    const bar = view._formatBar.actor;
    // Bar order: B I S H • 1. ☑ </> 🔗 wrap. Wrap is on here.
    const lit = () => bar.get_children().flatMap((b, i) => (b.checked ? [i] : [])).join(',');
    const at = async pos => {
        text.set_selection(pos, pos);
        await sleep(SETTLE_MS);
    };
    view._entry.text = '# Title\nsay **hi** now';
    text.grab_key_focus();

    await at(3); // in "Title"
    check('format state: cursor on a heading lights H only', lit() === '3,9', lit());
    await at(15); // between "h" and "i" of **hi**
    check('format state: cursor inside **hi** lights Bold only', lit() === '0,9', lit());
    await screenshotTop(outDir, 'notes-format-state');
    await at(20); // in "now"
    check('format state: plain text lights nothing', lit() === '9', lit());

    await at(15);
    await clickActor(bar.get_child_at_index(0)); // Bold, while lit
    await sleep(SETTLE_MS);
    check('format state: Bold while lit removes the bold and unlights',
        view._entry.text === '# Title\nsay hi now' && lit() === '9',
        `${JSON.stringify(view._entry.text)} lit=${lit()}`);
}

// ⤴ after "+" folds the tools row away; ⤵ brings it back.
async function testToolsFold(outDir, view) {
    const toggle = view._toolsButton;
    const add = view._tabs.addButton;
    const editorHeight = view._scroll.height;
    // Natural heights: the row stretches its children, so allocated heights
    // would match even if the glyph made the whole row taller.
    const natural = actor => actor.get_preferred_height(-1)[1];
    check('tools fold: ⤴ sits right after "+", no taller than it',
        boxOf(toggle).x1 >= boxOf(add).x2 && natural(toggle) <= natural(add) &&
        toggle.child.gicon.get_file().get_basename().includes('fold-up') && view._tools.visible,
        `toggle natural height ${natural(toggle)}, "+" ${natural(add)}; ` +
        `x ${boxOf(toggle).x1} after "+" ending ${boxOf(add).x2}`);

    await clickActor(toggle);
    await sleep(SETTLE_MS);
    check('tools fold: ⤴ hides the row, is saved, and gives the editor the room',
        !view._tools.visible && !settings().get_boolean('notes-show-tools') &&
        toggle.child.gicon.get_file().get_basename().includes('fold-down') && view._scroll.height > editorHeight,
        `visible=${view._tools.visible} editor ${editorHeight} -> ${view._scroll.height}`);
    check('tools fold: the editor keeps the key focus',
        global.stage.key_focus === view._entry.clutter_text);
    await screenshotTop(outDir, 'notes-tools-folded');

    await clickActor(toggle);
    await sleep(SETTLE_MS);
    check('tools fold: ⤵ brings the row back',
        view._tools.visible && settings().get_boolean('notes-show-tools') &&
        toggle.child.gicon.get_file().get_basename().includes('fold-up') && view._scroll.height === editorHeight,
        `editor ${view._scroll.height}`);
    settings().reset('notes-show-tools');
}

// ---------------------------------------------------------------- claude

// run.sh points CLAUDE_CONFIG_DIR at a private folder; the real
// ~/.claude.json is never read.
const claudeFile = () => Gio.File.new_for_path(GLib.build_filenamev(
    [GLib.getenv('CLAUDE_CONFIG_DIR'), '.claude.json']));
const CLAUDE_ACCOUNT = 'froonty-test-account';

// Shaped like the cache Claude Code 2.1.280 writes, times relative to now.
function claudeConfig({session = 13, weekly = 33, fable = 18, account = CLAUDE_ACCOUNT} = {}) {
    const now = Date.now();
    const iso = ms => new Date(now + ms).toISOString();
    const week = iso((3 * 24 + 11) * 3600000);
    return {
        oauthAccount: {accountUuid: CLAUDE_ACCOUNT},
        cachedUsageUtilization: {
            fetchedAtMs: now - 2 * 60000 - 5000,
            accountUuid: account,
            utilization: {
                five_hour: {utilization: session, resets_at: iso((4 * 60 + 2) * 60000 - 15000)},
                seven_day: {utilization: weekly, resets_at: week},
                limits: [
                    {kind: 'session', group: 'session', percent: session, severity: 'normal',
                        resets_at: iso((4 * 60 + 2) * 60000 - 15000), scope: null},
                    {kind: 'weekly_all', group: 'weekly', percent: weekly, severity: 'normal',
                        resets_at: week, scope: null},
                    {kind: 'weekly_scoped', group: 'weekly', percent: fable, severity: 'normal',
                        resets_at: week, scope: {model: {id: null, display_name: 'Fable'}, surface: null}},
                ],
                iguana_necktie: {utilization: 27.56, resets_at: iso(36 * 24 * 3600000),
                    limit_dollars: 250, used_dollars: 68.9, remaining_dollars: 181.1, locked_reason: null},
            },
        },
    };
}

// As Claude Code saves it: a new file renamed onto the old one.
function writeClaudeConfig(data) {
    const file = claudeFile();
    const temp = file.get_parent().get_child('.claude.json.froonty-test');
    temp.replace_contents(JSON.stringify(data), null, false, Gio.FileCreateFlags.NONE, null);
    temp.move(file, Gio.FileCopyFlags.OVERWRITE, null, null);
}

// Just what ClaudeService uses of Gio.NetworkMonitor, so "offline" does not
// depend on the test machine's network.
class FakeNetwork {
    constructor() {
        this.network_available = true;
        this.connectivity = Gio.NetworkConnectivity.FULL;
        this.handlers = new Map();
        this._next = 1;
    }

    connect(signal, handler) {
        this.handlers.set(this._next, {signal, handler});
        return this._next++;
    }

    disconnect(id) {
        this.handlers.delete(id);
    }

    // Like GNetworkMonitorNM: NetworkManager's connectivity check arrives
    // as a property notification only.
    set(available, connectivity) {
        this.network_available = available;
        this.connectivity = connectivity;
        for (const {signal, handler} of [...this.handlers.values()]) {
            if (signal === 'notify::connectivity')
                handler(this);
        }
    }
}

// run.sh points FROONTY_LIVENERF_DIR at a private folder; GitHub is never
// asked. Shaped like livenerf's README and chart on 2026-09-30, a Δ row
// and a baseline mean optional.
function writeLivenerf({resultRow = '', baselineMean = null} = {}) {
    const readme = `# livenerf

## Status

**Progress (2026-09-30):** 7 of 30 days collected (baseline 7 of
10), none missed.

## Results

| # | window | samples | score | Δ vs baseline ± SE | output tok (median) | control Δ | CLI | decision |
|---|------|---------|-------|--------------------|---------------------|-----------|-----|----------|
| 0 | days 1–10 (from 2026-09-24) | - | - | baseline | - | baseline | pinned | baseline (collecting) |
${resultRow}
## Getting started
`;
    const dir = Gio.File.new_for_path(GLib.getenv('FROONTY_LIVENERF_DIR'));
    const media = dir.get_child('media');
    if (!media.query_exists(null))
        media.make_directory_with_parents(null);
    const put = (file, text) => file.replace_contents(text, null, false, Gio.FileCreateFlags.NONE, null);
    put(dir.get_child('README.md'), readme);
    put(media.get_child('livenerf-dark.svg'), livenerfSvg([[59.0, 5.6], [61.9, 5.6], [58.4, 5.6],
        [60.2, 5.6], [64.1, 5.6], [52.6, 5.6], [54.5, 5.6]], baselineMean));
}

// The hero chart as livenerf/plot.py draws it (dark theme): 40–80% over
// y 328–92, 32 days over x 64–932, the baseline's 10 days shaded.
function livenerfSvg(days, baselineMean) {
    const x = day => (64 + day / 32 * 868).toFixed(1);
    const y = v => (92 + (80 - v) / 40 * 236).toFixed(1);
    const o = ['<svg xmlns="http://www.w3.org/2000/svg" width="960" height="380" viewBox="0 0 960 380">',
        '<title id="t">Claude Opus 5.5 compared with its own launch week</title>',
        '<rect width="960" height="380" rx="10" fill="#1a1a19"/>'];
    for (let v = 40; v <= 80; v += 10) {
        o.push(`<line x1="64" y1="${y(v)}" x2="932" y2="${y(v)}" stroke="#2c2c2a" stroke-width="1"/>`);
        o.push(`<text x="54" y="${(+y(v) + 4).toFixed(1)}" text-anchor="end" fill="#898781" font-size="12">${v}%</text>`);
    }
    o.push(`<rect x="64.0" y="92" width="${(10 / 32 * 868).toFixed(1)}" height="236" fill="#2c2c2a" opacity="0.6"/>`);
    ['Sep 24', 'Oct 01', 'Oct 08', 'Oct 15', 'Oct 22'].forEach((label, i) =>
        o.push(`<text x="${x(7 * i)}" y="350" text-anchor="middle" fill="#898781" font-size="12">${label}</text>`));
    if (baselineMean !== null) {
        o.push(`<line x1="64" y1="${y(baselineMean)}" x2="932" y2="${y(baselineMean)}" stroke="#c3c2b7" ` +
            'stroke-width="1.5" stroke-dasharray="6 5"/>');
        o.push(`<text x="928" y="${(y(baselineMean) - 6).toFixed(1)}" text-anchor="end" fill="#c3c2b7" ` +
            `font-size="12">baseline ${baselineMean.toFixed(1)}%</text>`);
    }
    days.forEach(([v, se], i) => {
        o.push(`<line x1="${x(i + 0.5)}" y1="${y(v - 1.96 * se)}" x2="${x(i + 0.5)}" y2="${y(v + 1.96 * se)}" ` +
            'stroke="#3987e5" stroke-width="1.5" opacity="0.5"/>');
        o.push(`<circle cx="${x(i + 0.5)}" cy="${y(v)}" r="3.5" fill="#3987e5" stroke="#1a1a19" stroke-width="1.5"/>`);
    });
    const [last] = days.slice(-1);
    o.push(`<text x="${(+x(days.length - 0.5) + 10).toFixed(1)}" y="${(y(last[0]) - 8).toFixed(1)}" ` +
        `fill="#ffffff" font-size="13" font-weight="600">${last[0].toFixed(1)}%</text>`);
    if (baselineMean === null) {
        o.push(`<text x="633.6" y="210.0" text-anchor="middle" fill="#898781" font-size="14">` +
            `Collecting the baseline: day ${days.length} of 10.</text>`);
    }
    o.push('<text x="932" y="368" text-anchor="end" fill="#898781" font-size="11">' +
        '546 samples · updated 2026-09-30 19:44 UTC</text>', '</svg>');
    return o.join('\n');
}

// [name, value, detail] of the livenerf row, or null while it is hidden.
function benchmarkRow(view) {
    const [row] = view._benchmark.get_children();
    if (!view._benchmark.visible || !row)
        return null;
    const [heading, , detail] = row.get_children();
    return [...heading.get_children().map(l => l.text), detail.text];
}

// [[name, percent, reset], …] as the tab shows them.
function claudeRows(view) {
    return view._rows.get_children().map(row => {
        const [heading, , reset] = row.get_children();
        return [...heading.get_children().map(l => l.text), reset.text];
    });
}

const claudeDir = () => GLib.getenv('CLAUDE_CONFIG_DIR');
const claudeRuns = () => {
    try {
        const [, bytes] = Gio.File.new_for_path(`${claudeDir()}/runs.log`).load_contents(null);
        return new TextDecoder().decode(bytes).split('\n').filter(Boolean);
    } catch (e) {
        return [];
    }
};
const statusLineFile = () => Gio.File.new_for_path(GLib.build_filenamev(
    [GLib.get_user_cache_dir(), 'froonty', 'claude-status-line.json']));

async function reopenIsland() {
    island().collapse();
    await sleep(animationWait());
    island().expand();
    await sleep(animationWait());
}

// Fresh usage: Claude Code's /usage on open (A), the status line (B), and
// low power turning the setting off and back on (docs/features/claude.md).
async function testClaudeFreshness(view, service, button) {
    const refresher = service._refresher;
    check('claude: the tab and the panic button share one refresher',
        refresher && refresher === button._service._refresher);
    check('claude: Claude Code is run with -p --no-session-persistence /usage, the fake only',
        claudeRuns().length >= 1 && claudeRuns().every(r => r === '-p --no-session-persistence /usage'),
        JSON.stringify(claudeRuns()));

    // Its run puts a new cache in place, as Claude Code's /usage does.
    const before = claudeRuns().length;
    refresher._lastRun = -Infinity;
    const next = claudeConfig({session: 55});
    next.cachedUsageUtilization.fetchedAtMs = Date.now();
    Gio.File.new_for_path(`${claudeDir()}/next.json`).replace_contents(JSON.stringify(next),
        null, false, Gio.FileCreateFlags.NONE, null);
    await reopenIsland();
    check('claude: opening the island runs Claude Code once; its new reading appears',
        await waitFor(() => claudeRows(view)[0]?.[1] === '55%') && claudeRuns().length === before + 1,
        `${claudeRuns().length - before} runs ${JSON.stringify(claudeRows(view))}`);
    check('claude button: shows the new reading too', await waitFor(() => button._number.text === '55'));
    await reopenIsland();
    await sleep(SETTLE_MS);
    check('claude: reopened within a minute, Claude Code is not run again',
        claudeRuns().length === before + 1, `${claudeRuns().length - before} runs`);

    // An old cache from here on, so only the setting can stop a run.
    const old = claudeConfig({session: 55});
    writeClaudeConfig(old);
    await waitFor(() => service._cacheFetchedAt === old.cachedUsageUtilization.fetchedAtMs);

    // Low power: the setting turns off by itself; nothing is run.
    refresher._power.known = true;
    refresher._power.reason = 'power-saver';
    refresher._power.emit('changed');
    await sleep(SETTLE_MS);
    check('claude: Power Saver turns "Ask Claude Code for fresh usage" off',
        !settings().get_boolean('claude-ask-claude-code') &&
        settings().get_boolean('claude-ask-paused-for-power'));
    check('claude: the footer says only the status line brings new numbers',
        view._footer.text.endsWith(' · Power Saver: status line only'), view._footer.text);
    refresher._lastRun = -Infinity;
    await reopenIsland();
    await sleep(SETTLE_MS);
    check('claude: in low power, opening the island runs nothing (with an old cache)',
        claudeRuns().length === before + 1, `${claudeRuns().length - before} runs`);

    // The status line's newer Session and Weekly win.
    const status = statusLineFile();
    try {
        status.get_parent().make_directory_with_parents(null);
    } catch (e) {}
    // The same windows as the cache's, with more used since.
    const reset = id => Math.floor(service._cacheUsage.windows.find(w => w.id === id).resetsAt / 1000);
    status.replace_contents(JSON.stringify({writtenAtMs: Date.now(), rate_limits: {
        five_hour: {used_percentage: 66, resets_at: reset('session')},
        seven_day: {used_percentage: 44, resets_at: reset('weekly')},
    }}), null, false, Gio.FileCreateFlags.NONE, null);
    check('claude: a newer status line replaces Session and Weekly; Fable stays',
        await waitFor(() => claudeRows(view)[0]?.[1] === '66%') &&
        claudeRows(view)[1][1] === '44%' && claudeRows(view)[2][1] === '18%',
        JSON.stringify(claudeRows(view)));
    check('claude button: follows the status line', await waitFor(() => button._number.text === '66'));

    refresher._power.reason = null;
    refresher._power.emit('changed');
    await sleep(SETTLE_MS);
    check('claude: when low power ends, the setting is back on',
        settings().get_boolean('claude-ask-claude-code') &&
        !settings().get_boolean('claude-ask-paused-for-power') &&
        !view._footer.text.includes('status line only'), view._footer.text);
    // The control: with the same old cache, no low power, a run happens.
    writeClaudeConfig(claudeConfig({session: 55}));
    await sleep(SETTLE_MS);
    refresher._lastRun = -Infinity;
    await reopenIsland();
    check('claude: back out of low power, opening the island runs Claude Code again',
        await waitFor(() => claudeRuns().length === before + 2), `${claudeRuns().length - before} runs`);

    status.delete(null);
    for (const key of ['claude-ask-claude-code', 'claude-ask-paused-for-power', 'claude-low-power-handled'])
        settings().reset(key);
    await sleep(SETTLE_MS);
}

const claudeButton = () => island()._hub._panicBar._buttons
    .find(b => b.actor.has_style_class_name('froonty-claude-session')) ?? null;


// ---------------------------------------------------------------- clipboard

const stClipboard = () => St.Clipboard.get_default();
const CLIPBOARD = St.ClipboardType.CLIPBOARD;
const clipboardRecorder = () => island()._hub._entries.get('clipboard')?.service?.recorder ?? null;

function clipboardText() {
    return new Promise(resolve =>
        stClipboard().get_text(CLIPBOARD, (_c, text) => resolve(text)));
}

async function testClipboard(outDir) {
    const selection = global.display.get_selection();
    const before = countHandlers(selection, 'owner-changed');
    check('clipboard: off by default, so nothing listens to copies',
        !settings().get_boolean('clipboard-enabled') && !tabButton('clipboard'));

    settings().set_boolean('clipboard-enabled', true);
    await sleep(SETTLE_MS);
    check('clipboard: turning it on listens to copies, once',
        countHandlers(selection, 'owner-changed') === before + 1,
        `${before} -> ${countHandlers(selection, 'owner-changed')}`);

    // Recorded with the island collapsed and the tab never opened.
    stClipboard().set_text(CLIPBOARD, 'Froonty clipboard test: first line\nsecond line');
    await sleep(SETTLE_MS);
    const pixbuf = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, false, 8, 48, 32);
    pixbuf.fill(0x62a0eaff);
    const [, png] = pixbuf.save_to_bufferv('png', [], []);
    stClipboard().set_content(CLIPBOARD, 'image/png', new GLib.Bytes(png));
    await sleep(SETTLE_MS);
    stClipboard().set_content(CLIPBOARD, 'x-special/gnome-copied-files', new GLib.Bytes(
        new TextEncoder().encode('cut\nfile:///home/test/Report%202026.pdf\nfile:///home/test/Photos')));
    await sleep(SETTLE_MS);
    // A browser's password manager marks nothing: the text gives it away.
    stClipboard().set_text(CLIPBOARD, 'Kx9vR2mQpL4wTz8!');
    await sleep(SETTLE_MS);

    island().expand();
    await sleep(animationWait());
    await clickActor(tabButton('clipboard'));
    await sleep(animationWait());
    const recorder = clipboardRecorder();
    const view = island()._hub._entries.get('clipboard')?.view;
    const rows = view?._list.get_children() ?? [];
    check('clipboard: copies made with the tab closed are listed, newest first',
        recorder?.shown.map(e => e.kind).join(',') === 'password,files,image,text' && rows.length === 4,
        `${recorder?.shown.map(e => e.kind).join(',')} rows=${rows.length}`);
    const historyFile = Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_data_dir(),
        'froonty', 'clipboard', 'history.json']));
    const saved = new TextDecoder().decode(historyFile.load_contents(null)[1]);
    const passwordText = rows[0].get_first_child().child.get_children()[1].get_first_child().text;
    check('clipboard: a copied password is listed hidden, and never saved',
        passwordText === '••••••••' && !saved.includes('Kx9vR2mQpL4wTz8') && recorder.password !== null,
        `${passwordText} saved=${saved.includes('Kx9vR2mQpL4wTz8')}`);
    const [w, h] = pill().get_transformed_size();
    check('clipboard: the tab opens at its configured size',
        w === 400 * scale() && h === 440 * scale(), `${w}x${h}`);
    await screenshotTop(outDir, 'clipboard', 520);

    // Click the text entry (the oldest): it is on the clipboard again.
    await clickActor(rows[3].get_first_child());
    await sleep(SETTLE_MS);
    check('clipboard: a click copies the entry back, ready to paste',
        await clipboardText() === 'Froonty clipboard test: first line\nsecond line' &&
        recorder.entries[0].kind === 'text' && recorder.currentId === recorder.entries[0].id &&
        recorder.entries.length === 3 && recorder.password === null,
        `${await clipboardText()} ${recorder.entries.map(e => e.kind)} password=${recorder.password !== null}`);
    check('clipboard: the history is in the private data folder',
        Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_data_dir(), 'froonty',
            'clipboard', 'history.json'])).query_exists(null));

    await clickActor(tabButton('clock'));
    await sleep(animationWait());
    island().collapse();
    await sleep(animationWait());
    settings().reset('clipboard-enabled');
    await sleep(SETTLE_MS);
    check('clipboard: turning it off stops listening to copies',
        countHandlers(selection, 'owner-changed') === before && !tabButton('clipboard'));
}

// ---------------------------------------------------------------- kill process

// The Kill Process tab lists the real user's processes: the Shell under
// test reads the host's /proc. These checks only ever click rows of the
// processes they spawned themselves (a sleep, and a sleep that ignores
// SIGTERM), and check the row's process id before every click. Whatever
// they spawned and is still running at the end is ended with
// Gio.Subprocess.force_exit(), which only reaches their own children.

const killProcessEntry = () => island()._hub._entries.get('killprocess') ?? null;

function spawnChild(argv) {
    const proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.NONE);
    const child = {proc, pid: Number(proc.get_identifier()), exited: false};
    proc.wait_async(null, () => {
        child.exited = true;
    });
    return child;
}

const killRow = (view, pid) =>
    view?._rows.find(row => row.visible && row.process?.pid === pid) ?? null;

// Clicks one part of the row of `child`, only if that row still shows it
// once the pointer rests on the list (which holds the rows in place).
async function clickOwnRow(view, child, part) {
    const row = killRow(view, child.pid);
    const actor = row?._part(part);
    if (!actor?.visible)
        return false;
    const center = () => {
        const b = boxOf(actor);
        return [(b.x1 + b.x2) / 2, (b.y1 + b.y2) / 2];
    };
    await movePointerTo(...center());
    await sleep(SETTLE_MS);
    if (killRow(view, child.pid) !== row || row.process.pid !== child.pid || !actor.visible)
        return false;
    await clickAt(...center());
    return true;
}

function parentPid() {
    const [, bytes] = GLib.file_get_contents('/proc/self/stat');
    const text = new TextDecoder().decode(bytes);
    return Number(text.slice(text.lastIndexOf(')') + 1).trim().split(/\s+/)[1]);
}

async function testKillProcess(outDir) {
    check('kill process: off by default, so no tab and nothing read',
        !settings().get_boolean('killprocess-enabled') && !tabButton('killprocess'));

    const children = [];
    try {
        const sleeper = spawnChild(['/usr/bin/sleep', '600']);
        children.push(sleeper);
        // Test-only shell: SIGTERM ignored is kept through exec, so only
        // "Force quit" (SIGKILL) ends this one.
        const stubborn = spawnChild(['/bin/sh', '-c', 'trap "" TERM; exec /usr/bin/sleep 601']);
        children.push(stubborn);
        await sleep(300);

        settings().set_boolean('killprocess-enabled', true);
        await sleep(SETTLE_MS);
        island().expand();
        await sleep(animationWait());
        await clickActor(tabButton('killprocess'));
        await sleep(animationWait());
        const service = killProcessEntry()?.service;
        const view = killProcessEntry()?.view;
        const [w, h] = pill().get_transformed_size();
        check('kill process: the tab opens at its size and reads processes while on screen',
            island()._hub.activeFeature?.id === 'killprocess' && service?.polling === true &&
            w === 480 * scale() && h === 440 * scale(),
            `${w}x${h} polling=${service?.polling}`);
        await waitFor(() => service?.processes?.some(p => p.pid === sleeper.pid));
        const listed = pid => service?.processes?.find(p => p.pid === pid) ?? null;
        check('kill process: only the user\'s processes are listed, the spawned ones included',
            listed(sleeper.pid)?.name === 'sleep' && listed(1) === null &&
            service.processes.every(p => p.pid > 1),
            `${service?.processes?.length} processes; sleep=${JSON.stringify(listed(sleeper.pid))}`);
        await screenshotTop(outDir, 'killprocess', 520);

        const shellPid = new Gio.Credentials().get_unix_pid();
        const shellParent = parentPid();
        const dbus = service?.processes?.filter(p => p.name === 'dbus-daemon') ?? [];
        check('kill process: GNOME Shell, what started it and session programs are protected',
            listed(shellPid)?.protected === 'shell' && listed(shellParent)?.protected === 'session' &&
            dbus.length > 0 && dbus.every(p => p.protected === 'session'),
            `shell=${listed(shellPid)?.protected} parent ${shellParent}=${listed(shellParent)?.protected} ` +
            `dbus=${dbus.map(p => p.protected)}`);
        // verify() only reads /proc; it is what kill() asks before signalling.
        check('kill process: a kill of GNOME Shell is refused before any signal',
            await service?._sampler.verify(listed(shellPid)) === 'protected');

        check('kill process: the filter has the key focus',
            global.stage.get_key_focus() === view?._filter.clutter_text,
            `${global.stage.get_key_focus()}`);
        await typeText(String(shellPid));
        await sleep(SETTLE_MS);
        const shellRow = killRow(view, shellPid);
        check('kill process: typing filters; a protected row has a lock, no kill button',
            view?._filter.text === String(shellPid) && shellRow &&
            shellRow._part('lock').visible && !shellRow._part('kill').visible,
            `filter=${view?._filter.text} row=${Boolean(shellRow)}`);

        // The process id of the sleep, with another start time: a reused id.
        view._filter.text = String(sleeper.pid);
        await sleep(SETTLE_MS);
        const sleepRow = killRow(view, sleeper.pid);
        const rowTop = sleepRow ? boxOf(sleepRow).y1 : -1;
        await service.kill({...listed(sleeper.pid), key: `${sleeper.pid}:0`, start: 0});
        await sleep(SETTLE_MS);
        check('kill process: a reused process id (another start time) is never signalled',
            service.lastResult?.outcome === 'gone' && !sleeper.exited,
            JSON.stringify(service.lastResult));
        check('kill process: news of a kill does not move the rows under the pointer',
            view._status.text.includes('had already ended') && sleepRow &&
            boxOf(sleepRow).y1 === rowTop,
            `${rowTop} -> ${sleepRow && boxOf(sleepRow).y1}`);

        check('kill process: the spawned sleep has a kill button',
            sleepRow?._part('kill').visible && sleepRow.process.name === 'sleep');
        const asked = await clickOwnRow(view, sleeper, 'kill');
        await sleep(SETTLE_MS);
        check('kill process: the first click only asks "Kill “sleep”?"',
            asked && sleepRow._part('confirm').visible &&
            sleepRow._part('confirm').label === 'Kill “sleep”?' &&
            sleepRow._part('cancel').visible && !sleeper.exited,
            `asked=${asked} confirm=${sleepRow?._part('confirm').label} exited=${sleeper.exited}`);
        await screenshotTop(outDir, 'killprocess-confirm', 520);
        const confirmed = await clickOwnRow(view, sleeper, 'confirm');
        await waitFor(() => sleeper.exited);
        check('kill process: confirming ends it with SIGTERM',
            confirmed && sleeper.exited && sleeper.proc.get_if_signaled() &&
            sleeper.proc.get_term_sig() === 15,
            `confirmed=${confirmed} exited=${sleeper.exited}`);
        await waitFor(() => service.lastResult?.outcome === 'ended');
        check('kill process: the tab says it ended, and holds the row while pointed at',
            view._status.text.includes(`(${sleeper.pid}) has ended`) &&
            killRow(view, sleeper.pid)?._part('state').text === 'Ended',
            `${view._status.text} / ${killRow(view, sleeper.pid)?._part('state').text}`);
        const header = boxOf(view._filter);
        await movePointerTo(header.x1 + 10, header.y1 + 5);
        await sleep(SETTLE_MS);
        check('kill process: once the pointer leaves, the ended process is gone from the list',
            killRow(view, sleeper.pid) === null, view._status.text);

        view._filter.text = String(stubborn.pid);
        await waitFor(() => killRow(view, stubborn.pid) !== null);
        const stubbornRow = killRow(view, stubborn.pid);
        const killed = await clickOwnRow(view, stubborn, 'kill') &&
            await clickOwnRow(view, stubborn, 'confirm');
        await sleep(1000);
        check('kill process: no "Force quit" while it may still be quitting',
            killed && !stubborn.exited && !stubbornRow._part('force').visible &&
            stubbornRow._part('state').text === 'Asked to quit…',
            `killed=${killed} state=${stubbornRow?._part('state').text}`);
        await waitFor(() => stubbornRow._part('force').visible, 8000);
        check('kill process: still running after SIGTERM, it is offered "Force quit"',
            !stubborn.exited && stubbornRow._part('force').visible &&
            stubbornRow.process.pid === stubborn.pid);
        await screenshotTop(outDir, 'killprocess-force', 520);
        const forced = await clickOwnRow(view, stubborn, 'force');
        await waitFor(() => stubborn.exited);
        check('kill process: "Force quit" ends it with SIGKILL',
            forced && stubborn.exited && stubborn.proc.get_if_signaled() &&
            stubborn.proc.get_term_sig() === 9,
            `forced=${forced} exited=${stubborn.exited}`);

        await clickActor(tabButton('clock'));
        await sleep(animationWait());
        check('kill process: another tab stops the reading, and clears the filter',
            service.polling === false && view._filter.text === '');
        await clickActor(tabButton('killprocess'));
        await sleep(animationWait());
        check('kill process: back on screen, it reads again', service.polling === true);
        island().collapse();
        await sleep(animationWait());
        check('kill process: collapsing the island stops the reading', service.polling === false);
        island().expand();
        await sleep(animationWait());
        await clickActor(tabButton('clock'));
        await sleep(animationWait());
        island().collapse();
        await sleep(animationWait());
    } finally {
        for (const child of children) {
            if (!child.exited)
                child.proc.force_exit();
        }
        settings().reset('killprocess-enabled');
        await sleep(SETTLE_MS);
    }
    check('kill process: turning it off removes the tab', !tabButton('killprocess'));
}

async function testClaude(outDir) {
    const hub = () => island()._hub;
    writeClaudeConfig(claudeConfig());
    writeLivenerf();
    settings().set_strv('panic-buttons', ['mute-microphone', 'mute-sound', 'claude-session']);
    await sleep(SETTLE_MS);
    check('claude button: not read while the island is collapsed',
        claudeButton()?._service.loaded === false && claudeButton()?._service._monitor === null);
    island().expand();
    await sleep(animationWait());
    await clickActor(tabButton('claude'));
    await sleep(animationWait());

    const entry = hub()._entries.get('claude');
    const {view, service} = entry;
    check('claude: the tab opens', hub().activeFeature?.id === 'claude' && view && service);
    const [w, h] = pill().get_transformed_size();
    check('claude: island resizes to the tab\'s hubSize',
        w === 380 * scale() && h === 465 * scale(), `${w}x${h}`);

    // Swap in a network we control, then show the tab again.
    const network = new FakeNetwork();
    service.setActive(false);
    service._network = network;
    service.setActive(true);
    await service._reading;
    await sleep(SETTLE_MS);

    // The panic button has a service of its own; same swap.
    const button = claudeButton();
    const buttonNetwork = new FakeNetwork();
    button.setActive(false);
    button._service._network = buttonNetwork;
    button.setActive(true);
    await button._service._reading;
    await sleep(SETTLE_MS);
    check('claude button: the session usage over the Spark, number only',
        button._number.text === '13' && button.actor.accessible_name === 'Claude session usage: 13%',
        `${button._number.text} / ${button.actor.accessible_name}`);

    const rows = claudeRows(view);
    const text = JSON.stringify(rows);
    check('claude: Session, Weekly, Weekly Fable and the cloud session credits',
        rows.map(r => `${r[0]} ${r[1]}`).join(', ') ===
        'Session 13%, Weekly 33%, Weekly Fable 18%, Cloud session credits $181.10 left', text);
    const creditsDay = GLib.DateTime.new_now_local().add_days(36).format('%a %-d %b');
    check('claude: the credits, a month away, reset on a date',
        rows[3][2].startsWith(`Resets ${creditsDay} `), text);
    check('claude: the session resets in hours and minutes',
        rows[0][2] === 'Resets in 4 h 2 min', text);
    const weekday = GLib.DateTime.new_now_local().add_hours(3 * 24 + 11).format('%a');
    check('claude: weekly limits reset on a weekday and time',
        rows[1][2].startsWith(`Resets ${weekday} `) && rows[2][2] === rows[1][2], text);
    check('claude: the footer says when Claude Code checked',
        view._footer.visible && view._footer.text === 'Updated 2 min ago', view._footer.text);
    check('claude: no offline notice while online', !view._notice.visible);
    // livenerf's chart says when it was redrawn, in UTC; the tab, locally.
    const redrawn = GLib.DateTime.new_from_unix_utc(Date.parse('2026-09-30T19:44:00Z') / 1000).to_local();
    const livenerfUpdated = `livenerf, updated ${redrawn.format('%a')} `;
    const chartOf = () => view._benchmark.get_first_child()?.get_child_at_index(1);
    check('claude: livenerf\'s row, the latest score over its chart',
        await waitFor(() => benchmarkRow(view)?.[1] === '54.5% correct') &&
        benchmarkRow(view)[0] === 'Opus 5.5 vs launch week' &&
        benchmarkRow(view)[2].startsWith(`Baseline day 7 of 10 · ${livenerfUpdated}`) &&
        chartOf()?.has_style_class_name('froonty-claude-chart') &&
        service.benchmark.benchmark.chart.points.length === 7,
        JSON.stringify(benchmarkRow(view)));
    await screenshotTop(outDir, 'claude-tab', 465);

    // Within the hour no second fetch; forget the reading to fetch again.
    writeLivenerf({baselineMean: 59.4, resultRow: '| 1 | days 11–20 (from 2026-10-04) | 7020 | 61.2% | ' +
        '−2.1 ± 1.4 | 812 | +0.3 ± 1.9 | pinned | no change |\n'});
    service.benchmark.fetchedAt = null;
    await service.benchmark.refresh();
    await sleep(SETTLE_MS);
    check('claude: once published, the Δ and livenerf\'s decision under the chart',
        benchmarkRow(view)?.[1] === '54.5% correct' &&
        benchmarkRow(view)[2].startsWith(
            `Δ −2.1 ± 1.4, days 11–20 (from 2026-10-04): no change · ${livenerfUpdated}`) &&
        service.benchmark.benchmark.chart.baselineMean === 59.4,
        JSON.stringify(benchmarkRow(view)));
    await screenshotTop(outDir, 'claude-tab-delta', 465);

    writeClaudeConfig(claudeConfig({session: 21}));
    check('claude: while shown, a new reading from Claude Code appears',
        await waitFor(() => claudeRows(view)[0]?.[1] === '21%'), JSON.stringify(claudeRows(view)));
    check('claude button: follows the new reading too',
        await waitFor(() => button._number.text === '21'), button._number.text);
    writeClaudeConfig(claudeConfig({session: 100}));
    await waitFor(() => button._number.text === '100');
    const numberBox = boxOf(button._number);
    const buttonBox = boxOf(button.actor);
    const [mic] = island()._hub._panicBar._buttons;
    check('claude button: "100" fits inside the button, which is as big as the others',
        numberBox.x1 >= buttonBox.x1 && numberBox.x2 <= buttonBox.x2 &&
        numberBox.y1 >= buttonBox.y1 && numberBox.y2 <= buttonBox.y2 &&
        button.actor.width === mic.actor.width && button.actor.height === mic.actor.height,
        `number=[${numberBox.x1},${numberBox.y1},${numberBox.x2},${numberBox.y2}] ` +
        `button=[${buttonBox.x1},${buttonBox.y1},${buttonBox.x2},${buttonBox.y2}] ` +
        `mic=${mic.actor.width}x${mic.actor.height}`);
    await screenshotTop(outDir, 'claude-panic-button-100', 120);
    writeClaudeConfig(claudeConfig({session: 21}));
    await waitFor(() => button._number.text === '21');
    await screenshotTop(outDir, 'claude-panic-button', 120);
    buttonNetwork.set(false, Gio.NetworkConnectivity.LOCAL);
    check('claude button: offline, "?" and a name that says why',
        button._number.text === '?' &&
        button.actor.accessible_name === 'Claude session usage: unknown (no internet connection)',
        `${button._number.text} / ${button.actor.accessible_name}`);
    buttonNetwork.set(true, Gio.NetworkConnectivity.FULL);

    network.set(false, Gio.NetworkConnectivity.LOCAL);
    await sleep(SETTLE_MS);
    const offline = claudeRows(view);
    check('claude: offline, every value reads "Unknown"',
        offline.length === 4 && offline.every(r => r[1] === 'Unknown' && r[2] === 'Resets: unknown') &&
        benchmarkRow(view)?.[1] === 'Unknown',
        JSON.stringify([...offline, benchmarkRow(view)]));
    check('claude: offline, a line says Claude cannot be asked',
        view._notice.visible && view._notice.text.startsWith('No internet connection') &&
        !view._footer.visible, view._notice.text);
    await screenshotTop(outDir, 'claude-offline', 465);
    network.set(true, Gio.NetworkConnectivity.PORTAL);
    await sleep(SETTLE_MS);
    check('claude: a captive portal is not a connection to Claude', view._notice.visible);
    network.set(true, Gio.NetworkConnectivity.FULL);
    await sleep(SETTLE_MS);
    check('claude: back online, the values return',
        !view._notice.visible && claudeRows(view)[0][1] === '21%', JSON.stringify(claudeRows(view)));

    // Hidden: nothing watched, nothing read. Shown again: read afresh.
    island().collapse();
    await sleep(animationWait());
    check('claude: collapsed, the file and the network are not watched',
        service._monitor === null && network.handlers.size === 0,
        `monitor=${service._monitor} network=${network.handlers.size}`);
    check('claude button: collapsed, it watches nothing either',
        button._service._monitor === null && buttonNetwork.handlers.size === 0);
    const reads = [];
    const read = service._read;
    service._read = function () {
        reads.push(Date.now());
        return read.call(this);
    };
    writeClaudeConfig(claudeConfig({session: 34}));
    await sleep(500);
    check('claude: collapsed, a change to the file is not read', reads.length === 0 &&
        claudeRows(view)[0][1] === '21%', `${reads.length} reads`);
    island().expand();
    await sleep(animationWait());
    check('claude: opening the tab again reads the latest usage',
        await waitFor(() => claudeRows(view)[0]?.[1] === '34%') && reads.length >= 1,
        `${reads.length} reads ${JSON.stringify(claudeRows(view))}`);
    service._read = read;
    check('claude button: reopening the island reads the latest usage',
        await waitFor(() => button._number.text === '34'), button._number.text);

    await testClaudeFreshness(view, service, button);

    await clickActor(tabButton('clock'));
    await sleep(animationWait());
    await clickActor(button.actor);
    await sleep(animationWait());
    check('claude button: a click opens the Claude tab', hub().activeFeature?.id === 'claude');

    writeClaudeConfig(claudeConfig({account: 'another-account'}));
    await waitFor(() => view._empty.visible);
    check('claude: usage cached for another account is not shown',
        view._empty.visible && !view._scroll.visible && view._rows.get_n_children() === 0);
    claudeFile().delete(null);
    await waitFor(() => service.error === 'missing');
    check('claude: without Claude Code\'s file, a hint instead of rows',
        view._empty.visible && service.error === 'missing' && !view._footer.visible,
        view._emptyTitle.text);
    await screenshotTop(outDir, 'claude-empty', 465);

    settings().set_boolean('claude-enabled', false);
    await sleep(SETTLE_MS);
    check('claude: turning the tab off removes it and stops watching',
        !hub()._entries.has('claude') && service._monitor === null && network.handlers.size === 0 &&
        hub().activeFeature?.id === 'clock');
    settings().reset('claude-enabled');
    settings().reset('panic-buttons');
    await sleep(SETTLE_MS);
    island().collapse();
    await sleep(animationWait());
}

// ---------------------------------------------------------------- settings

const settingsWindows = () => global.display.list_all_windows().filter(w =>
    w.get_wm_class() === 'org.gnome.Shell.Extensions' &&
    w.get_title() === 'Froonty');

async function waitForSettingsWindow(timeoutMs = 10000) {
    for (let waited = 0; waited < timeoutMs; waited += 100) {
        const [window] = settingsWindows();
        if (window)
            return window;
        await sleep(100);
    }
    return null;
}

async function closeSettingsWindows() {
    for (const window of settingsWindows())
        window.delete(global.display.get_current_time_roundtrip());
    for (let waited = 0; waited < 5000 && settingsWindows().length; waited += 100)
        await sleep(100);
}

async function testSettingsButton(outDir) {
    const modalBefore = Main.modalCount;
    island().expand();
    await sleep(animationWait());

    const gear = island()._hub.settingsButton;
    const g = boxOf(gear);
    const p = boxOf(pill());
    const [gx, gy] = [(g.x1 + g.x2) / 2, (g.y1 + g.y2) / 2];
    check('⚙️ button visible in the expanded island', gear.mapped && gear.opacity > 0);
    check('⚙️ button sits in the top-right corner',
        gx > p.x1 + (p.x2 - p.x1) * 0.75 && gy < p.y1 + (p.y2 - p.y1) * 0.35 &&
        g.x2 <= p.x2 && g.y1 >= p.y1,
        `button=[${g.x1},${g.y1} - ${g.x2},${g.y2}] pill=[${p.x1},${p.y1} - ${p.x2},${p.y2}]`);
    await screenshotTop(outDir, 'expanded-with-settings-button');

    await clickAt(gx, gy);
    const window = await waitForSettingsWindow();
    check('clicking ⚙️ opens the settings window', window !== null);
    check('clicking ⚙️ collapses the island and releases the grab',
        !island().expanded && Main.modalCount === modalBefore,
        `expanded=${island().expanded} modalCount=${Main.modalCount}`);
    // The window is listed when created (untitled) and focused once shown,
    // a few hundred ms later.
    for (let waited = 0; waited < 3000 && global.display.focus_window !== window; waited += 100)
        await sleep(100);
    check('settings window gets focus', window && global.display.focus_window === window,
        `focus=${global.display.focus_window?.get_title()}`);
    if (window) {
        const stream = Gio.File.new_for_path(GLib.build_filenamev([outDir, 'settings-window.png']))
            .replace(null, false, Gio.FileCreateFlags.NONE, null);
        await new Shell.Screenshot().screenshot(false, stream);
        stream.close(null);
    }

    // A second click must raise the open window, not fail or duplicate it.
    // Unfocus it first so "raised" is observable.
    Main.overview.show();
    await sleep(animationWait());
    Main.overview.hide();
    await sleep(animationWait());
    global.display.focus_default_window(global.get_current_time());
    island().expand();
    await sleep(animationWait());
    await clickAt(...(() => {
        const b = boxOf(gear);
        return [(b.x1 + b.x2) / 2, (b.y1 + b.y2) / 2];
    })());
    await sleep(1000);
    check('⚙️ again raises the same window instead of opening another',
        settingsWindows().length === 1 && global.display.focus_window === window,
        `windows=${settingsWindows().length} focus=${global.display.focus_window?.get_title()}`);
    await closeSettingsWindows();

    // Keyboard: Tab from the focused pill reaches ⚙️, Enter activates it.
    island().expand();
    await sleep(animationWait());
    for (let i = 0; i < 6 && global.stage.key_focus !== gear; i++)
        await pressKeys(Clutter.KEY_Tab);
    check('Tab reaches ⚙️', global.stage.key_focus === gear,
        `focus=${global.stage.key_focus}`);
    await pressKeys(Clutter.KEY_Return);
    check('Enter on ⚙️ opens the settings window', await waitForSettingsWindow() !== null);
    await sleep(SETTLE_MS);
    check('island collapsed after keyboard activation', !island().expanded);
    await closeSettingsWindows();
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
    // The new primary is whichever logical monitor the Shell does not use as
    // primary now, matched by position: right after a change Mutter 50 can
    // report no logical monitor as primary, so its flags cannot be flipped.
    const current = Main.layoutManager.primaryMonitor;
    const config = logicalMonitors.map(([x, y, lmScale, transform, , lmMonitors]) =>
        [x, y, lmScale, transform, x !== current.x || y !== current.y,
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

// ---------------------------------------------------------------- hub layout

async function testHubLayout(outDir) {
    island().expand();
    await sleep(animationWait());
    const hub = island()._hub;
    const tabs = hub._tabColumn.get_children();
    const boxes = tabs.map(boxOf);
    // One column; the island grows past expanded-height to show every tab.
    check('layout: feature tabs are stacked vertically on the left, all inside the island',
        tabs.length === 5 && boxes.every(b => Math.abs(b.x1 - boxes[0].x1) < 1) &&
        boxes.every((b, i) => i === 0 || b.y1 > boxes[i - 1].y1) &&
        boxes[0].x2 <= boxOf(hub._content).x1 && boxes.at(-1).y2 <= boxOf(pill()).y2,
        `${boxes.map(b => `[${b.x1},${b.y1}]`).join(' ')} island bottom=${boxOf(pill()).y2}`);
    const bar = boxOf(hub._panicBar.actor);
    const isle = boxOf(pill());
    check('layout: the panic bar is centered on the island, clear of tabs and ⚙️',
        Math.abs((bar.x1 + bar.x2) / 2 - (isle.x1 + isle.x2) / 2) <= 1 &&
        bar.x2 <= boxOf(hub.settingsButton).x1 && bar.x1 > Math.max(...boxes.map(b => b.x2)),
        `bar=[${bar.x1},${bar.x2}] island=[${isle.x1},${isle.x2}]`);

    await movePointerTo((boxes[1].x1 + boxes[1].x2) / 2, (boxes[1].y1 + boxes[1].y2) / 2);
    await sleep(SETTLE_MS);
    const tip = hub._tooltip.actor;
    check('layout: hovering a tab shows its feature name to the right',
        tip.visible && tip.text === 'Notes' && boxOf(tip).x1 >= boxes[1].x2 - 1,
        `visible=${tip.visible} text=${tip.text}`);
    await screenshotTop(outDir, 'hub-vertical-tabs');
    await movePointerTo(...pillCenter());
    await sleep(SETTLE_MS);
    check('layout: the tooltip hides when the pointer leaves', !tip.visible);
    island().collapse();
    await sleep(animationWait());
}

// ---------------------------------------------------------------- panic buttons

async function waitFor(predicate, timeoutMs = 5000) {
    for (let waited = 0; waited < timeoutMs; waited += 100) {
        if (predicate())
            return true;
        await sleep(100);
    }
    return predicate();
}

async function testPanic(outDir) {
    const s = settings();
    const mixer = Volume.getMixerControl();
    island().expand();
    await sleep(animationWait());
    const bar = () => island()._hub._panicBar;
    const [mic, sound] = bar()._buttons;
    check('panic: default bar is [mute microphone, mute sound]',
        bar()._buttons.length === 2 && mic.actor.accessible_name === 'Mute microphone' &&
        sound.actor.accessible_name === 'Mute sound');

    await movePointerTo(...(() => {
        const b = boxOf(sound.actor);
        return [(b.x1 + b.x2) / 2, (b.y1 + b.y2) / 2];
    })());
    await sleep(SETTLE_MS);
    const tip = island()._hub._tooltip.actor;
    check('panic: hovering a button shows its name below it',
        tip.visible && tip.text === 'Mute sound' && boxOf(tip).y1 >= boxOf(sound.actor).y2 - 1,
        `visible=${tip.visible} text=${tip.text}`);
    await screenshotTop(outDir, 'panic-tooltip');
    await movePointerTo(...pillCenter());

    // The private PipeWire and WirePlumber settle their default devices
    // during the first seconds; wait until both test devices are the
    // defaults, so the mute checks below do not race a device switch.
    const ready = await waitFor(() => mic.actor.reactive && sound.actor.reactive &&
        mixer.get_default_sink()?.name === 'froonty-test-speaker' &&
        mixer.get_default_source()?.name === 'froonty-test-mic', 15000);
    check('panic: buttons become active once the sound server is ready', ready,
        `mixer state=${mixer.get_state()} sink=${mixer.get_default_sink()?.name} ` +
        `source=${mixer.get_default_source()?.name}`);
    // Safety, checked once the devices have loaded (an empty list proves
    // nothing): the mute checks run only if every audio device the Shell
    // sees is a test device (run.sh disables WirePlumber's hardware
    // monitors).
    const devices = [...mixer.get_sinks(), ...mixer.get_sources()].map(d => d.name);
    const isolated = devices.length > 0 && devices.every(n => n?.startsWith('froonty-test'));
    check('panic: test audio is isolated from real hardware', isolated, devices.join(', '));
    if (ready && isolated) {
        const sink = mixer.get_default_sink();
        const source = mixer.get_default_source();
        await clickActor(sound.actor);
        check('panic: "Mute sound" mutes the default output',
            await waitFor(() => sink.is_muted) && sound.actor.checked);
        await clickActor(mic.actor);
        check('panic: "Mute microphone" mutes the default input',
            await waitFor(() => source.is_muted) && mic.actor.checked);
        await screenshotTop(outDir, 'panic-muted');
        await clickActor(sound.actor);
        check('panic: clicking again unmutes', await waitFor(() => !sink.is_muted) &&
            !sound.actor.checked);
        source.change_is_muted(false); // e.g. the mute key or Quick Settings
        check('panic: a mute change made elsewhere updates the button',
            await waitFor(() => !mic.actor.checked));
    }

    s.set_strv('panic-buttons', ['mute-sound']);
    await sleep(SETTLE_MS);
    check('panic: the bar follows the setting (one button)',
        bar()._buttons.length === 1 && bar()._buttons[0].actor.accessible_name === 'Mute sound');
    s.set_strv('panic-buttons', ['nope', 'mute-sound', 'mute-sound', 'mute-microphone']);
    await sleep(SETTLE_MS);
    check('panic: unknown ids and duplicates are ignored',
        bar()._buttons.map(b => b.actor.accessible_name).join(',') === 'Mute sound,Mute microphone');
    s.set_strv('panic-buttons', []);
    await sleep(SETTLE_MS);
    check('panic: an empty setting hides every slot', bar()._buttons.length === 0 &&
        bar().actor.get_n_children() === 0);
    s.reset('panic-buttons');
    await sleep(SETTLE_MS);
    island().collapse();
    await sleep(animationWait());
}

// ---------------------------------------------------------------- hover open

async function movePointerTo(x, y) {
    pointer.notify_absolute_motion(now(), x, y);
    await sleep(50);
}

async function testHoverOpen() {
    const s = settings();
    const monitor = Main.layoutManager.primaryMonitor;
    const away = [monitor.x + 60, monitor.y + monitor.height / 2];
    s.set_int('hover-open-delay', 350);

    await movePointerTo(...away);
    await movePointerTo(...pillCenter());
    await sleep(200);
    check('hover: not opened before the delay', !island().expanded);
    await sleep(350);
    check('hover: opened after resting 350 ms on the pill', island().expanded);

    await pressKeys(Clutter.KEY_Escape);
    await sleep(animationWait() + 400);
    check('hover: Escape closes it and it does not reopen while the pointer stays',
        !island().expanded);

    await movePointerTo(...away);
    await movePointerTo(...pillCenter());
    await sleep(150);
    await movePointerTo(...away);
    await sleep(500);
    check('hover: leaving before the delay cancels it', !island().expanded);

    s.set_int('hover-open-delay', 0);
    await movePointerTo(...pillCenter());
    await sleep(600);
    check('hover: delay 0 turns hover-open off', !island().expanded);
    await movePointerTo(...away);
}

// ---------------------------------------------------------------- launcher

async function testLauncher() {
    const s = settings();
    s.set_boolean('island-enabled', false);
    await sleep(SETTLE_MS);
    const launcher = Main.panel.statusArea['froonty-launcher'];
    check('launcher: "Show island" off puts a puzzle-piece icon in the top bar',
        strip() === null && launcher?.mapped &&
        launcher.get_first_child()?.icon_name === 'application-x-addon-symbolic');

    await clickActor(launcher);
    check('launcher: clicking the icon opens the settings window',
        await waitForSettingsWindow() !== null);
    await closeSettingsWindows();

    await pressKeys(Clutter.KEY_Super_L, Clutter.KEY_Alt_L, Clutter.KEY_i);
    check('launcher: the shortcut opens the settings while the island is hidden',
        await waitForSettingsWindow() !== null);
    await closeSettingsWindows();

    s.reset('island-enabled');
    await sleep(SETTLE_MS);
    check('launcher: showing the island removes the icon',
        strip() !== null && !Main.panel.statusArea['froonty-launcher']);
}

// ---------------------------------------------------------------- startup

const launcherName = () => Main.panel.statusArea['froonty-launcher']?.accessible_name ?? null;
const clockVisible = () => Main.panel.statusArea.dateMenu.container.opacity === 255;

// A login, as extension.js sees it: the first enable() in a Shell process.
async function freshStart() {
    await setExtensionEnabled(false);
    extension().stateObj._started = undefined;
    const ok = await setExtensionEnabled(true);
    await sleep(SETTLE_MS);
    return ok;
}

// A screen lock and unlock: GNOME Shell disables and re-enables extensions.
async function lockUnlock() {
    await setExtensionEnabled(false);
    const ok = await setExtensionEnabled(true);
    await sleep(SETTLE_MS);
    return ok;
}

async function testStartup() {
    const s = settings();
    const state = () => `strip=${strip() !== null} launcher=${launcherName()} clock=${clockVisible()}`;

    s.set_boolean('start-at-login', false);
    check('startup: login with "Start at login" off', await freshStart(), stateName());
    check('startup: Froonty then waits: no island, clock visible, a "Start Froonty" icon',
        strip() === null && clockVisible() && launcherName() === 'Start Froonty', state());

    await lockUnlock();
    check('startup: a screen unlock keeps it waiting',
        strip() === null && launcherName() === 'Start Froonty', state());

    await clickActor(Main.panel.statusArea['froonty-launcher']);
    await sleep(SETTLE_MS);
    check('startup: clicking the icon starts it: island shown, icon gone, clock covered',
        strip() !== null && launcherName() === null && !clockVisible(), state());

    await lockUnlock();
    check('startup: a screen unlock keeps it started',
        strip() !== null && launcherName() === null, state());

    await freshStart();
    await pressKeys(Clutter.KEY_Super_L, Clutter.KEY_Alt_L, Clutter.KEY_i);
    await sleep(SETTLE_MS);
    check('startup: the shortcut starts a waiting Froonty (collapsed)',
        strip() !== null && launcherName() === null && island()?.expanded === false, state());

    // With the island hidden too, starting leaves the settings icon.
    s.set_boolean('island-enabled', false);
    await freshStart();
    check('startup: waiting with "Show island" off shows the start icon',
        strip() === null && launcherName() === 'Start Froonty', state());
    await clickActor(Main.panel.statusArea['froonty-launcher']);
    await sleep(SETTLE_MS);
    check('startup: starting with "Show island" off leaves the settings icon',
        strip() === null && launcherName() === 'Froonty settings', state());
    s.reset('island-enabled');
    await sleep(SETTLE_MS);

    s.reset('start-at-login');
    await freshStart();
    check('startup: with "Start at login" on (default), a login shows the island at once',
        strip() !== null && launcherName() === null && !clockVisible(), state());
}

export async function runAll(outDir) {
    results.length = 0;
    // Pointer-driven checks move the pointer over the pill; keep hover-open
    // out of their way (testHoverOpen enables it explicitly).
    settings().set_int('hover-open-delay', 0);
    try {
        testLoaded();
        testGeometry();
        await testPointer(outDir);
        await testKeyboard();
        await testHubLayout(outDir);
        await testPanic(outDir);
        await testHoverOpen();
        await testLauncher();
        await testStartup();
        await testSettingsButton(outDir);
        await testHub(outDir);
        await testNotes(outDir);
        await testNotesTabsAndColors(outDir);
        await testClaude(outDir);
        await testClipboard(outDir);
        await testKillProcess(outDir);
        await testSettings(outDir);
        await testCoversPanelClock(outDir);
        await testMonitors();
        await testLifecycle();
        testLoaded();
    } catch (e) {
        check('test run completed without exception', false, `${e}\n${e.stack}`);
    }
    settings()?.reset('hover-open-delay');
    return results;
}
