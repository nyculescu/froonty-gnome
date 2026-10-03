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
import Soup from 'gi://Soup?version=3.0';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Volume from 'resource:///org/gnome/shell/ui/status/volume.js';
import {ExtensionState} from 'resource:///org/gnome/shell/misc/extensionUtils.js';

import {metadataVariants} from '../unit/fakeMpris.js';

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
// The pill is the first child of the strip's column (the attention bar
// comes after it).
const pill = () => island()?._pill ?? null;
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
        // The shared Media service: holders, and whether it exists.
        media: mediaSharedModule
            ? `${mediaSharedModule.mediaUsers()} users, ${mediaSharedModule.sharedMedia() ? 'running' : 'none'}`
            : 'not loaded',
        statusArea: Object.keys(Main.panel.statusArea).sort().join(','),
        // The Notifications tab's, only while it is on screen: not higher
        // merely because Froonty is enabled, hence not under `handlers`.
        trayHandlers: {
            sourceAdded: countHandlers(Main.messageTray, 'source-added'),
            sourceRemoved: countHandlers(Main.messageTray, 'source-removed'),
            // The Claude attention bar: a banner or the overview hides it.
            trayVisible: countHandlers(Main.messageTray, 'notify::visible'),
            overviewShowing: jsHandlerCount(Main.overview, 'showing'),
            overviewHidden: jsHandlerCount(Main.overview, 'hidden') - appGridHidden(),
        },
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
            // The Break tab follows GNOME's break engine.
            ...Object.fromEntries(['notify::state', 'notify::next-break-due-time',
                'notify::last-break-end-time', 'break-due', 'break-finished', 'take-break']
                .map(signal => [`breakManager ${signal}`, countHandlers(Main.breakManager, signal)])),
        },
        // GNOME's Wellbeing notifications: given back whenever Froonty is
        // turned off outside the lock screen.
        wellbeingEnable: new Gio.Settings({
            schema_id: 'org.gnome.desktop.notifications.application',
            path: '/org/gnome/desktop/notifications/application/gnome-wellbeing-panel/',
        }).get_user_value('enable')?.print(true) ?? null,
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
        // Taller than the tab column (seven tabs with it), so the island
        // takes exactly this size.
        hubSize: {width: 420, height: 300},
        createService: () => ({
            start: () => log.push('start'),
            stop: () => log.push('stop'),
            setActive: active => log.push(active ? 'active' : 'inactive'),
        }),
        createView: () => {
            log.push('view');
            const actor = new St.Label({text: 'fake feature'});
            // A button of its own in the hub header (view.headerActions).
            const action = new St.Button({
                style_class: 'froonty-icon-button',
                accessible_name: 'Fake action',
                can_focus: true,
                track_hover: true,
                child: new St.Icon({icon_name: 'dialog-information-symbolic'}),
            });
            log.action = action;
            action.connect('destroy', () => (log.actionDestroyed = true));
            return {actor, headerActions: [action], destroy: () => {
                log.push('destroy');
                action.destroy();
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

// The tabs the hub should show: every feature without an enable key,
// and those whose key is on, in registry order. Computed, so features
// that are on by default can be added without editing these checks.
async function expectedTabs() {
    const {FEATURES} = await import(`file://${extension().path}/features/registry.js`);
    return FEATURES.filter(f => !f.enabledKey || settings().get_boolean(f.enabledKey));
}

async function testHub(outDir) {
    const hub = island()._hub;
    const {FEATURES} = await import(`file://${extension().path}/features/registry.js`);
    const wasOn = FEATURES.filter(f => f.enabledKey && settings().get_boolean(f.enabledKey));
    for (const feature of wasOn)
        settings().set_boolean(feature.enabledKey, false);
    await sleep(SETTLE_MS);
    check('hub: a single feature hides the tab row', !hub._tabColumn.visible);
    settings().reset('notes-enabled');
    await sleep(SETTLE_MS);
    check('hub: enabling a feature adds its tab',
        hub._tabColumn.visible && hub._tabColumn.get_n_children() === 2);
    for (const feature of wasOn) {
        if (settings().get_default_value(feature.enabledKey).unpack())
            settings().reset(feature.enabledKey);
        else
            settings().set_boolean(feature.enabledKey, true);
        await sleep(SETTLE_MS);
    }
    // Names without GNOME's ", unread notifications" (the Notifications tab's).
    const names = hub._tabColumn.get_children()
        .map(b => b.accessible_name.replace(/, unread notifications$/, ''));
    const expected = (await expectedTabs()).map(f => f.title);
    check(`hub: tabs follow the registry order (${expected.join(', ')}); Calendar right after Clock`,
        names.join(',') === expected.join(',') && names[0] === 'Clock' && names[1] === 'Calendar',
        names.join(','));
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
        zeroTierWidth === 420 * scale() &&
        // A minimum: the island grows to show every tab.
        (zeroTierHeight === 280 * scale() ||
            (zeroTierHeight > 280 * scale() &&
             boxOf(hub._tabColumn.get_last_child()).y2 <= boxOf(pill()).y2)),
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

    const log = [];
    const tabsBefore = (await expectedTabs()).length;
    FEATURES.push(makeFakeFeature(log));
    try {
        await setExtensionEnabled(false);
        await setExtensionEnabled(true);
        check('hub: a registered feature adds a tab',
            island()._hub._tabColumn.get_n_children() === tabsBefore + 1,
            `${island()._hub._tabColumn.get_n_children()} tabs, ${tabsBefore} before`);
        check('hub: a feature is not created before its tab is selected',
            log.length === 0, log.join(','));

        island().expand();
        await sleep(animationWait());
        await clickActor(tabButton('test-fake'));
        await sleep(animationWait());
        const [w, h] = pill().get_transformed_size();
        check('hub: selecting a tab creates, starts and activates it',
            log.join(',') === 'start,view,active', log.join(','));
        // The height is a minimum: the island grows to show every tab.
        const lastTab = boxOf(island()._hub._tabColumn.get_children().at(-1));
        check('hub: island resizes to the feature\'s hubSize',
            w === 420 * scale() && h >= 220 * scale() &&
            (h === 220 * scale() || h - (lastTab.y2 - boxOf(pill()).y1) <= 16 * scale()),
            `${w}x${h}`);
        check('hub: selected tab is remembered',
            settings().get_string('hub-last-tab') === 'test-fake');
        await screenshotTop(outDir, 'hub-two-tabs');

        // Its header button: between 📅 and ⚙️, only while its tab is active.
        const hub = island()._hub;
        const action = log.action;
        const [cal, act, gear] = [hub.calendarButton, action, hub.settingsButton].map(boxOf);
        check('hub: a feature\'s header button sits between 📅 and ⚙️ while its tab is active',
            action?.mapped && cal.x2 <= act.x1 && act.x2 <= gear.x1 &&
            Math.abs((act.y1 + act.y2) - (gear.y1 + gear.y2)) <= 4,
            `📅=[${cal.x1},${cal.x2}] action=[${act.x1},${act.x2}] ⚙️=[${gear.x1},${gear.x2}]`);
        await movePointerTo((act.x1 + act.x2) / 2, (act.y1 + act.y2) / 2);
        await sleep(SETTLE_MS);
        check('hub: hovering it shows its name in the hub tooltip',
            hub._tooltip.actor.visible && hub._tooltip.actor.text === 'Fake action',
            `visible=${hub._tooltip.actor.visible} text=${hub._tooltip.actor.text}`);
        await movePointerTo(...pillCenter());

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
        check('hub: another tab hides the feature\'s header button',
            !log.action.mapped && !log.actionDestroyed);

        await clickActor(tabButton('test-fake'));
        await sleep(animationWait());
        island().collapse();
        await sleep(animationWait());
        log.length = 0;
        await setExtensionEnabled(false);
        check('hub: disable destroys the view and stops the service',
            log.includes('destroy') && log.includes('stop'), log.join(','));
        check('hub: and the view\'s header button with it', log.actionDestroyed === true);
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

    // A rename or select the service answers after the view is gone (a
    // rename commits on focus-out, as when the screen locks) leaves the
    // destroyed view alone. A second view over the same service.
    const service = hub()._entries.get('notes').service;
    {
        const {NotesView} = await import(`file://${extension().path}/features/notes/view.js`);
        const spare = new NotesView(hub()._ctx, service);
        const touched = [];
        spare._sync = () => touched.push('sync');
        spare._focusEditor = () => touched.push('focus');
        const pending = [
            spare._tabs._callbacks.onRename('plan'),
            spare._tabs._callbacks.onSelect('plan'),
            spare._create(),
        ];
        spare.destroy();
        await Promise.all(pending);
        await sleep(SETTLE_MS);
        check('notes: a rename, select or new note answered after the view is destroyed leaves it alone',
            touched.length === 0 && spare._service === null, touched.join(','));
        // The new note the spare view asked for goes; "plan" is selected again.
        const created = service.selected;
        if (created !== 'plan')
            await service.trash(created);
        await sleep(SETTLE_MS);
    }

    // An external edit of the clean first note shows up (inotify).
    await service.select(service.notes.find(n => n !== 'plan'));
    await sleep(SETTLE_MS);
    notesFolder().get_child(files[0]).replace_contents('edited elsewhere', null, false, 0, null);
    await sleep(1500);
    check('notes: an external edit reloads the open note',
        view._entry.text === 'edited elsewhere', view._entry.text);

    // × twice moves the selected note to the (isolated) Trash.
    // Tab content: [name, ×].
    const close = view._tabs._box.get_child_at_index(0).child.get_child_at_index(1);
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
    // No colour dot in any tab (user request): the name only, plus ×.
    const dotted = [];
    const visit = actor => {
        const classes = actor.style_class ?? '';
        if (/froonty-note-dot|froonty-note-color-/.test(classes))
            dotted.push(describeActor(actor));
        actor.get_children().forEach(visit);
    };
    const allTabs = view._tabs._box.get_children();
    allTabs.forEach(visit);
    check('tabs: no tab has a colour dot; a tab holds [name, ×]',
        dotted.length === 0 && allTabs.every(t => t.child.get_n_children() === 2 &&
            t.child.get_child_at_index(0) instanceof St.Label &&
            t.child.get_child_at_index(1).has_style_class_name('froonty-note-tab-close')),
        dotted.join(', '));
    check('colour: the surface and the colour button show green',
        view._scroll.has_style_class_name('froonty-note-color-green') &&
        view._colorPicker.button.child.has_style_class_name('froonty-note-color-green'));
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
        const shown = t.child.get_child_at_index(0).text;
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

    await testNoteLabels(outDir, view, service);

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
        !tooltip.visible && fourteen.child.get_child_at_index(0).text === fourteen.accessible_name,
        fourteen.accessible_name);
    await service.rename('Weekly planning and shopping list');
    await sleep(2 * SETTLE_MS);
    const longTab = view._tabs._box.get_children().find(t => t.checked);
    const longLabel = longTab.child.get_child_at_index(0);
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
    await testRenderedMarkdown(outDir, view);

    island().collapse();
    await sleep(animationWait());
}

// ---------------------------------------------------------------- note labels

const labelsFile = () => notesFolder().get_child('.froonty-labels.json');

function labelsOnDisk() {
    try {
        const [, bytes] = labelsFile().load_contents(null);
        return JSON.parse(new TextDecoder().decode(bytes)).labels;
    } catch {
        return null;
    }
}

const labelMenuOf = view => view._labelMenu._menu;

async function pressWith(modifier, keyval) {
    await pressKeys(modifier, keyval);
}

// A right-click on a note tab opens its labels in a GNOME popup menu under
// the tab; so do Menu and Shift+F10 on a focused tab.
async function testNoteLabels(outDir, view, service) {
    const inRow = t => {
        const b = boxOf(t);
        const r = boxOf(view._tabs._scroll);
        return b.x1 >= r.x1 - 1 && b.x2 <= r.x2 + 1;
    };
    const tabs = () => view._tabs._box.get_children();
    const target = tabs().find(t => !t.checked && inRow(t));
    const name = target.accessible_name;
    const selectedBefore = service.selected;
    const modalBefore = Main.modalCount;
    const focusBefore = global.stage.key_focus;
    const t = boxOf(target);
    pointer.notify_absolute_motion(now(), (t.x1 + t.x2) / 2, (t.y1 + t.y2) / 2);
    await sleep(50);
    pointer.notify_button(now(), Clutter.BUTTON_SECONDARY, Clutter.ButtonState.PRESSED);
    await sleep(30);
    pointer.notify_button(now(), Clutter.BUTTON_SECONDARY, Clutter.ButtonState.RELEASED);
    await sleep(animationWait());

    let menu = labelMenuOf(view);
    // The menu's visible box (its actor also holds the room of the arrow).
    const m = menu ? boxOf(menu.actor.bin) : null;
    const stack = Main.layoutManager.uiGroup.get_children();
    const state = () => `open=${labelMenuOf(view)?.isOpen} modal=${Main.modalCount} (before ${modalBefore}) ` +
        `selected=${service.selected} expanded=${island().expanded}`;
    check('labels: a right-click on a tab opens its menu below that tab, above the island',
        menu?.isOpen && m.y1 >= t.y2 - 1 && m.x1 < t.x2 && m.x2 > t.x1 &&
        stack.indexOf(menu.actor) > stack.indexOf(strip()),
        m ? `menu=[${m.x1},${m.y1} - ${m.x2},${m.y2}] tab=[${t.x1},${t.y1} - ${t.x2},${t.y2}]` : 'no menu');
    check('labels: the menu holds one modal grab; the tab is not selected or renamed',
        Main.modalCount === modalBefore + 1 && service.selected === selectedBefore &&
        !tabs().some(tab => tab.child instanceof St.Entry), state());
    check('labels: its entry has the key focus',
        global.stage.key_focus === view._labelMenu._entry?.clutter_text, `${global.stage.key_focus}`);
    await screenshotTop(outDir, 'notes-label-menu', 420);

    // Enter adds a new label to that note and keeps the menu open.
    await typeText('work');
    await screenshotTop(outDir, 'notes-label-menu-filtered', 420);
    await pressKeys(Clutter.KEY_Return);
    await sleep(2 * SETTLE_MS);
    check('labels: typing a new label and Enter writes it to .froonty-labels.json, menu still open',
        JSON.stringify(labelsOnDisk()?.[name]) === '["work"]' && labelMenuOf(view)?.isOpen &&
        view._labelMenu._entry.text === '', `${JSON.stringify(labelsOnDisk())} ${state()}`);
    const item = view._labelMenu._section.items.find(i => i.label?.text === 'work');
    check('labels: the new label is listed, ticked', item?.checked === true);

    await clickActor(item);
    await sleep(2 * SETTLE_MS);
    check('labels: a click on a ticked label removes it, menu still open',
        !labelsOnDisk()?.[name] && labelMenuOf(view)?.isOpen && item.checked === false,
        `${JSON.stringify(labelsOnDisk())} ${state()}`);
    await clickActor(item);
    await sleep(2 * SETTLE_MS);
    check('labels: and another click puts it back',
        JSON.stringify(labelsOnDisk()?.[name]) === '["work"]', JSON.stringify(labelsOnDisk()));

    // Folder events do not rebuild the tabs, so the menu stays.
    notesFolder().get_child('unrelated.txt').replace_contents('x', null, false, 0, null);
    await sleep(1500);
    check('labels: an unrelated change in the folder leaves the menu open',
        labelMenuOf(view)?.isOpen === true, state());
    notesFolder().get_child('unrelated.txt').delete(null);
    check('labels: labels never show in the tab',
        tabs().find(tab => tab.accessible_name === name)?.child.get_n_children() === 2);

    await pressKeys(Clutter.KEY_Escape);
    await sleep(animationWait());
    check('labels: Escape closes only the menu; the grab is gone, the focus is back',
        !labelMenuOf(view) && island().expanded && Main.modalCount === modalBefore &&
        global.stage.key_focus === focusBefore,
        `${state()} focus=${global.stage.key_focus} before=${focusBefore}`);
    const boxpointers = Main.layoutManager.uiGroup.get_children()
        .filter(a => a.has_style_class_name?.('froonty-label-menu'));
    check('labels: the closed menu is destroyed', boxpointers.length === 0, `${boxpointers.length} left`);

    // Keyboard: Menu, then Shift+F10, on a focused tab.
    const focusTab = tabs().find(tab => tab.accessible_name === name);
    focusTab.grab_key_focus();
    const focusTrail = [];
    const trailId = global.stage.connect('notify::key-focus',
        () => focusTrail.push(describeActor(global.stage.key_focus ?? global.stage)));
    await pressKeys(Clutter.KEY_Menu);
    await sleep(animationWait());
    global.stage.disconnect(trailId);
    check('labels: Menu on a focused tab opens its menu, the entry focused',
        labelMenuOf(view)?.isOpen && view._labelMenu._name === name &&
        global.stage.key_focus === view._labelMenu._entry?.clutter_text,
        `${state()} name=${view._labelMenu._name} focus trail: ${focusTrail.join(' > ')}`);
    await pressKeys(Clutter.KEY_Escape);
    await sleep(animationWait());
    check('labels: Escape gives the focus back to the tab',
        !labelMenuOf(view) && global.stage.key_focus === focusTab, `${global.stage.key_focus}`);
    await pressWith(Clutter.KEY_Shift_L, Clutter.KEY_F10);
    await sleep(animationWait());
    check('labels: Shift+F10 opens it too', labelMenuOf(view)?.isOpen === true, state());
    await pressKeys(Clutter.KEY_Escape);
    await sleep(animationWait());
    check('labels: and Escape closes it', !labelMenuOf(view) && Main.modalCount === modalBefore, state());

    // Regressions: Return selects a focused tab; a right-press then a
    // left-press on the selected tab is no double-click.
    focusTab.grab_key_focus();
    await pressKeys(Clutter.KEY_Return);
    await sleep(2 * SETTLE_MS);
    check('labels: Return on a focused tab still selects it', service.selected === name, service.selected);
    const selectedTab = tabs().find(tab => tab.checked);
    const sb = boxOf(selectedTab);
    pointer.notify_absolute_motion(now(), (sb.x1 + sb.x2) / 2 - 10, (sb.y1 + sb.y2) / 2);
    await sleep(50);
    pointer.notify_button(now(), Clutter.BUTTON_SECONDARY, Clutter.ButtonState.PRESSED);
    pointer.notify_button(now(), Clutter.BUTTON_SECONDARY, Clutter.ButtonState.RELEASED);
    await sleep(40);
    pointer.notify_button(now(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
    pointer.notify_button(now(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
    await sleep(animationWait());
    check('labels: a right-press then a left-press on the selected tab does not rename it',
        !tabs().some(tab => tab.child instanceof St.Entry), state());
    if (labelMenuOf(view))
        await pressKeys(Clutter.KEY_Escape);
    await sleep(animationWait());
    check('labels: no grab left', Main.modalCount === modalBefore && island().expanded, state());
}

// Rendered Markdown: the note is drawn formatted; its text stays Markdown.
// Markers hide off the line being edited, as in Obsidian's live preview.
async function testRenderedMarkdown(outDir, view) {
    const text = view._entry.clutter_text;
    const md = '# Shopping list\n**Bold**, _italic_ and ~~gone~~\n- [ ] milk\n- [x] bread\n' +
        'See [the docs](https://example.org) and `code`';
    view._entry.text = md;
    text.grab_key_focus();
    text.set_selection(0, 0); // on the heading
    await sleep(SETTLE_MS);
    const styled = text.get_attributes()?.get_attributes().length ?? 0;
    // "**Bold**" starts line 1 (offset 16): its "B" is at 18.
    const xOfB = () => text.position_to_coords(18)[1] - text.position_to_coords(16)[1];
    const hiddenWidth = xOfB();
    check('markdown: the note is drawn formatted, its text stays Markdown',
        styled > 10 && view._entry.text === md, `attributes=${styled}`);
    check('markdown: markers off the edited line take almost no room', hiddenWidth < 3,
        `"**" is ${hiddenWidth.toFixed(1)} px wide`);
    await screenshotTop(outDir, 'notes-markdown', 360);
    text.set_selection(20, 20); // into "Bold"
    await sleep(SETTLE_MS);
    check('markdown: the edited line shows its markers', xOfB() > 6,
        `"**" is ${xOfB().toFixed(1)} px wide`);
    await screenshotTop(outDir, 'notes-markdown-editing', 360);
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

// ---------------------------------------------------------------- notes header

const viewKey = () => settings().get_string('settings-window-view');

async function waitForKey(value, timeoutMs = 3000) {
    for (let waited = 0; waited < timeoutMs && viewKey() !== value; waited += 100)
        await sleep(100);
    return viewKey() === value;
}

async function waitForFocus(window, timeoutMs = 3000) {
    for (let waited = 0; waited < timeoutMs && global.display.focus_window !== window; waited += 100)
        await sleep(100);
    return global.display.focus_window === window;
}

async function screenshotAll(outDir, name) {
    const stream = Gio.File.new_for_path(GLib.build_filenamev([outDir, `${name}.png`]))
        .replace(null, false, Gio.FileCreateFlags.NONE, null);
    await new Shell.Screenshot().screenshot(false, stream);
    stream.close(null);
}

// Notes' "All notes" in the hub header: between 📅 and ⚙️, only on the
// Notes tab, tinted with the note's colour; it opens the settings window
// on its All notes page.
async function testNotesHeader(outDir) {
    const hub = () => island()._hub;
    const modalBefore = Main.modalCount;
    island().expand();
    await sleep(animationWait());
    await clickActor(tabButton('clock'));
    await sleep(animationWait());
    const {view, service} = hub()._entries.get('notes');
    const button = view._allNotes.actor;
    check('notes header: "All notes" is not shown on the Clock tab', !button.mapped);
    await clickActor(tabButton('notes'));
    await sleep(animationWait());
    const [cal, btn, gear] = [hub().calendarButton, button, hub().settingsButton].map(boxOf);
    const middle = b => (b.y1 + b.y2) / 2;
    check('notes header: on the Notes tab "All notes" sits between 📅 and ⚙️, centres level',
        button.mapped && cal.x2 <= btn.x1 && btn.x2 <= gear.x1 &&
        Math.abs(middle(cal) - middle(btn)) <= 2 && Math.abs(middle(gear) - middle(btn)) <= 2,
        `📅=[${cal.x1},${cal.y1} - ${cal.x2},${cal.y2}] button=[${btn.x1},${btn.y1} - ${btn.x2},${btn.y2}] ` +
        `⚙️=[${gear.x1},${gear.y1} - ${gear.x2},${gear.y2}]`);
    check('notes header: it is an icon button like ⚙️ (16 px icon, same size)',
        button.child.get_width() === 16 * scale() && Math.abs((btn.x2 - btn.x1) - (gear.x2 - gear.x1)) <= 1 &&
        Math.abs((btn.y2 - btn.y1) - (gear.y2 - gear.y1)) <= 1, `${btn.x2 - btn.x1}x${btn.y2 - btn.y1}`);
    const row = view._tabs.actor.get_children();
    check('notes header: the tab row holds only the note tabs, "+" and the fold button',
        row.length === 3 && row[1] === view._tabs.addButton && row[2] === view._toolsButton,
        row.map(describeActor).join(', '));

    await movePointerTo((btn.x1 + btn.x2) / 2, (btn.y1 + btn.y2) / 2);
    await sleep(SETTLE_MS);
    const tip = hub()._tooltip.actor;
    check('notes header: hovering it says "All notes"',
        tip.visible && tip.text === 'All notes' && button.accessible_name === 'All notes',
        `visible=${tip.visible} text=${tip.text}`);
    const editor = boxOf(view._scroll);
    const away = [(editor.x1 + editor.x2) / 2, (editor.y1 + editor.y2) / 2];
    await movePointerTo(...away);
    await sleep(SETTLE_MS);

    // Keyboard order: 📅 → All notes → ⚙️.
    hub().calendarButton.grab_key_focus();
    await pressKeys(Clutter.KEY_Tab);
    const first = global.stage.key_focus;
    await pressKeys(Clutter.KEY_Tab);
    const second = global.stage.key_focus;
    check('notes header: Tab goes 📅 → All notes → ⚙️',
        first === button && second === hub().settingsButton, `${first} then ${second}`);
    view._entry.clutter_text.grab_key_focus();
    await sleep(SETTLE_MS);

    // The tint follows the note's colour; ⚙️ stays plain.
    const background = actor => actor.get_theme_node().get_background_color();
    const rgba = c => `rgba(${c.red},${c.green},${c.blue},${c.alpha})`;
    const tints = () => button.style_class.split(/\s+/).filter(c => c.startsWith('froonty-notes-action-'));
    let restAlpha = 0;
    for (const color of ['yellow', 'green', 'charcoal']) {
        await service.setColor(color);
        await sleep(2 * SETTLE_MS);
        const c = background(button);
        const g = background(hub().settingsButton);
        const hue = color === 'yellow' ? c.red >= c.green && c.green > c.blue
            : color === 'green' ? c.green > c.red && c.green > c.blue : true;
        check(`notes header: ${color} note → the button has a faint ${color} wash, ⚙️ none`,
            tints().join() === `froonty-notes-action-${color}` && c.alpha > 0 && c.alpha < 128 &&
            g.alpha === 0 && hue, `${tints().join()} ${rgba(c)} ⚙️ ${rgba(g)}`);
        await screenshotTop(outDir, `notes-header-${color}`, 120);
        if (color === 'green')
            restAlpha = c.alpha;
    }
    await service.setColor('green');
    await sleep(2 * SETTLE_MS);
    await movePointerTo((btn.x1 + btn.x2) / 2, (btn.y1 + btn.y2) / 2);
    await sleep(SETTLE_MS);
    const hover = background(button);
    check('notes header: hovering it deepens the wash', button.hover && hover.alpha > restAlpha,
        `${rgba(hover)} at rest alpha ${restAlpha}`);
    await screenshotTop(outDir, 'notes-header-hover', 120);
    await movePointerTo(...away);
    button.grab_key_focus();
    await sleep(SETTLE_MS);
    const focused = background(button);
    check('notes header: focused, it keeps the deeper wash and the focus ring',
        focused.alpha > restAlpha && button.get_theme_node().get_box_shadow() !== null, rgba(focused));
    await screenshotTop(outDir, 'notes-header-focus', 120);
    view._entry.clutter_text.grab_key_focus();
    await service.setColor('yellow');
    await sleep(2 * SETTLE_MS);

    // Four panic buttons at the narrowest Notes width: the island grows
    // so the centred panic bar clears the tab column and the header.
    settings().set_strv('panic-buttons', ['mute-microphone', 'mute-sound', 'claude-session', 'pause-media']);
    settings().set_int('notes-width', 360);
    await sleep(animationWait() + SETTLE_MS);
    const node = pill().get_theme_node();
    const frame = node.get_horizontal_padding() + node.get_border_width(St.Side.LEFT) +
        node.get_border_width(St.Side.RIGHT);
    const [wide] = pill().get_transformed_size();
    const bar = boxOf(hub()._panicBar.actor);
    const leftmost = Math.min(...hub()._header.end.get_children().filter(b => b.visible).map(b => boxOf(b).x1));
    const tabsRight = boxOf(hub()._tabColumn).x2;
    check('notes header: with 4 panic buttons at width 360 the island grows to fit them',
        wide >= hub().minWidth + frame - 1 && wide > 360 * scale(),
        `island ${wide}, needs ${hub().minWidth} + ${frame}`);
    check('notes header: the panic bar stays 8 px clear of the header buttons and the tabs',
        leftmost - bar.x2 >= 8 * scale() - 1 && bar.x1 - tabsRight >= 8 * scale() - 1,
        `tabs end ${tabsRight}, bar [${bar.x1},${bar.x2}], header from ${leftmost}`);
    await screenshotTop(outDir, 'notes-header-4-panic-360', 120);
    settings().reset('panic-buttons');
    settings().reset('notes-width');
    await sleep(animationWait() + SETTLE_MS);
    const [back] = pill().get_transformed_size();
    check('notes header: back to the defaults, the island is 428 px wide again',
        back === 428 * scale(), `${back}`);

    // A click: the island closes (saving the note), the settings window
    // opens on All notes.
    await clickActor(button);
    const window = await waitForSettingsWindow();
    check('notes header: a click collapses the island and releases its grab',
        !island().expanded && Main.modalCount === modalBefore,
        `expanded=${island().expanded} modalCount=${Main.modalCount} before ${modalBefore}`);
    check('notes header: it asks for the All notes page', viewKey() === 'all-notes', viewKey());
    check('notes header: the "Froonty" window opens and gets the focus',
        window !== null && await waitForFocus(window), `focus=${global.display.focus_window?.get_title()}`);
    await sleep(1500);
    await screenshotAll(outDir, 'all-notes-window');

    // Again: the same window is raised.
    Main.overview.show();
    await sleep(animationWait());
    Main.overview.hide();
    await sleep(animationWait());
    global.display.focus_default_window(global.get_current_time());
    island().expand();
    await sleep(animationWait());
    await clickActor(view._allNotes.actor);
    await sleep(1000);
    check('notes header: a second click raises the same window',
        settingsWindows().length === 1 && global.display.focus_window === window,
        `windows=${settingsWindows().length} focus=${global.display.focus_window?.get_title()}`);

    // ⚙️ takes the window back to the settings.
    island().expand();
    await sleep(animationWait());
    await clickActor(hub().settingsButton);
    await sleep(1500);
    check('notes header: ⚙️ asks for the settings page of the same window',
        viewKey() === 'settings' && settingsWindows().length === 1, viewKey());
    await screenshotAll(outDir, 'all-notes-back-to-settings');
    await closeSettingsWindows();
    check('notes header: windows closed, the view key is "settings"',
        settingsWindows().length === 0 && await waitForKey('settings'), viewKey());
}

// End to end: the island's note, edited in the All notes window; then a
// conflict with another program. Opening on All notes also proves the
// subpage is pushed before the window is first shown.
async function testAllNotesWindow(outDir) {
    const hub = () => island()._hub;
    const {service, view} = hub()._entries.get('notes');
    const file = name => notesFolder().get_child(`${name}.md`);
    // What the island's tab row shows (not only what the service knows).
    const tabNames = () => view._tabs._box.get_children().map(tab => tab.accessible_name);
    file('e2e').replace_contents('hello', null, false, 0, null);
    file('follow').replace_contents('f', null, false, 0, null);
    await sleep(1500);
    await service.select('e2e');
    check('all notes: the island knows the note "e2e"', service.selected === 'e2e' && service.text === 'hello',
        `${service.selected}: ${service.text}`);

    island().expand();
    await sleep(animationWait());
    await clickActor(tabButton('notes'));
    await sleep(animationWait());
    await clickActor(hub()._entries.get('notes').view._allNotes.actor);
    const window = await waitForSettingsWindow();
    const focused = window !== null && await waitForFocus(window);
    await sleep(2000); // the page is shown, the notes read, the search focused
    check('all notes: the window opens focused on All notes', focused && viewKey() === 'all-notes',
        `focus=${global.display.focus_window?.get_title()} key=${viewKey()}`);
    await screenshotAll(outDir, 'all-notes-e2e');

    // Return in the empty search: into the note, at its end.
    await pressKeys(Clutter.KEY_Return);
    await typeText('!');
    await sleep(1500);
    check('all notes: typing in the window saves the note after the pause',
        readNote('e2e.md') === 'hello!', JSON.stringify(readNote('e2e.md')));
    island().expand();
    await sleep(animationWait());
    check('all notes: the island shows the window\'s edit', service.text === 'hello!', service.text);
    island().collapse();
    await sleep(animationWait());
    Main.activateWindow(window, global.display.get_current_time_roundtrip());
    await waitForFocus(window);
    await sleep(300);

    // Typing, then another program writes the note before the pause ends.
    await typeText('?');
    await sleep(100);
    file('e2e').replace_contents('external', null, false, 0, null);
    await sleep(1500);
    let copy = null;
    try {
        copy = readNote('e2e (conflict).md');
    } catch {}
    check('all notes: an edit elsewhere during typing keeps both: ours as "e2e (conflict)"',
        copy === 'hello!?' && readNote('e2e.md') === 'external',
        `copy=${JSON.stringify(copy)} e2e=${JSON.stringify(readNote('e2e.md'))}`);
    await screenshotAll(outDir, 'all-notes-conflict');
    await sleep(1500);
    check('all notes: the island\'s tab row shows the copy the window made',
        service.selected === 'e2e' && tabNames().includes('e2e (conflict)'),
        `selected=${service.selected} tabs=${tabNames().join(', ')}`);

    // The island moves to another note; its button raises the window,
    // which follows it (typing goes there, not into the copy).
    await service.select('follow');
    island().expand();
    await sleep(animationWait());
    await clickActor(view._allNotes.actor);
    const raised = await waitForFocus(window);
    await sleep(1500);
    await typeText('#');
    await sleep(1500);
    check('all notes: raised from the island on another note, the window follows it',
        raised && readNote('follow.md') === '#f' && readNote('e2e (conflict).md') === 'hello!?',
        `focus=${raised} follow=${JSON.stringify(readNote('follow.md'))} ` +
        `copy=${JSON.stringify(readNote('e2e (conflict).md'))}`);
    await screenshotAll(outDir, 'all-notes-follows-island');

    await closeSettingsWindows();
    check('all notes: closing the window on All notes sets the view key back to "settings"',
        settingsWindows().length === 0 && await waitForKey('settings'), viewKey());

    // A note made by another program shows as a tab, though the open
    // note did not change.
    file('zzz external').replace_contents('x', null, false, 0, null);
    await sleep(2000);
    check('all notes: a note that appears in the folder gets its tab at once',
        tabNames().includes('zzz external') && service.notes.includes('zzz external'),
        tabNames().join(', '));
    file('zzz external').delete(null);
    await sleep(1500);
}

// The settings-window-view key never outlives a window that is not there:
// on enable (login, unlock) and when the wait for a requested window gives
// up (e.g. another extension's preferences were open), it goes back to
// "settings"; with the window open on All notes it is kept.
async function testSettingsViewKey() {
    settings().set_string('settings-window-view', 'all-notes'); // left over
    await setExtensionEnabled(false);
    await setExtensionEnabled(true);
    check('view key: a left-over "all-notes" without a window is reset on enable',
        viewKey() === 'settings', viewKey());

    extension().stateObj._settingsWindow.open('all-notes');
    const window = await waitForSettingsWindow();
    await sleep(1500);
    await setExtensionEnabled(false); // as a screen lock does
    await setExtensionEnabled(true);
    check('view key: kept while the window is open on All notes (lock and unlock)',
        window !== null && viewKey() === 'all-notes' && settingsWindows().length === 1,
        `key=${viewKey()} windows=${settingsWindows().length}`);
    await closeSettingsWindows();
    await waitForKey('settings');

    // Nothing opens (as when another extension's preferences are open:
    // the service answers "Already showing a prefs dialog").
    const settingsWindow = extension().stateObj._settingsWindow;
    settingsWindow._request = async () => {};
    settingsWindow.open('all-notes');
    const asked = viewKey();
    await sleep(5000);
    const waiting = viewKey();
    // The wait is a timeout_add_seconds (10 s), which GLib may run up to
    // a second late.
    const reset = await waitFor(() => viewKey() === 'settings', 8000);
    delete settingsWindow._request;
    check('view key: no window came: back to "settings" when the wait gives up',
        asked === 'all-notes' && waiting === 'all-notes' && reset && settingsWindows().length === 0,
        `asked=${asked} after 5 s=${waiting} now=${viewKey()} windows=${settingsWindows().length}`);
}

// Disable (e.g. a screen lock) with the label menu open: no menu, grab or
// handler is left behind.
async function testLabelMenuLifecycle() {
    const hub = () => island()._hub;
    const modalBefore = Main.modalCount;
    const menus = () => Main.layoutManager.uiGroup.get_children()
        .filter(a => a.has_style_class_name?.('popup-menu-boxpointer')).length;
    const handlers = () => ({
        systemModal: countHandlers(Main.layoutManager, 'system-modal-opened'),
        session: jsHandlerCount(Main.sessionMode, 'updated'),
    });
    island().expand();
    await sleep(animationWait());
    await clickActor(tabButton('notes'));
    await sleep(animationWait());
    const view = hub()._entries.get('notes').view;
    const menusBefore = menus();
    const handlersBefore = handlers();
    const tab = view._tabs._box.get_children().find(t => t.checked);
    tab.grab_key_focus();
    await pressKeys(Clutter.KEY_Menu);
    await sleep(animationWait());
    check('labels lifecycle: the menu is open before disabling',
        view._labelMenu.isOpen && menus() === menusBefore + 1 && Main.modalCount === modalBefore + 2,
        `menus=${menus()} modal=${Main.modalCount}`);
    await setExtensionEnabled(false);
    check('labels lifecycle: disable removes the open menu and both grabs',
        menus() === menusBefore && Main.modalCount === modalBefore, `menus=${menus()} modal=${Main.modalCount}`);
    await setExtensionEnabled(true);
    await sleep(SETTLE_MS);
    check('labels lifecycle: after enable, the same handlers as before',
        JSON.stringify(handlers()) === JSON.stringify(handlersBefore),
        `${JSON.stringify(handlersBefore)} -> ${JSON.stringify(handlers())}`);
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
    check('clipboard: "Plain text" is offered only for formatted text',
        view && !view._plainButton.visible && recorder.currentFormatted === false);
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

// ---------------------------------------------------------------- writing

// The Writing tab (working-tree only, docs/features/writing.md). run.sh's
// fake Claude Code records each run under $CLAUDE_CONFIG_DIR/writing; a
// local Soup.Server in this Shell stands in for LanguageTool and Ollama.
// Nothing reaches a real service.

const writingEntry = () => island()?._hub._entries.get('writing') ?? null;
const writingPath = name => GLib.build_filenamev([claudeDir(), 'writing', name]);

function readWriting(name) {
    try {
        return new TextDecoder().decode(GLib.file_get_contents(writingPath(name))[1]);
    } catch (e) {
        return null;
    }
}

function removeWriting(...names) {
    for (const name of names)
        GLib.unlink(writingPath(name));
}

function processAlive(pid) {
    try {
        const stat = new TextDecoder().decode(GLib.file_get_contents(`/proc/${pid}/stat`)[1]);
        return !/\) Z /.test(stat);
    } catch (e) {
        return false;
    }
}

function writingServer() {
    const fake = {requests: [], ltStatus: 200};
    const answer = path => {
        switch (path) {
        case '/v2/check':
            return fake.ltStatus === 200
                ? [200, 'application/json', JSON.stringify({matches: [{offset: 0, length: 3,
                    message: 'Possible spelling mistake found.', replacements: [{value: 'the'}],
                    context: {text: 'teh cat', offset: 0, length: 3}}]})]
                : [fake.ltStatus, 'text/plain', 'Too many requests'];
        case '/api/version':
            return [200, 'application/json', '{"version":"0.35.1"}'];
        case '/api/tags':
            return [200, 'application/json', JSON.stringify({models: [
                {name: 'llama3.2:3b', size: 2019393189, digest: 'a'.repeat(64)},
                {name: 'x:cloud', remote_host: 'https://ollama.com:443', remote_model: 'x'}]})];
        case '/api/show':
            return [200, 'application/json', '{"capabilities":["completion"]}'];
        case '/api/chat':
            return [200, 'application/x-ndjson', [
                {message: {role: 'assistant', content: 'Rewritten '}, done: false},
                {message: {role: 'assistant', content: 'locally.'}, done: false},
                {message: {role: 'assistant', content: ''}, done: true}]
                .map(o => JSON.stringify(o)).join('\n')];
        default:
            return [404, 'application/json', '{"error":"not found"}'];
        }
    };
    fake.server = new Soup.Server({});
    fake.server.add_handler(null, (_server, message, path) => {
        const bytes = message.get_request_body().flatten().get_data() ?? new Uint8Array();
        fake.requests.push({method: message.get_method(), path, body: new TextDecoder().decode(bytes)});
        const [status, type, text] = answer(path);
        message.set_status(status, null);
        message.set_response(type, Soup.MemoryUse.COPY, new TextEncoder().encode(text));
    });
    fake.server.listen_local(0, Soup.ServerListenOptions.IPV4_ONLY);
    fake.url = fake.server.get_uris()[0].to_string().replace(/\/$/, '');
    return fake;
}

const shownActions = view => view._actionsBox.get_children().flatMap(row => row.get_children())
    .map(button => [...view._actionButtons].find(([, b]) => b === button)?.[0]);

async function testWriting(outDir) {
    let s = settings();
    const fake = writingServer();
    const urls = ['FROONTY_LANGUAGETOOL_URL', 'FROONTY_OLLAMA_URL'].map(name => [name, GLib.getenv(name)]);
    GLib.setenv('FROONTY_LANGUAGETOOL_URL', `${fake.url}/v2/check`, true);
    GLib.setenv('FROONTY_OLLAMA_URL', fake.url, true);
    try {
        check('writing: off by default, so no tab and nothing run',
            !s.get_boolean('writing-enabled') && !tabButton('writing') &&
            readWriting('run.argv') === null && readWriting('auth.log') === null);

        // No engine switched on: the tab says so and links to its settings.
        s.set_boolean('writing-enabled', true);
        await sleep(SETTLE_MS);
        island().expand();
        await sleep(animationWait());
        await clickActor(tabButton('writing'));
        await sleep(animationWait());
        let {view, service} = writingEntry();
        service.network = new FakeNetwork();
        check('writing: with no engine on, the tab says so',
            view._empty.visible && !view._main.visible &&
            view._emptyLabel.text === 'No writing engine is turned on.', view._emptyLabel.text);
        const [w, h] = pill().get_transformed_size();
        check('writing: the tab opens at its configured size',
            w === 460 * scale() && h === 540 * scale(), `${w}x${h}`);
        await screenshotTop(outDir, 'writing-empty', 560);
        await clickActor(view._settingsButton);
        const window = await waitForSettingsWindow();
        const emptied = await waitFor(() => s.get_string('prefs-page') === '', 8000);
        check('writing: "Open Settings → Writing" opens the settings on that page and empties the key',
            window !== null && emptied && !island().expanded,
            `window=${window !== null} prefs-page=${s.get_string('prefs-page')}`);
        if (window) {
            await sleep(1500);
            const stream = Gio.File.new_for_path(GLib.build_filenamev([outDir, 'writing-settings.png']))
                .replace(null, false, Gio.FileCreateFlags.NONE, null);
            await new Shell.Screenshot().screenshot(false, stream);
            stream.close(null);
        }
        await closeSettingsWindows();

        // Claude Code only.
        s.set_boolean('writing-claude-code-enabled', true);
        island().expand();
        await sleep(animationWait());
        check('writing: Claude Code alone: no engine choice, and where the text goes',
            await waitFor(() => view._main.visible) && view._engineButtons.size === 1 &&
            !view._engineRow.visible &&
            view._destination.text === 'Sends to Anthropic, through your Claude Code (Haiku · your plan\'s usage)',
            view._destination.text);
        check('writing: Claude Code offers all six actions',
            shownActions(view).join(',') === 'paraphrase,grammar,shorten,formal,casual,summarise',
            shownActions(view).join(','));

        stClipboard().set_text(CLIPBOARD, 'Clipboard before');
        view._input.text = 'Their going to the libary tomorow.';
        await sleep(SETTLE_MS);
        await clickActor(view._actionButtons.get('paraphrase'));
        check('writing: a Claude rewrite is shown, as plain text',
            await waitFor(() => service.state === 'done') && view._result.text === 'Fake rewrite.' &&
            view._resultTools.visible && view._copyButton.mapped,
            `${service.state} ${JSON.stringify(service.error)}`);
        const {claudeArgv} = await import(`file://${extension().path}/features/writing/engines/claudeCode.js`);
        const expected = JSON.stringify(claudeArgv(GLib.getenv('FROONTY_CLAUDE_CODE'), 'paraphrase', 'haiku').slice(1));
        const argv = () => JSON.stringify(readWriting('run.argv')?.split('\0').slice(0, -1) ?? null);
        check('writing: Claude Code runs with the fixed argv: every tool, MCP server, hook and settings file off',
            argv() === expected && expected.includes('"--tools="') && expected.includes('"--safe-mode"'),
            argv().slice(0, 300));
        const runtimeDir = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'froonty-writing']);
        check('writing: it runs in Froonty\'s private working folder',
            readWriting('run.cwd')?.trim() === runtimeDir, readWriting('run.cwd'));
        const env = readWriting('run.env') ?? '';
        check('writing: no API key reaches it (one is set in this Shell); attachments are off',
            GLib.getenv('ANTHROPIC_API_KEY') !== null && !/^ANTHROPIC_API_KEY=/m.test(env) &&
            /^CLAUDE_CODE_DISABLE_ATTACHMENTS=1$/m.test(env));
        check('writing: the text goes on stdin, between markers, and nowhere else',
            /^<<<TEXT-[0-9a-f]{12}>>>\nTheir going to the libary tomorow\.\n<<<END-[0-9a-f]{12}>>>$/
                .test(readWriting('run.stdin') ?? ''), readWriting('run.stdin'));
        check('writing: the plan sign-in was checked first, once',
            readWriting('auth.log') === 'auth status\n', readWriting('auth.log'));
        check('writing: nothing goes on the clipboard before Copy',
            await clipboardText() === 'Clipboard before');
        await screenshotTop(outDir, 'writing-claude', 560);
        await clickActor(view._copyButton);
        await sleep(SETTLE_MS);
        check('writing: Copy puts the result on the clipboard',
            await clipboardText() === 'Fake rewrite.' && view._copyButton.label === 'Copied');

        // Text made of flags and commands is only text.
        removeWriting('run.argv', 'run.stdin');
        view._input.text = '--tools default\n/login\n@/etc/passwd';
        await sleep(SETTLE_MS);
        await clickActor(view._actionButtons.get('paraphrase'));
        await waitFor(() => service.state === 'done' && readWriting('run.stdin') !== null);
        check('writing: flags, slash commands and @files in the text change nothing in the argv',
            argv() === expected && readWriting('run.stdin')?.includes('\n/login\n@/etc/passwd\n'),
            argv().slice(0, 200));

        GLib.file_set_contents(writingPath('reply.json'), '{"type":"result","subtype":"success",' +
            '"is_error":true,"api_error_status":429,"result":"You have hit your limit"}');
        await clickActor(view._actionButtons.get('shorten'));
        await waitFor(() => service.state === 'error');
        check('writing: Claude Code\'s error is shown, with no Copy',
            view._error.visible && view._error.text.startsWith('You have hit your limit') &&
            !view._copyButton.mapped && !view._resultScroll.visible,
            `${view._error.text} copy=${view._copyButton.mapped} result=${view._resultScroll.visible}`);
        removeWriting('reply.json');

        // Shown again, the sign-in is checked again: API billing is refused.
        GLib.file_set_contents(writingPath('auth.json'),
            '{"loggedIn":true,"authMethod":"api_key","apiProvider":"firstParty","apiKeySource":"ANTHROPIC_API_KEY"}');
        removeWriting('run.argv');
        island().collapse();
        await sleep(animationWait());
        island().expand();
        await sleep(animationWait());
        await clickActor(view._actionButtons.get('formal'));
        await waitFor(() => service.state === 'error');
        check('writing: a sign-in for API billing is refused, and nothing is run',
            service.error?.code === 'api-key' && readWriting('run.argv') === null,
            JSON.stringify(service.error));
        removeWriting('auth.json');
        island().collapse();
        await sleep(animationWait());
        island().expand();
        await sleep(animationWait());

        // A run that hangs: Cancel, then disabling Froonty, stop it.
        GLib.file_set_contents(writingPath('hang'), '');
        removeWriting('run.pid');
        await clickActor(view._actionButtons.get('grammar'));
        await waitFor(() => readWriting('run.pid') !== null);
        const pid = readWriting('run.pid')?.trim();
        check('writing: busy while it runs, with Cancel',
            service.state === 'busy' && view._busy.visible &&
            view._busyLabel.text === 'Rewriting with Claude Code…', view._busyLabel.text);
        await screenshotTop(outDir, 'writing-busy', 560);
        await clickActor(view._cancelButton);
        check('writing: Cancel stops Claude Code within 2 s and the tab is idle',
            Boolean(pid) && await waitFor(() => !processAlive(pid), 2000) && service.state === 'idle' &&
            !view._busy.visible, `pid=${pid} alive=${processAlive(pid)} ${service.state}`);
        removeWriting('run.pid');
        await clickActor(view._actionButtons.get('grammar'));
        await waitFor(() => readWriting('run.pid') !== null);
        const pid2 = readWriting('run.pid')?.trim();
        await setExtensionEnabled(false);
        const stopped = await waitFor(() => !processAlive(pid2), 2000);
        await setExtensionEnabled(true);
        check('writing: disabling Froonty (a screen lock does) stops a run in flight',
            Boolean(pid2) && stopped, `pid=${pid2}`);
        removeWriting('hang');

        s = settings();
        island().expand();
        await sleep(animationWait());
        ({view, service} = writingEntry());
        service.network = new FakeNetwork();
        service.setActive(true);
        await sleep(SETTLE_MS);

        // From clipboard: text only, never the hidden password.
        s.set_boolean('clipboard-enabled', true);
        await sleep(SETTLE_MS);
        check('writing: "From clipboard" is there while the Clipboard tab is on',
            view._clipboardButton.visible);
        stClipboard().set_text(CLIPBOARD, 'Kx9vR2mQpL4wTz8!');
        await sleep(SETTLE_MS);
        view._input.text = '';
        await clickActor(view._clipboardButton);
        check('writing: a hidden password on the clipboard is never offered',
            view._input.text === '' &&
            view._notice.text === 'The clipboard holds a hidden password; it is never offered here.',
            view._notice.text);
        stClipboard().set_text(CLIPBOARD, 'Copied for rewriting');
        await sleep(SETTLE_MS);
        await clickActor(view._clipboardButton);
        check('writing: copied text goes into the box',
            view._input.text === 'Copied for rewriting' && service.input === 'Copied for rewriting');
        s.reset('clipboard-enabled');
        await sleep(SETTLE_MS);

        // LanguageTool.
        s.set_boolean('writing-languagetool-enabled', true);
        await waitFor(() => view._engineButtons.size === 2 && service.availabilityOf('languagetool').ready);
        await clickActor(view._engineButtons.get('languagetool'));
        await sleep(SETTLE_MS);
        view._input.text = 'teh cat';
        await sleep(SETTLE_MS);
        check('writing: LanguageTool offers Fix grammar only, and says where the text goes',
            service.engine.id === 'languagetool' && shownActions(view).join(',') === 'grammar' &&
            view._destination.text === 'Sends to LanguageTool (languagetool.org): grammar and spelling only',
            `${shownActions(view)} ${view._destination.text}`);
        await clickActor(view._actionButtons.get('grammar'));
        await waitFor(() => service.state === 'done');
        const checks = fake.requests.filter(r => r.path === '/v2/check');
        const form = checks.length ? Soup.form_decode(checks[0].body) : {};
        check('writing: LanguageTool gets one form POST: text, language=auto, preferred variants',
            checks.length === 1 && checks[0].method === 'POST' && form.text === 'teh cat' &&
            form.language === 'auto' && form.preferredVariants === 'en-US,de-DE', JSON.stringify(form));
        check('writing: its correction, the change, and the link to languagetool.org',
            view._result.text === 'the cat' &&
            view._changes.text === '1 change\n“teh” → “the”: Possible spelling mistake found.' &&
            view._attribution.visible && view._attribution.label === 'Checked by LanguageTool · languagetool.org',
            view._changes.text);
        await screenshotTop(outDir, 'writing-languagetool', 560);
        fake.ltStatus = 429;
        await clickActor(view._actionButtons.get('grammar'));
        await waitFor(() => service.state === 'error');
        check('writing: LanguageTool\'s limit is explained',
            service.error?.code === 'rate-limited' &&
            view._error.text.startsWith('LanguageTool\'s free service is busy'), view._error.text);

        // Ollama.
        s.set_string('writing-ollama-model', 'llama3.2:3b');
        s.set_boolean('writing-ollama-enabled', true);
        await waitFor(() => view._engineButtons.size === 3 && service.availabilityOf('ollama').ready);
        await clickActor(view._engineButtons.get('ollama'));
        await sleep(SETTLE_MS);
        view._input.text = 'Make this shorter please, it is far too long.';
        await sleep(SETTLE_MS);
        check('writing: Ollama says the text stays on this computer',
            view._destination.text === 'Stays on this computer: Ollama, llama3.2:3b', view._destination.text);
        await clickActor(view._actionButtons.get('shorten'));
        await waitFor(() => service.state === 'done');
        const chat = fake.requests.find(r => r.path === '/api/chat');
        const body = chat ? JSON.parse(chat.body) : {};
        check('writing: Ollama gets the system prompt and the text, and streams the rewrite back',
            body.stream === true && body.model === 'llama3.2:3b' &&
            body.messages?.map(m => m.role).join(',') === 'system,user' &&
            body.messages[1].content.includes('Make this shorter please') &&
            view._result.text === 'Rewritten locally.', `${view._result.text} ${chat?.body.slice(0, 120)}`);
        s.set_string('writing-ollama-model', 'x:cloud');
        await waitFor(() => !service.availabilityOf('ollama').ready);
        check('writing: an Ollama cloud model is never ready',
            service.availabilityOf('ollama').reason === 'model not downloaded' &&
            view._engineButtons.get('ollama').has_style_pseudo_class('insensitive'),
            JSON.stringify(service.availabilityOf('ollama')));
        await screenshotTop(outDir, 'writing-engines', 560);

        // Engines switched off leave the tab.
        s.set_boolean('writing-languagetool-enabled', false);
        await waitFor(() => view._engineButtons.size === 2);
        check('writing: an engine switched off is not in the tab at all',
            !view._engineButtons.has('languagetool') && view._engineButtons.has('ollama'));
        s.set_boolean('writing-ollama-enabled', false);
        s.set_boolean('writing-claude-code-enabled', false);
        check('writing: with every engine off, the tab says so again',
            await waitFor(() => view._empty.visible) &&
            view._emptyLabel.text === 'No writing engine is turned on.', view._emptyLabel.text);

        await clickActor(tabButton('clock'));
        await sleep(animationWait());
        island().collapse();
        await sleep(animationWait());
        for (const key of s.settings_schema.list_keys().filter(k => k.startsWith('writing-')))
            s.reset(key);
        await sleep(SETTLE_MS);
        check('writing: turning the tab off removes it, its service and its handlers',
            !tabButton('writing') && !island()._hub._entries.has('writing') &&
            countHandlers(s, 'changed::writing-engine') === 0 &&
            countHandlers(s, 'changed::writing-ollama-model') === 0,
            `${countHandlers(s, 'changed::writing-engine')} ${countHandlers(s, 'changed::writing-ollama-model')}`);
    } finally {
        for (const [name, value] of urls)
            GLib.setenv(name, value ?? '', true);
        fake.server.disconnect();
        removeWriting('hang');
    }
}

// The Writing tab after its review: readiness follows the network while
// the tab is shown, Ollama's reasons, the caret after a long paste, a
// result's selection kept while typing, the Clipboard tab's hidden
// password pasted with Ctrl+V, and the engine buttons while a request runs.
// The same fakes as testWriting; FROONTY_OLLAMA_SYSTEM_ROOT (run.sh) is an
// empty folder standing in for /usr, /etc and /lib.

const caretInView = view => {
    const text = view._input.clutter_text;
    const [ok, , y, lineHeight] = text.position_to_coords(text.cursor_position);
    const top = y + view._input.y + text.y;
    const v = view._inputScroll.vadjustment;
    return {ok: ok && top >= v.value && top + lineHeight <= v.value + v.page_size,
        detail: `caret ${Math.round(top)}-${Math.round(top + lineHeight)}, page ` +
            `${Math.round(v.value)}-${Math.round(v.value + v.page_size)} of ${Math.round(v.upper)}`};
};

async function reshowWriting() {
    island().collapse();
    await sleep(animationWait());
    island().expand();
    await sleep(animationWait());
}

async function testWritingFixes(outDir) {
    const s = settings();
    const fake = writingServer();
    const saved = ['FROONTY_LANGUAGETOOL_URL', 'FROONTY_OLLAMA_URL'].map(name => [name, GLib.getenv(name)]);
    const systemRoot = GLib.getenv('FROONTY_OLLAMA_SYSTEM_ROOT');
    const fakeOllama = GLib.build_filenamev([systemRoot ?? '/nonexistent', 'usr', 'bin', 'ollama']);
    GLib.setenv('FROONTY_LANGUAGETOOL_URL', `${fake.url}/v2/check`, true);
    GLib.setenv('FROONTY_OLLAMA_URL', 'http://127.0.0.1:1', true);
    try {
        // LanguageTool alone, the tab opened while the network is local only
        // (as right after a resume, before Wi-Fi is back).
        s.set_boolean('writing-enabled', true);
        s.set_boolean('writing-languagetool-enabled', true);
        await sleep(SETTLE_MS);
        island().expand();
        await sleep(animationWait());
        await clickActor(tabButton('writing'));
        await sleep(animationWait());
        const {view, service} = writingEntry();
        const network = new FakeNetwork();
        network.set(true, Gio.NetworkConnectivity.LOCAL);
        service.network = network;
        service.setActive(true);
        check('writing fixes: offline, LanguageTool alone: the tab says why',
            await waitFor(() => view._empty.visible) &&
            view._emptyLabel.text === 'None of your writing engines is ready: LanguageTool: offline.',
            view._emptyLabel.text);
        const watching = network.handlers.size;
        network.set(true, Gio.NetworkConnectivity.FULL);
        check('writing fixes: back online while the tab is shown, it comes back by itself',
            watching === 3 && await waitFor(() => view._main.visible) &&
            service.availabilityOf('languagetool').ready,
            `handlers=${watching} empty=${view._empty.visible}`);
        island().collapse();
        await sleep(animationWait());
        check('writing fixes: collapsed, the network is not watched', network.handlers.size === 0,
            `${network.handlers.size}`);

        // Ollama alone: not installed, not running, no model chosen.
        s.set_boolean('writing-languagetool-enabled', false);
        s.set_boolean('writing-ollama-enabled', true);
        island().expand();
        await sleep(animationWait());
        check('writing fixes: no Ollama on this computer: "not installed", not "not running"',
            await waitFor(() => view._emptyLabel.text ===
                'None of your writing engines is ready: Ollama: not installed.'), view._emptyLabel.text);
        GLib.mkdir_with_parents(GLib.path_get_dirname(fakeOllama), 0o755);
        GLib.file_set_contents(fakeOllama, '#!/bin/sh\nexit 0\n');
        await reshowWriting();
        check('writing fixes: an Ollama of yours that is stopped: "not running"',
            await waitFor(() => view._emptyLabel.text ===
                'None of your writing engines is ready: Ollama: not running.'), view._emptyLabel.text);
        GLib.setenv('FROONTY_OLLAMA_URL', fake.url, true);
        await reshowWriting();
        check('writing fixes: Ollama running, no model chosen: says so',
            await waitFor(() => view._emptyLabel.text ===
                'None of your writing engines is ready: Ollama: no model chosen.'), view._emptyLabel.text);
        s.set_string('writing-ollama-model', 'llama3.2:3b');
        await waitFor(() => view._main.visible && service.availabilityOf('ollama').ready);

        // A long paste (40 lines, Ctrl+V) and typing on: the caret stays in view.
        const lines = Array.from({length: 40}, (_, i) =>
            `Line ${i + 1}: some words to fill the box, so that it has to scroll.`);
        stClipboard().set_text(CLIPBOARD, lines.join('\n'));
        await sleep(SETTLE_MS);
        view._input.text = '';
        view._input.clutter_text.grab_key_focus();
        await pressKeys(Clutter.KEY_Control_L, Clutter.KEY_v);
        await waitFor(() => service.input.length > 2000, 3000);
        await sleep(SETTLE_MS);
        let caret = caretInView(view);
        check('writing fixes: after pasting 40 lines, the caret is in view',
            service.input.split('\n').length === 40 && caret.ok &&
            view._inputScroll.vadjustment.value > 0, caret.detail);
        await typeText('!');
        caret = caretInView(view);
        check('writing fixes: typing on at the end, the caret stays in view',
            service.input.endsWith('scroll.!') && caret.ok, caret.detail);
        await screenshotTop(outDir, 'writing-long-paste', 560);

        // A result's selection survives typing in the box and a refresh.
        view._input.text = 'Make this shorter please, it is far too long.';
        await sleep(SETTLE_MS);
        await clickActor(view._actionButtons.get('shorten'));
        await waitFor(() => service.state === 'done');
        const resultText = view._result.clutter_text;
        let replaced = 0;
        const replacedId = resultText.connect('text-changed', () => replaced++);
        resultText.set_selection(0, 9);
        view._input.clutter_text.grab_key_focus();
        await typeText(' ok');
        service.emit('changed');
        await sleep(SETTLE_MS);
        const selected = resultText.get_selection();
        resultText.disconnect(replacedId);
        check('writing fixes: typing in the box keeps the result and its selection',
            view._result.text === 'Rewritten locally.' && selected === 'Rewritten' && replaced === 0,
            `selection=${JSON.stringify(selected)} replaced=${replaced}`);

        // The Clipboard tab's hidden password, pasted with Ctrl+V inside a
        // sentence (which on its own does not look like a password).
        s.set_boolean('clipboard-enabled', true);
        s.set_boolean('writing-claude-code-enabled', true);
        await waitFor(() => view._engineButtons.size === 2 && service.availabilityOf('claude-code').ready);
        await clickActor(view._engineButtons.get('claude-code'));
        await sleep(SETTLE_MS);
        stClipboard().set_text(CLIPBOARD, 'Kx9vR2mQpL4wTz8!');
        await waitFor(() => service._peekRecorder()?.password?.text === 'Kx9vR2mQpL4wTz8!', 3000);
        view._input.text = 'Here is the key ';
        view._input.clutter_text.grab_key_focus();
        view._input.clutter_text.set_cursor_position(-1);
        await pressKeys(Clutter.KEY_Control_L, Clutter.KEY_v);
        await typeText(' for you');
        removeWriting('run.argv');
        await clickActor(view._actionButtons.get('paraphrase'));
        await sleep(SETTLE_MS);
        check('writing fixes: the hidden password pasted into a sentence never reaches Claude Code',
            service.input === 'Here is the key Kx9vR2mQpL4wTz8! for you' &&
            service.error?.code === 'password' && readWriting('run.argv') === null &&
            view._error.text.startsWith('This text contains the password the Clipboard tab is hiding'),
            `${JSON.stringify(service.input)} ${JSON.stringify(service.error)}`);
        s.reset('clipboard-enabled');
        await sleep(SETTLE_MS);

        // While a request runs: no engine switch; its engine switched off stops it.
        GLib.file_set_contents(writingPath('hang'), '');
        removeWriting('run.pid');
        view._input.text = 'Their going to the libary tomorow.';
        await sleep(SETTLE_MS);
        const destination = view._destination.text;
        await clickActor(view._actionButtons.get('paraphrase'));
        await waitFor(() => readWriting('run.pid') !== null);
        const pid = readWriting('run.pid')?.trim();
        await clickActor(view._engineButtons.get('ollama'));
        check('writing fixes: while Claude Code runs, the other engine cannot be chosen',
            service.state === 'busy' && service.engine.id === 'claude-code' &&
            !view._engineButtons.get('ollama').reactive && view._destination.text === destination,
            `${service.engine.id} ${view._destination.text}`);
        s.set_boolean('writing-claude-code-enabled', false);
        check('writing fixes: switching its engine off in Settings stops the run',
            Boolean(pid) && await waitFor(() => !processAlive(pid), 2000) && service.state === 'idle' &&
            service.error?.code === 'cancelled', `pid=${pid} ${service.state}`);
        removeWriting('hang');
        await screenshotTop(outDir, 'writing-fixes', 560);

        await clickActor(tabButton('clock'));
        await sleep(animationWait());
        island().collapse();
        await sleep(animationWait());
        for (const key of s.settings_schema.list_keys().filter(k => k.startsWith('writing-')))
            s.reset(key);
        await sleep(SETTLE_MS);
        check('writing fixes: turning the tab off leaves no handlers on the network monitor',
            !island()._hub._entries.has('writing') && network.handlers.size === 0,
            `${network.handlers.size}`);
    } finally {
        for (const [name, value] of saved)
            GLib.setenv(name, value ?? '', true);
        GLib.unlink(fakeOllama);
        fake.server.disconnect();
        removeWriting('hang');
        s.reset('clipboard-enabled');
    }
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

// A stand-in for KillProcessService with made-up processes, for timing the
// view with many rows and driving it from the keyboard and the pointer. It
// never signals anything: kill() and forceQuit() only record the process
// id they were asked about (forceQuit's negated).
function fakeKillService(processes) {
    const handlers = new Map();
    let nextId = 1;
    return {
        processes,
        killed: [],
        sort: 'cpu',
        lastResult: null,
        connect(_signal, fn) {
            handlers.set(nextId, fn);
            return nextId++;
        },
        disconnect(id) {
            handlers.delete(id);
        },
        emit() {
            for (const fn of handlers.values())
                fn();
        },
        killState: () => null,
        setSort(sort) {
            this.sort = sort;
            this.emit();
        },
        kill(process) {
            this.killed.push(process.pid);
        },
        forceQuit(process) {
            this.killed.push(-process.pid);
        },
    };
}

// `count` made-up processes; `seed` changes their numbers (and so their order).
function syntheticProcesses(count, seed) {
    return Array.from({length: count}, (_, i) => {
        const pid = 100000 + i;
        const mix = (i * 7919 + seed * 104729) % 100003;
        return {
            key: `${pid}:1`, pid, start: 1,
            name: `synthetic-${i % 97}`,
            command: `/opt/synthetic/bin/worker-${i} --index ${i} --seed ${seed}`,
            cpu: (mix % 1000) / 10,
            memory: (mix % 5000) * 104858,
            threads: 1 + mix % 64,
            protected: null,
        };
    });
}

// Main-thread time of `change` itself, then of the frames that follow it
// (layout: before-update to prepare-frame; frame: before-update to
// after-update), in ms. The largest frame over 300 ms is kept.
async function refreshCost(change) {
    const stage = global.stage;
    const at = () => GLib.get_monotonic_time() / 1000;
    let start = 0;
    let layoutEnd = 0;
    let layout = 0;
    let frame = 0;
    const ids = [
        stage.connect('before-update', () => {
            start = at();
        }),
        stage.connect('prepare-frame', () => {
            layoutEnd = at();
        }),
        stage.connect('after-update', () => {
            if (start) {
                layout = Math.max(layout, layoutEnd - start);
                frame = Math.max(frame, at() - start);
            }
            start = 0;
        }),
    ];
    const t0 = at();
    change();
    const js = at() - t0;
    await sleep(300);
    ids.forEach(id => stage.disconnect(id));
    return {js, layout, frame};
}

const ms = cost => `${cost.js.toFixed(1)} ms JS, layout ${cost.layout.toFixed(1)} ms, ` +
    `frame ${cost.frame.toFixed(1)} ms`;

// Times the Kill Process view: refreshes with the real list, and with
// 1000 made-up processes in a second view in the same place. Returns
// notes for the report, and what the checks need.
async function measureKillProcess(view, service) {
    const notes = [];
    const header = boxOf(view._filter);
    await movePointerTo(header.x1 + 10, header.y1 + 5);
    view._filter.text = '';
    await sleep(SETTLE_MS);
    const real = service.processes;
    const idle = await refreshCost(() => {
        view._status.text = `${view._status.text} `;
    });
    notes.push(`idle frame (a status text change): ${ms(idle)}`);
    const realRows = [...view._rows];
    for (const seed of [1, 2, 3]) {
        // eslint-disable-next-line no-await-in-loop
        const cost = await refreshCost(() => {
            service.processes = real.map((p, i) => ({...p, cpu: ((i * 31 + seed * 17) % 100) / 10}));
            view._sync(true);
        });
        notes.push(`real list (${real.length}), new numbers and order #${seed}: ${ms(cost)}`);
    }
    const realReused = view._rows.length === realRows.length &&
        view._rows.every(row => realRows.includes(row));
    service.processes = real;
    view._sync(true);

    const fake = fakeKillService(syntheticProcesses(1000, 1));
    const parent = view.actor.get_parent();
    view.actor.hide();
    let fakeView = null;
    const build = await refreshCost(() => {
        fakeView = new view.constructor(fake);
        parent.add_child(fakeView.actor);
        fakeView.setActive(true);
    });
    notes.push(`1000 synthetic, first show: ${ms(build)}`);
    const rowsBefore = [...fakeView._rows];
    for (const factor of [0.9, 0.8, 0.7]) {
        // eslint-disable-next-line no-await-in-loop
        const cost = await refreshCost(() => {
            fake.processes = fake.processes.map(p => ({...p, cpu: p.cpu * factor}));
            fake.emit();
        });
        notes.push(`1000 synthetic, new numbers, same order: ${ms(cost)}`);
    }
    const reordered = [];
    for (const seed of [2, 3, 4]) {
        // eslint-disable-next-line no-await-in-loop
        const cost = await refreshCost(() => {
            fake.processes = syntheticProcesses(1000, seed);
            fake.emit();
        });
        reordered.push(cost.js);
        notes.push(`1000 synthetic, new numbers and order: ${ms(cost)}`);
    }
    const reused = fakeView._rows.length === rowsBefore.length &&
        fakeView._rows.every(row => rowsBefore.includes(row));
    const adjustment = fakeView._scroll.vadjustment;
    const jumped = await refreshCost(() => {
        adjustment.value = (adjustment.upper - adjustment.page_size) / 2;
        fakeView._renderWindow();
    });
    notes.push(`1000 synthetic, jump to the middle: ${ms(jumped)}`);
    const stepped = await refreshCost(() => {
        adjustment.value += fakeView._pitch;
        fakeView._renderWindow();
    });
    notes.push(`1000 synthetic, scroll by one row: ${ms(stepped)}`);
    const rows = fakeView._rows.length;
    notes.push(`row actors: ${rows} for 1000 processes (reused: ${reused}); ` +
        `${view._rows.length} for the real ${real.length} (reused: ${realReused})`);
    fakeView.destroy();
    view.actor.show();
    await sleep(SETTLE_MS);
    return {
        notes,
        rows,
        reused: reused && realReused,
        // The median, so that one garbage collection does not decide.
        refreshJs: reordered.sort((a, b) => a - b)[1],
    };
}

// Like boxOf, but from the last allocation even while a new layout is
// pending (boxOf would then give the preferred size).
function allocatedBox(actor) {
    const [x, y] = actor.get_transformed_position();
    const box = actor.get_allocation_box();
    return {x1: x, y1: y, x2: x + box.get_width(), y2: y + box.get_height()};
}

// The user's live processes, counted as the tab should: the /proc entries
// they own, without kernel threads and processes that have ended (a zombie
// main thread with no other thread left; with others, it still runs).
function ownProcessCount() {
    const uid = new Gio.Credentials().get_unix_user();
    const enumerator = Gio.File.new_for_path('/proc').enumerate_children(
        'standard::name,unix::uid', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
    let count = 0;
    for (let info = enumerator.next_file(null); info; info = enumerator.next_file(null)) {
        if (!/^\d+$/.test(info.get_name()) || info.get_attribute_uint32('unix::uid') !== uid)
            continue;
        try {
            const [, bytes] = GLib.file_get_contents(`/proc/${info.get_name()}/stat`);
            const text = new TextDecoder().decode(bytes);
            // From field 3 (state) on: flags is field 9, num_threads 20.
            const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
            const ended = 'ZXx'.includes(fields[0]) && Number(fields[17]) <= 1;
            if (!ended && !(Number(fields[6]) & 0x00200000))
                count++;
        } catch (e) {
            // Ended meanwhile.
        }
    }
    enumerator.close(null);
    return count;
}

const shownRows = view => view?._rows.filter(row => row.visible) ?? [];
const descending = values => values.every((value, i) => i === 0 || values[i - 1] >= value);

// A second view over a fake service (it signals nothing), in the tab's
// place, for the checks below. Returns it; `done()` puts the tab back.
async function fakeKillView(view, processes) {
    const fake = fakeKillService(processes);
    const parent = view.actor.get_parent();
    view.actor.hide();
    const fakeView = new view.constructor(fake);
    parent.add_child(fakeView.actor);
    fakeView.setActive(true);
    await sleep(SETTLE_MS);
    return {
        fake,
        fakeView,
        done: async () => {
            fakeView.destroy();
            view.actor.show();
            view._filter.clutter_text.grab_key_focus();
            await sleep(SETTLE_MS);
        },
    };
}

// Whether all of `actor` is inside the visible part of `scroll`, on screen.
function fullyInside(actor, scroll) {
    const box = allocatedBox(actor);
    const view = allocatedBox(scroll);
    return box.y1 >= view.y1 - 0.5 && box.y2 <= view.y2 + 0.5;
}

// The list from the keyboard and the pointer, over made-up processes (a
// fake service that only records what it is asked to kill): the keyboard
// never reaches a row out of sight, a click never leaves the list held,
// the keyboard's own focus does, and the count line is today's.
async function testKillProcessFocus(view) {
    const {fake, fakeView, done} = await fakeKillView(view, syntheticProcesses(300, 1));
    try {
        const adjustment = fakeView._scroll.vadjustment;
        const scrollBox = allocatedBox(fakeView._scroll);
        const filterBox = boxOf(fakeView._filter);
        const pointAtList = () => movePointerTo(scrollBox.x1 + 20, scrollBox.y1 + 40);
        const pointAtFilter = () => movePointerTo(filterBox.x1 + 10, filterBox.y1 + 5);

        // Scrolled to row 100 with the pointer resting on the list (as
        // after the wheel): the rows just above exist too, out of sight.
        await pointAtList();
        adjustment.value = 100 * fakeView._pitch;
        await sleep(SETTLE_MS);
        const scrolledTo = adjustment.value;
        fakeView._sortButtons.get('threads').grab_key_focus();
        await pressKeys(Clutter.KEY_Tab);
        const row = fakeView._focusedRow();
        const process = row?.process ?? null;
        check('kill process: Tab over a scrolled list, pointer on it, shows the row it reaches',
            row && fakeView._scroll.hover && adjustment.value < scrolledTo &&
            fullyInside(row, fakeView._scroll) && fakeView._held(),
            `row ${process && fakeView._shown.indexOf(process)}, value ${scrolledTo} -> ` +
            `${adjustment.value}, hover ${fakeView._scroll.hover}`);
        await pressKeys(Clutter.KEY_Return);
        const confirm = row?._part('confirm');
        const asked = fakeView._confirmKey === process?.key && confirm?.visible &&
            fullyInside(confirm, fakeView._scroll);
        await pressKeys(Clutter.KEY_Return);
        check('kill process: Enter, Enter there kills the process that is shown, nothing else',
            asked && fake.killed.length === 1 && fake.killed[0] === process.pid,
            `asked=${asked} killed=${fake.killed} (row's ${process?.pid})`);

        // A row out of sight refuses to act, whatever asks it (here no
        // event, as from an accessibility tool).
        adjustment.value = 100 * fakeView._pitch;
        await sleep(SETTLE_MS);
        const hidden = fakeView._rows.find(r => r.visible && r.process &&
            !fakeView._onScreen(r)) ?? null;
        const shown = fakeView._rows.find(r => r.visible && r.process &&
            fullyInside(r, fakeView._scroll)) ?? null;
        fake.killed.length = 0;
        if (hidden) {
            fakeView._ask(hidden);
            const askedHidden = fakeView._confirmKey;
            fakeView._confirmKey = hidden.process.key;
            fakeView._confirm(hidden);
            fakeView._force(hidden);
            fakeView._confirmKey = null;
            check('kill process: a row out of sight is never asked about nor killed',
                askedHidden === null && fake.killed.length === 0 &&
                !fullyInside(hidden, fakeView._scroll),
                `asked=${askedHidden} killed=${fake.killed}`);
        } else {
            check('kill process: a row out of sight is never asked about nor killed', false,
                'no row out of sight');
        }
        fakeView._ask(shown);
        check('kill process: a row on screen still is', shown &&
            fakeView._confirmKey === shown.process.key, `${fakeView._confirmKey}`);
        fakeView._cancel(shown);

        // A click on ⊘, then ✕, and the pointer leaves: nothing holds the
        // list any more, so a new process at the top shows.
        adjustment.value = 0;
        await pointAtFilter();
        fakeView._filter.clutter_text.grab_key_focus();
        await sleep(SETTLE_MS);
        const target = shownRows(fakeView)[3];
        const clickPart = async name => {
            const b = boxOf(target._part(name));
            await clickAt((b.x1 + b.x2) / 2, (b.y1 + b.y2) / 2);
        };
        await clickPart('kill');
        const clickedAsk = fakeView._confirmKey === target.process?.key;
        await clickPart('cancel');
        await pointAtFilter();
        await sleep(SETTLE_MS);
        // Above every made-up process (their CPU shares go up to 99.9%).
        const runaway = {...fake.processes[0], key: '999999:1', pid: 999999, name: 'runaway',
            command: '/opt/runaway', cpu: 100};
        fake.processes = [...fake.processes, runaway];
        fake.emit();
        check('kill process: ⊘ then ✕ by pointer leaves no hold: once it leaves, the list re-sorts',
            clickedAsk && fakeView._confirmKey === null && fakeView._focusedRow() === null &&
            !fakeView._held() && fakeView._shown[0]?.pid === runaway.pid &&
            fakeView._status.text === `Your ${fake.processes.length} processes` &&
            fake.killed.length === 0,
            `asked=${clickedAsk} focus=${global.stage.get_key_focus()} held=${fakeView._held()} ` +
            `first=${fakeView._shown[0]?.pid} "${fakeView._status.text}"`);

        // Held by the pointer, the rows stay; the count is today's.
        fakeView._filter.text = 'worker-29';
        await sleep(SETTLE_MS);
        const before = fakeView._shown.length;
        await pointAtList();
        await sleep(SETTLE_MS);
        const late = {...runaway, key: '999998:1', pid: 999998, command: '/opt/worker-29-late',
            cpu: 0};
        fake.processes = [...fake.processes, late];
        fake.emit();
        const heldCount = fakeView._shown.length;
        const heldText = fakeView._status.text;
        await pointAtFilter();
        await sleep(SETTLE_MS);
        check('kill process: while rows are held, the count line counts today\'s processes',
            heldCount === before && heldText ===
                `${before + 1} of your ${fake.processes.length} processes match` &&
            fakeView._shown.length === before + 1,
            `held ${heldCount} rows, "${heldText}", then ${fakeView._shown.length}`);
        fakeView._filter.text = '';
        await sleep(SETTLE_MS);

        // The keyboard's own focus on a row holds the list (pointer away);
        // focus back in the filter, it re-sorts.
        fakeView._sortButtons.get('threads').grab_key_focus();
        await pressKeys(Clutter.KEY_Tab);
        const keyed = fakeView._focusedRow();
        // As busy as the runaway, with more memory: first.
        const top = {...runaway, key: '999997:1', pid: 999997, memory: runaway.memory + 1};
        fake.processes = [...fake.processes, top];
        fake.emit();
        const keptOrder = keyed !== null && fakeView._held() && fakeView._shown[0]?.pid !== top.pid;
        fakeView._filter.clutter_text.grab_key_focus();
        fake.emit();
        check('kill process: a row the keyboard focused holds the list until the focus leaves',
            keptOrder && fakeView._shown[0]?.pid === top.pid && fake.killed.length === 0,
            `kept=${keptOrder} first=${fakeView._shown[0]?.pid}`);
    } finally {
        await done();
    }
}

// A whole refresh, as the tab makes it every few seconds: the real
// service reads /proc (real Gio reads, BATCH at a time), then the real
// view sorts and fills its rows. Each of the user's processes is served
// `copies` times under made-up ids beyond PID_MAX (so every row is
// protected, and verify() refuses them); run() records and signals
// nothing, and no kill command is found. A heartbeat at Clutter's redraw
// priority finds the longest time the main loop was held (no frame could
// be drawn then); the main thread's CPU time is its schedstat's.
async function measureWholeRefresh(view, service, copies) {
    const {BATCH} = await import(`file://${extension().path}/features/killprocess/sampler.js`);
    const SHIFT = 4194304;
    const real = service._io;
    const runs = [];
    let pauses = 0;
    const io = {
        ...real,
        run: async argv => {
            runs.push(argv);
            return null;
        },
        executable: async () => false,
        pause: cancellable => {
            pauses++;
            return real.pause(cancellable);
        },
        async owners(path, cancellable) {
            const entries = await real.owners(path, cancellable);
            const out = [];
            for (let k = 1; k <= copies; k++) {
                for (const entry of entries) {
                    if (/^\d+$/.test(entry.name))
                        out.push({...entry, name: String(Number(entry.name) + k * SHIFT)});
                }
            }
            return out;
        },
        async read(path, cancellable) {
            const match = /^\/proc\/(\d+)\/(.+)$/.exec(path);
            if (!match)
                return real.read(path, cancellable);
            const text = await real.read(`/proc/${Number(match[1]) % SHIFT}/${match[2]}`,
                cancellable);
            return match[2] === 'stat' && text ? text.replace(/^\d+/, match[1]) : text;
        },
    };
    const decoder = new TextDecoder();
    const cpu = () => Number(decoder.decode(
        GLib.file_get_contents('/proc/thread-self/schedstat')[1]).split(' ')[0]) / 1e6;
    const at = () => GLib.get_monotonic_time() / 1000;

    const measured = new service.constructor(settings(), {io});
    measured.start();
    const parent = view.actor.get_parent();
    view.actor.hide();
    const measuredView = new view.constructor(measured);
    parent.add_child(measuredView.actor);
    measuredView.setActive(true);
    let syncMs = 0;
    const sync = measuredView._sync.bind(measuredView);
    measuredView._sync = (...args) => {
        const t0 = at();
        sync(...args);
        syncMs = at() - t0;
    };

    let last = at();
    let longest = 0;
    const beat = GLib.timeout_add(Clutter.PRIORITY_REDRAW, 1, () => {
        const t = at();
        longest = Math.max(longest, t - last);
        last = t;
        return GLib.SOURCE_CONTINUE;
    });
    let begun = null;
    const sample = measured._sampler.sample.bind(measured._sampler);
    measured._sampler.sample = (...args) => {
        begun = {at: at(), cpu: cpu(), pauses};
        last = at();
        longest = 0;
        return sample(...args);
    };
    const refreshes = [];
    measured.connect('changed', () => {
        if (!begun)
            return;
        longest = Math.max(longest, at() - last);
        refreshes.push({
            n: measured.processes.length,
            wall: at() - begun.at,
            cpu: cpu() - begun.cpu,
            longest,
            pauses: pauses - begun.pauses,
            sync: syncMs,
        });
        begun = null;
    });
    try {
        measured.setActive(true);
        for (let i = 0; i < 40 && refreshes.length < 6; i++) {
            // eslint-disable-next-line no-await-in-loop
            await sleep(250);
            if (refreshes.length >= 2)
                measured._tick();
        }
    } finally {
        GLib.source_remove(beat);
        measured.setActive(false);
        measured.stop();
        measuredView.destroy();
        view.actor.show();
        await sleep(SETTLE_MS);
    }
    const later = refreshes.slice(1);
    const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
    const fmt = r => `${r.n} processes: ${r.wall.toFixed(0)} ms wall, ${r.cpu.toFixed(0)} ms ` +
        `main-thread CPU, held at most ${r.longest.toFixed(1)} ms (_sync ${r.sync.toFixed(1)} ms), ` +
        `${r.pauses} pauses`;
    return {
        notes: [`x${copies}, first reading (command lines too): ${refreshes[0] ? fmt(refreshes[0]) : '-'}`,
            ...later.map(r => `x${copies}, reading: ${fmt(r)}`)],
        runs: runs.length,
        // Every batch but the first comes after a pause, and the view's
        // refresh after one more.
        batched: refreshes.length >= 4 && refreshes.every(r => r.pauses >= Math.ceil(r.n / BATCH)),
        // The longest hold against the reading's own length: the whole
        // reading in one block would be about 1.
        heldShare: later.length ? median(later.map(r => r.longest / r.wall)) : 1,
        count: later.length ? median(later.map(r => r.n)) : 0,
    };
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
        // Four threads that sleep, and the main one: five in all. Never
        // signalled by the tab; ended with the other children at the end.
        const python = '/usr/bin/python3';
        const threaded = GLib.file_test(python, GLib.FileTest.IS_EXECUTABLE)
            ? spawnChild([python, '-c', 'import threading, time\n' +
                '[threading.Thread(target=time.sleep, args=(600,), daemon=True).start() ' +
                'for _ in range(4)]\ntime.sleep(600)'])
            : null;
        if (threaded)
            children.push(threaded);
        // Its main thread exits (pthread_exit) while another one sleeps:
        // the kernel then shows the main thread as a zombie, but the
        // process runs on. Never signalled by the tab either.
        const leaderless = threaded
            ? spawnChild([python, '-c', 'import ctypes, threading, time\n' +
                'threading.Thread(target=time.sleep, args=(600,)).start()\n' +
                'ctypes.CDLL(None).pthread_exit(None)'])
            : null;
        if (leaderless)
            children.push(leaderless);
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
            w === 520 * scale() && h === 440 * scale(),
            `${w}x${h} polling=${service?.polling}`);
        await waitFor(() => service?.processes?.some(p => p.pid === sleeper.pid));
        const listed = pid => service?.processes?.find(p => p.pid === pid) ?? null;
        check('kill process: only the user\'s processes are listed, the spawned ones included',
            listed(sleeper.pid)?.name === 'sleep' && listed(1) === null &&
            service.processes.every(p => p.pid > 1),
            `${service?.processes?.length} processes; sleep=${JSON.stringify(listed(sleeper.pid))}`);
        await screenshotTop(outDir, 'killprocess', 520);

        // Every process, not the busiest few: as many as /proc has, read
        // right after a fresh sample.
        const header = boxOf(view._filter);
        await movePointerTo(header.x1 + 10, header.y1 + 5);
        const previous = service.processes;
        await waitFor(() => service.processes !== previous, 8000);
        const counted = ownProcessCount();
        const total = service.processes.length;
        check('kill process: all of the user\'s processes are listed, as many as /proc has',
            total > 30 && Math.abs(total - counted) <= 5 && view._shown.length === total &&
            view._status.text === `Your ${total} processes`,
            `listed ${total}, /proc ${counted}, shown ${view._shown.length}, "${view._status.text}"`);

        const visibleRows = shownRows(view);
        const heights = new Set(visibleRows.map(row => row.height));
        check('kill process: only the rows on screen exist, all as tall as each other',
            view._rows.length < total && view._rows.length <= 40 && heights.size === 1 &&
            Math.abs(view._pitch - (visibleRows[0]?.height ?? 0) - 1 * scale()) < 0.5,
            `${view._rows.length} row actors for ${total}; heights ${[...heights]}, ` +
            `pitch ${view._pitch}`);

        // The pointer on the list holds its order, so a sample in between
        // cannot re-sort it under the check.
        const adjustment = view._scroll.vadjustment;
        const scrollBox = allocatedBox(view._scroll);
        await movePointerTo(scrollBox.x1 + 20, scrollBox.y1 + 40);
        await sleep(SETTLE_MS);
        const rowAt = y => shownRows(view).find(row => {
            const b = allocatedBox(row);
            return b.y1 <= y && y < b.y2;
        }) ?? null;
        const index = Math.min(100, total - 20);
        adjustment.value = index * view._pitch;
        await sleep(SETTLE_MS);
        const middle = rowAt(scrollBox.y1 + view._pitch / 2)?.process ?? null;
        adjustment.value = adjustment.upper - adjustment.page_size;
        await sleep(SETTLE_MS);
        const lastRow = shownRows(view).at(-1);
        const lastBox = lastRow ? allocatedBox(lastRow) : null;
        const last = lastRow?.process ?? null;
        check('kill process: scrolled, each process is in its place, the last one at the bottom',
            middle?.key === view._shown[index].key && last?.key === view._shown.at(-1).key &&
            lastBox.y2 <= scrollBox.y2 + 1 && lastBox.y2 > scrollBox.y2 - 2 * view._pitch,
            `row ${index}: ${middle?.pid} vs ${view._shown[index].pid}; last ${last?.pid} vs ` +
            `${view._shown.at(-1).pid}, bottom ${lastBox?.y2} in ${scrollBox.y2}`);
        await screenshotTop(outDir, 'killprocess-end', 520);
        adjustment.value = 0;
        await movePointerTo(header.x1 + 10, header.y1 + 5);
        await sleep(SETTLE_MS);

        const firstRow = shownRows(view)[0];
        const bar = view._scroll.get_children().find(child => child instanceof St.ScrollBar &&
            child.orientation === Clutter.Orientation.VERTICAL) ?? null;
        const barLeft = bar ? allocatedBox(bar).x1 : -1;
        const nameWidth = firstRow?._part('name').width ?? 0;
        check('kill process: the scroll bar covers no number or button; the name keeps room',
            view._scroll.vscrollbar_visible && bar?.visible && firstRow &&
            boxOf(firstRow._part('threads')).x2 <= barLeft &&
            boxOf(firstRow._part('kill')).x2 <= barLeft && nameWidth >= 120 * scale(),
            `note: threads ends at ${firstRow && boxOf(firstRow._part('threads')).x2}, ⊘ at ` +
            `${firstRow && boxOf(firstRow._part('kill')).x2}, scroll bar from ${barLeft}; ` +
            `name ${nameWidth} px at scale ${scale()}`);

        await clickActor(view._sortButtons.get('threads'));
        await sleep(SETTLE_MS);
        const ranked = view._shown.map(p => p.threads);
        const rendered = shownRows(view).map(row => Number(row._part('threads').text));
        check('kill process: the Threads toggle sorts by thread count, most first',
            service.sort === 'threads' && settings().get_string('killprocess-sort') === 'threads' &&
            view._sortButtons.get('threads').checked && !view._sortButtons.get('cpu').checked &&
            descending(ranked) && rendered.length > 5 && descending(rendered) &&
            rendered[0] === ranked[0] &&
            firstRow._part('threads').has_style_class_name('froonty-killprocess-sorted') &&
            !firstRow._part('cpu').has_style_class_name('froonty-killprocess-sorted'),
            `first rows: ${rendered.slice(0, 8)}`);
        await screenshotTop(outDir, 'killprocess-threads', 520);
        await clickActor(view._sortButtons.get('memory'));
        await sleep(SETTLE_MS);
        const memory = view._shown.map(p => p.memory);
        check('kill process: the Memory toggle sorts by memory, most first',
            service.sort === 'memory' && descending(memory), `${memory.slice(0, 5)}`);
        await clickActor(view._sortButtons.get('cpu'));
        await sleep(SETTLE_MS);

        check('kill process: a single-threaded process counts 1 thread, a threaded one its own',
            listed(sleeper.pid)?.threads === 1 &&
            (threaded === null || listed(threaded.pid)?.threads === 5),
            threaded === null ? 'note: no /usr/bin/python3, threaded process not checked'
                : `sleep ${listed(sleeper.pid)?.threads}, python ${listed(threaded.pid)?.threads}`);
        if (threaded) {
            view._filter.text = String(threaded.pid);
            await waitFor(() => killRow(view, threaded.pid) !== null);
            // The process id may also be part of other processes' ids or
            // command lines: whatever matches is counted.
            const matching = view._shown.length;
            check('kill process: its row shows the thread count; the count line, the matches',
                killRow(view, threaded.pid)?._part('threads').text === '5' &&
                view._status.text === `${matching} of your ${service.processes.length} ` +
                    `processes ${matching === 1 ? 'matches' : 'match'}`,
                `${killRow(view, threaded.pid)?._part('threads').text} / ${view._status.text}`);
            view._filter.text = '';
        }

        if (leaderless) {
            const leader = listed(leaderless.pid);
            // verify() only reads /proc: it is what kill() asks first.
            check('kill process: a process whose main thread has exited, others running, is ' +
                'listed and may be killed',
                leader?.threads === 2 && leader.memory === null && leader.protected === null &&
                await service._sampler.verify(leader) === 'ok' && !leaderless.exited,
                JSON.stringify(leader));
        }

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

        const cost = await measureKillProcess(view, service);
        // The bound only catches one row per process again (497-703 ms on
        // the development machine): the figures vary with the machine's
        // load (up to 24 ms with a parallel build running), so they are
        // notes, not a limit.
        check('kill process: a refresh of 1000 processes reuses a few dozen rows',
            cost.rows <= 40 && cost.reused && cost.refreshJs < 100,
            `note: ${cost.notes.join('\n     ')}`);

        const wholes = [];
        for (const copies of [1, 4]) {
            // eslint-disable-next-line no-await-in-loop
            wholes.push(await measureWholeRefresh(view, service, copies));
        }
        check('kill process: a whole refresh reads in batches and leaves room for frames',
            wholes.every(w => w.batched && w.heldShare < 0.5 && w.runs === 0) &&
            wholes[1].count > 3 * wholes[0].count,
            `note: ${wholes.flatMap(w => w.notes).join('\n     ')}\n     ` +
            `longest hold / reading: ${wholes.map(w => w.heldShare.toFixed(2)).join(', ')}`);

        await testKillProcessFocus(view);

        // Rows filled after the tab was hidden (a collapsing island still
        // lays out the list), counted from the moment it was hidden.
        let renders = 0;
        let hiddenAt = Infinity;
        const renderWindow = view._renderWindow;
        const setActive = view.setActive;
        view._renderWindow = function (...args) {
            if (!this._active)
                renders++;
            return renderWindow.apply(this, args);
        };
        view.setActive = function (active) {
            if (!active)
                hiddenAt = Math.min(hiddenAt, GLib.get_monotonic_time());
            return setActive.call(this, active);
        };

        await clickActor(tabButton('clock'));
        await sleep(animationWait());
        check('kill process: another tab stops the reading, and clears the filter',
            service.polling === false && view._filter.text === '');
        await clickActor(tabButton('killprocess'));
        await sleep(animationWait());
        check('kill process: back on screen, it reads again', service.polling === true);
        island().collapse();
        await sleep(animationWait());
        check('kill process: collapsing the island stops the reading, and fills no row after',
            service.polling === false && hiddenAt < Infinity && renders === 0 &&
            view._renderLater === 0,
            `${renders} fills after hiding, later ${view._renderLater}`);
        delete view._renderWindow;
        delete view.setActive;
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
        settings().reset('killprocess-sort');
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

    // Keyboard: Tab from the focused pill reaches ⚙️ (after the tabs and
    // 📅), Enter activates it.
    island().expand();
    await sleep(animationWait());
    for (let i = 0; i < 12 && global.stage.key_focus !== gear; i++)
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

async function testLifecycle(outDir) {
    // The expanded cycles below run with the Notifications tab on screen.
    settings().set_string('hub-last-tab', 'notifications');
    mediaWork = outDir;
    // Music on the pill (cover, bars) through every cycle.
    const player = await spawnFake('froontycycle', {args: MUSIC, state: {
        ...playing('Cycle Song', {'mpris:artUrl': coverUrl('froontycycle')}), Position: 5e6,
    }});
    await waitFor(() => island()?._accessory?.showing, 3000);
    check('media: music shows on the pill before the cycles', island()?._accessory?.showing === true);
    // The Break tab on, with GNOME's eye breaks on (in the private keyfile
    // only): its engine signals, idle watch and takeover are cycled too.
    const breaks = privacyIsIsolated(outDir)[0]
        ? new Gio.Settings({schema_id: 'org.gnome.desktop.break-reminders'}) : null;
    const eyes = breaks ? new Gio.Settings({schema_id: 'org.gnome.desktop.break-reminders.eyesight'}) : null;
    if (breaks) {
        eyes.set_uint('interval-seconds', 3600);
        breaks.set_strv('selected-breaks', ['eyesight']);
        settings().set_boolean('break-enabled', true);
        settings().set_boolean('posture-enabled', true);
        await sleep(SETTLE_MS);
    }
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
    if (breaks) {
        breaks.set_strv('selected-breaks', []);
        Main.breakManager.notify('state');
        for (const signal of ['break-due', 'break-finished', 'take-break'])
            Main.breakManager.emit(signal);
    }
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
    // The player changes now: nothing of Froonty's listens any more.
    await fakeSet(player, {Metadata: song('After Disable')});
    await fakeSeeked(player, 9e6);
    await sleep(SETTLE_MS);
    check('media: disabled, no Media service and no holder (the bus subscription went with it)',
        mediaSharedModule.sharedMedia() === null && mediaSharedModule.mediaUsers() === 0);
    await quitFake(player);

    check('re-enable succeeds', await setExtensionEnabled(true), stateName());
    await sleep(SETTLE_MS);
    island()._hub.select('clock');
    settings().reset('hub-last-tab');
    if (breaks) {
        settings().reset('break-enabled');
        settings().reset('posture-enabled');
        breaks.reset('selected-breaks');
        eyes.reset('interval-seconds');
        await sleep(SETTLE_MS);
    }
}

// ---------------------------------------------------------------- hub layout

// Without panic buttons the hub needs no room for them: an expand reports
// its size once and reaches its width within the animation. (A stale
// minimum width once restarted the resize on every frame: about 60 reports
// and 1.5 s per expand.)
async function testHubWithoutPanicButtons() {
    const s = settings();
    island().expand();
    await sleep(animationWait());
    s.set_strv('panic-buttons', []);
    await sleep(animationWait());
    island().collapse();
    await sleep(animationWait());
    const hub = island()._hub;
    let reports = 0;
    const id = hub.connect('size-changed', () => reports++);
    const start = now();
    const widths = [];
    island().expand();
    for (let t = 0; t < 1500; t += 25) {
        widths.push([(now() - start) / 1000, pill().get_transformed_size()[0]]);
        await sleep(25);
    }
    hub.disconnect(id);
    const final = widths.at(-1)[1];
    const last = widths.findLastIndex(([, w]) => w !== final);
    const settledMs = last < 0 ? 0 : widths[Math.min(last + 1, widths.length - 1)][0];
    const duration = s.get_int('animation-duration');
    check('layout: without panic buttons an expand reports its size at most once, settling in time',
        reports <= 1 && settledMs <= duration + 150,
        `reports=${reports} settled after ${Math.round(settledMs)} ms (animation ${duration} ms) ` +
        `minWidth=${hub.minWidth} reported=${hub._reportedMinWidth}`);
    island().collapse();
    await sleep(animationWait());
    s.reset('panic-buttons');
    await sleep(SETTLE_MS);
}

async function testHubLayout(outDir) {
    island().expand();
    await sleep(animationWait());
    const hub = island()._hub;
    const tabs = hub._tabColumn.get_children();
    const boxes = tabs.map(boxOf);
    const expectedCount = (await expectedTabs()).length;
    // One column; the island grows past expanded-height to show every tab.
    check('layout: feature tabs are stacked vertically on the left, all inside the island',
        tabs.length === expectedCount && boxes.every(b => Math.abs(b.x1 - boxes[0].x1) < 1) &&
        boxes.every((b, i) => i === 0 || b.y1 > boxes[i - 1].y1) &&
        boxes[0].x2 <= boxOf(hub._content).x1 && boxes.at(-1).y2 <= boxOf(pill()).y2,
        `${boxes.map(b => `[${b.x1},${b.y1}]`).join(' ')} island bottom=${boxOf(pill()).y2}`);
    const bar = boxOf(hub._panicBar.actor);
    const isle = boxOf(pill());
    const leftmost = Math.min(...hub._header.end.get_children()
        .filter(b => b.visible).map(b => boxOf(b).x1));
    check('layout: the panic bar is centered on the island, clear of tabs and the header buttons',
        Math.abs((bar.x1 + bar.x2) / 2 - (isle.x1 + isle.x2) / 2) <= 1 &&
        bar.x2 <= leftmost && bar.x1 > Math.max(...boxes.map(b => b.x2)),
        `bar=[${bar.x1},${bar.x2}] island=[${isle.x1},${isle.x2}] header from ${leftmost}`);

    const notesBox = boxOf(tabButton('notes'));
    await movePointerTo((notesBox.x1 + notesBox.x2) / 2, (notesBox.y1 + notesBox.y2) / 2);
    await sleep(SETTLE_MS);
    const tip = hub._tooltip.actor;
    check('layout: hovering a tab shows its feature name to the right',
        tip.visible && tip.text === 'Notes' && boxOf(tip).x1 >= notesBox.x2 - 1,
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

// ---------------------------------------------------------------- panic: block camera
// GNOME's Camera Access switch (org.gnome.desktop.privacy disable-camera).
// Needs no sound server. Writes GNOME's privacy settings, so it runs only
// against run.sh's private keyfile backend.

const CAMERA_TITLE = 'Block camera for apps that ask GNOME';

// run.sh's keyfile lives in the work dir: $WORK/config/glib-2.0/settings.
function privacyIsIsolated(workDir) {
    const backend = GObject.type_name(Gio.SettingsBackend.get_default().constructor.$gtype);
    const config = GLib.get_user_config_dir();
    const keyfile = GLib.build_filenamev([config, 'glib-2.0', 'settings', 'keyfile']);
    const isolated = backend === 'GKeyfileSettingsBackend' &&
        GLib.getenv('GSETTINGS_BACKEND') === 'keyfile' &&
        config === GLib.build_filenamev([workDir, 'config']) &&
        GLib.file_test(keyfile, GLib.FileTest.EXISTS);
    return [isolated, `backend=${backend} config=${config}`];
}

async function testPanicCamera(outDir) {
    const [isolated, where] = privacyIsIsolated(outDir);
    check('panic camera: GNOME\'s privacy settings are the private test copy', isolated, where);
    if (!isolated)
        return;

    const s = settings();
    const privacy = new Gio.Settings({schema_id: 'org.gnome.desktop.privacy'});
    privacy.reset('disable-camera');
    s.set_strv('panic-buttons', ['block-camera']);
    island().expand();
    await sleep(animationWait());
    const bar = () => island()._hub._panicBar;
    const [camera] = bar()._buttons;
    const icon = () => camera?.actor.child.icon_name;
    check('panic camera: the bar shows "Block camera for apps that ask GNOME"',
        bar()._buttons.length === 1 && camera.actor.accessible_name === CAMERA_TITLE,
        bar()._buttons.map(b => b.actor.accessible_name).join(','));
    check('panic camera: camera allowed: not checked, usable, webcam icon',
        !camera.actor.checked && camera.actor.reactive && icon() === 'camera-web-symbolic',
        `checked=${camera.actor.checked} reactive=${camera.actor.reactive} icon=${icon()}`);

    const b = boxOf(camera.actor);
    await movePointerTo((b.x1 + b.x2) / 2, (b.y1 + b.y2) / 2);
    await sleep(SETTLE_MS);
    const tip = island()._hub._tooltip.actor;
    check('panic camera: hovering shows its name below it',
        tip.visible && tip.text === CAMERA_TITLE && boxOf(tip).y1 >= b.y2 - 1,
        `visible=${tip.visible} text=${tip.text}`);
    await screenshotTop(outDir, 'panic-camera-tooltip');

    await clickActor(camera.actor);
    check('panic camera: a click turns GNOME\'s Camera Access off',
        await waitFor(() => privacy.get_boolean('disable-camera')) && camera.actor.checked &&
        icon() === 'camera-disabled-symbolic',
        `disable-camera=${privacy.get_boolean('disable-camera')} checked=${camera.actor.checked} icon=${icon()}`);
    await movePointerTo(...pillCenter());
    await screenshotTop(outDir, 'panic-camera-blocked', 120);

    // Keyboard: Tab to the button, Space turns camera access back on.
    for (let i = 0; i < 10 && global.stage.key_focus !== camera.actor; i++)
        await pressKeys(Clutter.KEY_Tab);
    check('panic camera: Tab reaches the button', global.stage.key_focus === camera.actor,
        `focus=${global.stage.key_focus}`);
    await pressKeys(Clutter.KEY_space);
    check('panic camera: Space turns Camera Access back on',
        await waitFor(() => !privacy.get_boolean('disable-camera')) && !camera.actor.checked);

    // As GNOME Settings → Privacy & Security → Cameras would.
    privacy.set_boolean('disable-camera', true);
    check('panic camera: a change made elsewhere checks the button',
        await waitFor(() => camera.actor.checked && icon() === 'camera-disabled-symbolic'));
    privacy.set_boolean('disable-camera', false);
    check('panic camera: and unchecks it', await waitFor(() => !camera.actor.checked));

    // Removing the button lets go of GNOME's privacy settings. The counts
    // before prove the probe sees the button's own handlers.
    const own = camera._access._settings;
    const counts = () => [countHandlers(own, 'changed'), countHandlers(own, 'writable-changed')];
    const before = counts();
    s.set_strv('panic-buttons', ['mute-sound']);
    await sleep(SETTLE_MS);
    const after = counts();
    check('panic camera: removed from the bar, it leaves no handler behind',
        bar()._buttons.length === 1 && before.every(n => n > 0) && after.every(n => n === 0),
        `before=${before} after=${after}`);
    privacy.set_boolean('disable-camera', true); // a leaked handler would log errors
    await sleep(SETTLE_MS);

    privacy.reset('disable-camera');
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

// ---------------------------------------------------------------- calendar menu
//
// GNOME's own calendar and notification menu, which the island covers
// (docs/features/calendar.md): 📅 in the hub, Super+V, one modal grab at a
// time, the unread dot, banners held while expanded, and the handlers on
// GNOME's date menu across disable/enable. A self-contained block.

const dateMenuButton = () => Main.panel.statusArea.dateMenu;
const calendarMenuOpen = () => dateMenuButton().menu.isOpen;
// GNOME's own unread-notifications dot, next to the transparent clock.
const gnomeUnreadDot = () => dateMenuButton()._indicator.visible;
const pillUnreadDot = () => island()._collapsedView._unreadDot.visible;
const focusInCalendarMenu = () =>
    dateMenuButton().menu.actor.contains(global.stage.key_focus);
// Handlers on a GJS (non-GObject) signal emitter, such as a PopupMenu.
const jsHandlerCount = (emitter, signal) =>
    emitter._signalConnectionsByName?.[signal]?.length ?? 0;
// GNOME Shell's app grid connects one overview 'hidden' handler of its own
// (`() => this.goToPage(0)`, ui/appDisplay.js) once, from deferred work
// that may run in the middle of a footprint comparison: not Froonty's.
const appGridHidden = () => Object.values(Main.overview._signalConnections ?? {})
    .filter(c => c.name === 'hidden' && /\bthis\.goToPage\(0\)/.test(String(c.callback))).length;
const isEllipsized = label => label.clutter_text.get_layout().is_ellipsized();

async function closeCalendarMenu() {
    if (calendarMenuOpen())
        Main.panel.closeCalendar();
    await sleep(animationWait());
}

async function testCalendarMenu(outDir) {
    const MessageTray = await import('resource:///org/gnome/shell/ui/messageTray.js');
    const tray = Main.messageTray;
    const menu = dateMenuButton().menu;
    const monitor = Main.layoutManager.primaryMonitor;
    const away = [monitor.x + 60, monitor.y + monitor.height / 2];
    const modalBefore = Main.modalCount;
    const state = () => `menu=${calendarMenuOpen()} expanded=${island()?.expanded} ` +
        `modal=${Main.modalCount} (before ${modalBefore}) focus=${global.stage.key_focus} ` +
        `bannersHeld=${tray._bannerBlocked}`;

    // 📅 in the hub header.
    island().expand();
    await sleep(animationWait());
    let hub = island()._hub;
    const button = hub.calendarButton;
    const [b, g, bar] = [button, hub.settingsButton, hub._panicBar.actor].map(boxOf);
    check('calendar: 📅 sits left of ⚙️ in the hub header, clear of the panic bar',
        button?.mapped && b.x2 <= g.x1 && Math.abs(b.y1 + b.y2 - g.y1 - g.y2) <= 2 && bar.x2 <= b.x1,
        `📅=[${b.x1},${b.y1} - ${b.x2},${b.y2}] ⚙️=[${g.x1},${g.y1}] panic bar ends at ${bar.x2}`);
    check('calendar: GNOME\'s banners are held while the island is expanded',
        tray._bannerBlocked === true, state());
    await movePointerTo((b.x1 + b.x2) / 2, (b.y1 + b.y2) / 2);
    await sleep(SETTLE_MS);
    const tip = hub._tooltip.actor;
    check('calendar: hovering 📅 names it',
        tip.visible && tip.text === 'Calendar and notifications', `visible=${tip.visible} text=${tip.text}`);

    // A click: GNOME's menu opens above the island, which collapses.
    await clickActor(button);
    const uiChildren = Main.layoutManager.uiGroup.get_children();
    check('calendar: GNOME\'s menu is raised above the island as it opens',
        uiChildren.indexOf(menu.actor) > uiChildren.indexOf(strip()),
        `menu ${uiChildren.indexOf(menu.actor)}, island ${uiChildren.indexOf(strip())}`);
    await sleep(animationWait());
    check('calendar: clicking 📅 opens GNOME\'s calendar and notification menu',
        calendarMenuOpen() && menu.actor.visible, state());
    check('calendar: the island collapses and releases its grab; only the menu holds one',
        !island().expanded && !island()._grabHelper.grabbed && !strip().reactive &&
        Main.modalCount === modalBefore + 1, state());
    check('calendar: the keyboard focus moves into the menu', focusInCalendarMenu(), state());
    const m = boxOf(menu.actor);
    const [pcx] = pillCenter();
    const clock = boxOf(dateMenuButton().container);
    check('calendar: the menu hangs below the clock under the pill',
        m.x1 < pcx && pcx < m.x2 && m.y1 >= clock.y2 - 1,
        `menu=[${m.x1},${m.y1} - ${m.x2},${m.y2}] clock bottom=${clock.y2} pill center x=${pcx}`);
    const hit = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, pcx, m.y1 + 40);
    check('calendar: the menu is on top where it meets the island (picking finds the menu)',
        menu.actor.contains(hit), `${hit}`);
    await screenshotTop(outDir, 'calendar-menu', 640);

    // Usable: GNOME's own calendar takes clicks.
    const calendar = dateMenuButton()._calendar;
    const month = calendar._selectedDate.getMonth();
    await clickActor(calendar._forwardButton);
    check('calendar: the menu takes clicks (GNOME\'s calendar shows the next month)',
        calendar._selectedDate.getMonth() === (month + 1) % 12 && calendarMenuOpen(),
        `month ${month} -> ${calendar._selectedDate.getMonth()}`);

    await pressKeys(Clutter.KEY_Escape);
    await sleep(animationWait());
    check('calendar: Escape closes it and releases its grab',
        !calendarMenuOpen() && !island().expanded && Main.modalCount === modalBefore &&
        !tray._bannerBlocked, state());

    // Keyboard only: Tab to 📅, Enter.
    island().expand();
    await sleep(animationWait());
    for (let i = 0; i < 12 && global.stage.key_focus !== button; i++)
        await pressKeys(Clutter.KEY_Tab);
    check('calendar: Tab reaches 📅', global.stage.key_focus === button, state());
    await pressKeys(Clutter.KEY_Return);
    await sleep(animationWait());
    check('calendar: Enter on 📅 opens the menu, focus inside, island collapsed',
        calendarMenuOpen() && focusInCalendarMenu() && !island().expanded &&
        Main.modalCount === modalBefore + 1, state());
    await pressKeys(Clutter.KEY_Escape);
    await sleep(animationWait());

    // GNOME's own shortcut over the expanded island, and back.
    island().expand();
    await sleep(animationWait());
    await pressKeys(Clutter.KEY_Super_L, Clutter.KEY_v);
    await sleep(animationWait());
    check('calendar: Super+V over the expanded island opens the menu and collapses the island',
        calendarMenuOpen() && focusInCalendarMenu() && !island().expanded &&
        Main.modalCount === modalBefore + 1, state());
    check('calendar: banners stay held while GNOME\'s menu is open', tray._bannerBlocked === true, state());
    await pressKeys(Clutter.KEY_Super_L, Clutter.KEY_Alt_L, Clutter.KEY_i);
    await sleep(animationWait());
    check('calendar: the island\'s shortcut over the open menu closes it and expands the island',
        !calendarMenuOpen() && island().expanded && Main.modalCount === modalBefore + 1, state());
    await pressKeys(Clutter.KEY_Escape);
    await sleep(animationWait());
    check('calendar: then no grab is left and banners are free',
        !island().expanded && !calendarMenuOpen() && Main.modalCount === modalBefore &&
        !tray._bannerBlocked, state());

    // Resting on the pill must not open the island over an open menu.
    settings().set_int('hover-open-delay', 350);
    await movePointerTo(...pillCenter());
    await pressKeys(Clutter.KEY_Super_L, Clutter.KEY_v);
    await sleep(800);
    check('calendar: hover-open does not take over from an open menu',
        calendarMenuOpen() && !island().expanded, state());
    await movePointerTo(...away);
    settings().set_int('hover-open-delay', 0);
    await closeCalendarMenu();

    // The unread dot. Showing GNOME's list marks every notification seen
    // (GNOME's rule), which gives a clean start.
    island()._calendarMenu.open();
    await sleep(animationWait());
    await closeCalendarMenu();
    check('calendar: no dot without unseen notifications', !gnomeUnreadDot() && !pillUnreadDot(), state());

    // The test's own source. LOW urgency gets no banner, so GNOME counts it
    // as unseen at once.
    const source = new MessageTray.Source({title: 'Froonty test', iconName: 'dialog-information-symbolic'});
    tray.add(source);
    const notify = (title, urgency) => {
        const n = new MessageTray.Notification({source, title, body: 'Froonty headless test', urgency});
        source.addNotification(n);
        return n;
    };
    const unseen = notify('Unseen', MessageTray.Urgency.LOW);
    await sleep(2 * SETTLE_MS);
    const view = island()._collapsedView;
    check('calendar: an unseen notification puts GNOME\'s dot on the pill (and in its name)',
        gnomeUnreadDot() && pillUnreadDot() && view._unreadPad.visible &&
        pill().accessible_name.endsWith(', unread notifications'),
        `gnome=${gnomeUnreadDot()} pill=${pillUnreadDot()} name="${pill().accessible_name}"`);
    const covers = pillCoversClock();
    check('calendar: the pill still covers the clock, which GNOME\'s dot widens', covers.ok, covers.detail);
    check('calendar: the time keeps its room next to the dot', !isEllipsized(view._timeLabel));
    await screenshotTop(outDir, 'collapsed-unread');
    settings().set_boolean('show-date', true);
    await sleep(2 * SETTLE_MS);
    check('calendar: so do date and time together',
        !isEllipsized(view._timeLabel) && !isEllipsized(view._dateLabel),
        `"${view._dateLabel.text}" "${view._timeLabel.text}" pill width ${pill().width}`);
    await screenshotTop(outDir, 'collapsed-unread-date');
    settings().reset('show-date');
    await sleep(SETTLE_MS);

    island().expand();
    await sleep(animationWait());
    hub = island()._hub;
    check('calendar: 📅 carries the dot in the expanded island',
        hub._header.unreadBadge.visible && hub._header.unreadBadge.mapped);
    await screenshotTop(outDir, 'hub-unread');
    island().collapse();
    await sleep(animationWait());

    // Default session mode only: when Do Not Disturb ends, Ubuntu Dock
    // (Ubuntu mode) logs TypeErrors of its own ("remoteModel is undefined":
    // its NotificationsMonitor emits 'state-changed' before DockManager
    // has made the model again), which run.sh would count against the run.
    const dock = Main.extensionManager.lookup('ubuntu-dock@ubuntu.com');
    if (dock?.state !== ExtensionState.ACTIVE) {
        const notifications = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
        notifications.set_boolean('show-banners', false);
        await sleep(SETTLE_MS);
        check('calendar: Do Not Disturb hides the dot, as on GNOME\'s clock',
            !gnomeUnreadDot() && !pillUnreadDot());
        notifications.reset('show-banners');
        await sleep(SETTLE_MS);
        check('calendar: the dot is back when Do Not Disturb ends', gnomeUnreadDot() && pillUnreadDot());
    }

    island().expand();
    await sleep(animationWait());
    await clickActor(island()._hub.calendarButton);
    await sleep(animationWait());
    check('calendar: GNOME\'s list marks it seen, the dot goes; the notification stays',
        calendarMenuOpen() && !gnomeUnreadDot() && !pillUnreadDot() &&
        !island()._hub._header.unreadBadge.visible && source.notifications.includes(unseen),
        `${state()} kept=${source.notifications.includes(unseen)}`);
    await closeCalendarMenu();

    // A banner while expanded waits in GNOME's queue, unseen, and shows
    // once the island collapses. (Why: the island, chrome added after the
    // message tray, is drawn above GNOME's banners.)
    const stack = Main.layoutManager.uiGroup.get_children();
    check('calendar: the island is drawn above GNOME\'s banners (why they are held)',
        stack.indexOf(strip()) > stack.indexOf(tray) && stack.indexOf(tray) >= 0,
        `island ${stack.indexOf(strip())}, message tray ${stack.indexOf(tray)}`);
    island().expand();
    await sleep(animationWait());
    const banner = notify('Banner', MessageTray.Urgency.NORMAL);
    await sleep(SETTLE_MS);
    check('calendar: a banner waits while the island is expanded (not shown under it, not marked seen)',
        !tray.visible && !banner.acknowledged && tray.queueCount >= 1,
        `trayVisible=${tray.visible} seen=${banner.acknowledged} queue=${tray.queueCount}`);
    island().collapse();
    await sleep(animationWait() + MessageTray.ANIMATION_TIME);
    check('calendar: the banner shows once the island collapses',
        tray.visible && tray._notification === banner && banner.acknowledged,
        `trayVisible=${tray.visible} shown=${tray._notification?.title} seen=${banner.acknowledged}`);
    await screenshotTop(outDir, 'banner-after-collapse', 200);

    // Only the test removes its own notifications.
    source.destroy();
    await sleep(animationWait());
    check('calendar: no dot once the test\'s notifications are gone', !gnomeUnreadDot() && !pillUnreadDot());

    // Disable while expanded: banners free, Froonty's handlers on the date
    // menu gone; enable connects them again, once.
    const handlerCounts = () => ({
        unread: countHandlers(dateMenuButton()._indicator, 'notify::visible'),
        opened: jsHandlerCount(menu, 'open-state-changed'),
    });
    const enabled = handlerCounts();
    island().expand();
    await sleep(animationWait());
    const held = tray._bannerBlocked;
    await setExtensionEnabled(false);
    const disabled = handlerCounts();
    check('calendar: disable while expanded frees banners and drops the date menu handlers',
        held && !tray._bannerBlocked && Main.modalCount === modalBefore &&
        disabled.unread === enabled.unread - 1 && disabled.opened === enabled.opened - 1,
        `held=${held} ${state()} enabled=${JSON.stringify(enabled)} disabled=${JSON.stringify(disabled)}`);
    await setExtensionEnabled(true);
    await sleep(SETTLE_MS);
    check('calendar: enable connects them again, once',
        JSON.stringify(handlerCounts()) === JSON.stringify(enabled), JSON.stringify(handlerCounts()));

    // Leave the island as found: its hub shown once (later checks measure
    // the hub's actors, which have no size before they are first shown).
    island().expand();
    await sleep(animationWait());
    island().collapse();
    await sleep(animationWait());
}

// ---------------------------------------------------------------- notifications tab

// The Notifications tab lists GNOME's own notifications. These checks
// only add, click, dismiss or clear notifications of their own sources
// (and three of their own sent over org.freedesktop.Notifications), and
// destroy only those at the end. GNOME's notifications are never read
// once destroyed (a row's description is read instead): GJS would log it.

const notificationsEntry = () => island()._hub._entries.get('notifications') ?? null;
const notificationsView = () => notificationsEntry()?.view ?? null;
const notificationRows = () => notificationsView()?._list.get_children() ?? [];
const notificationRow = title =>
    notificationRows().find(row => row.description?.title === title) ?? null;
const rowTitles = () => notificationRows().map(row => row.description?.title);
const sameCounts = (a, b, plus = 0) =>
    Object.keys(a).every(k => a[k] + plus === b[k]);

async function testNotifications(outDir) {
    const MessageTray = await import('resource:///org/gnome/shell/ui/messageTray.js');
    const {Urgency, NotificationDestroyedReason: Reason} = MessageTray;
    const tray = Main.messageTray;
    const s = settings();
    const monitor = Main.layoutManager.primaryMonitor;
    const away = [monitor.x + 60, monitor.y + monitor.height / 2];
    const modalBefore = Main.modalCount;
    // The Claude attention bar's own store (the Claude app's notifications)
    // holds a tray handler for as long as Froonty runs; it is off here, so
    // the handler counts below are the tab's alone (testClaudeAttention
    // checks that store).
    s.set_boolean('claude-attention-app', false);
    s.set_boolean('claude-attention-browsers', false);
    // Every destruction of the test's notifications, [title, reason], and
    // every activation: Froonty's acts show up here, and nothing else may.
    const destroyed = [];
    const activated = [];
    const ran = [];

    const sources = [];
    const alive = source => tray.getSources().includes(source);
    const newSource = (title, iconName) => {
        const source = new MessageTray.Source({title, iconName});
        tray.add(source);
        sources.push(source);
        return source;
    };
    // GNOME destroys a source once its last notification goes.
    let mail = newSource('Froonty mail', 'mail-unread-symbolic');
    const mailSource = () => {
        if (!alive(mail))
            mail = newSource('Froonty mail', 'mail-unread-symbolic');
        return mail;
    };
    const build = newSource('Froonty build', 'emblem-system-symbolic');
    // Every property in the constructor: GNOME re-stamps the time of a
    // notification whose properties change later. LOW (no banner) unless
    // asked; CRITICAL ones come acknowledged (a critical banner never
    // times out).
    const notify = (source, title, {urgency = Urgency.LOW, seconds = 0, actions = [], ...more} = {}) => {
        const n = new MessageTray.Notification({
            source,
            title,
            body: `${title}: Froonty headless test`,
            urgency,
            datetime: GLib.DateTime.new_now_local().add_seconds(-seconds),
            ...more,
        });
        n.connect('destroy', (_n, reason) => destroyed.push([title, reason]));
        n.connect('activated', () => activated.push(title));
        for (const label of actions)
            n.addAction(label, () => ran.push(label));
        source.addNotification(n);
        return n;
    };
    const counts = (source, notification) => ({
        tray: countHandlers(tray, 'source-added'),
        source: countHandlers(source, 'notification-added'),
        notification: countHandlers(notification, 'notify'),
    });
    const expand = async () => {
        island().expand();
        await sleep(animationWait());
    };
    const collapse = async () => {
        island().collapse();
        await sleep(animationWait());
    };
    const dotsOff = () => !gnomeUnreadDot() && !pillUnreadDot() &&
        !island()._hub._header.unreadBadge.visible && !notificationsEntry().dot.visible;

    const critical = notify(build, 'Build failed', {urgency: Urgency.CRITICAL, seconds: 1800, acknowledged: true});
    const recent = notify(mail, 'New mail', {seconds: 120,
        gicon: new Gio.ThemedIcon({name: 'avatar-default-symbolic'})});
    const older = notify(mail, 'Older mail', {seconds: 600});
    const markup = notify(mail, 'Markup', {seconds: 1200, useBodyMarkup: true,
        body: '<b>Bold</b> & <i>it</i> <x>'});
    notify(mail, 'Long body', {seconds: 900, body: Array.from({length: 40},
        (_, i) => `word${i}`).join(' ')});

    // On by default, after Clock (and a Calendar tab, if there is one).
    let hub = island()._hub;
    const order = hub._tabColumn.get_children()
        .map(button => [...hub._entries].find(([, e]) => e.button === button)?.[0]);
    const expectedPlace = order.indexOf('clock') + (order[order.indexOf('clock') + 1] === 'calendar' ? 2 : 1);
    check('notifications: on by default, its tab right after Clock (and Calendar)',
        s.get_default_value('notifications-enabled').unpack() === true &&
        s.get_boolean('notifications-enabled') && order.indexOf('notifications') === expectedPlace,
        order.join(','));

    // Nothing watched before the tab is on screen, even with its view made.
    const base = counts(mail, older);
    hub.select('notifications');
    await sleep(SETTLE_MS);
    check('notifications: nothing is watched before the tab is shown (only GNOME\'s own handlers)',
        sameCounts(base, counts(mail, older)) && notificationsView() !== null &&
        !notificationsEntry().service.active,
        `${JSON.stringify(base)} -> ${JSON.stringify(counts(mail, older))}`);
    check('notifications: unseen ones put GNOME\'s dot on the tab too, and in its name',
        gnomeUnreadDot() && notificationsEntry().dot.visible &&
        notificationsEntry().button.accessible_name === 'Notifications, unread notifications',
        `gnome=${gnomeUnreadDot()} name="${notificationsEntry().button.accessible_name}"`);

    // Opened by hover: the list shows, nothing is marked seen.
    s.set_int('hover-open-delay', 350);
    await movePointerTo(...away);
    await movePointerTo(...pillCenter());
    await sleep(800);
    await movePointerTo(...away);
    const view = notificationsView();
    check('notifications: hover-open shows the list and marks nothing seen; the dots stay',
        island().expanded && rowTitles().length >= 4 && !recent.acknowledged && !older.acknowledged &&
        gnomeUnreadDot() && pillUnreadDot() && notificationsEntry().dot.visible &&
        notificationRow('New mail')?._part('new').visible,
        `expanded=${island().expanded} rows=${rowTitles()} seen=${recent.acknowledged}`);
    const ours = ['Build failed', 'New mail', 'Older mail', 'Long body', 'Markup'];
    check('notifications: urgent first, then newest first (30 min critical, 2 min, 10 min, 15 min, 20 min)',
        rowTitles().filter(t => ours.includes(t)).join(',') === ours.join(',') &&
        notificationRow('Build failed').has_style_class_name('froonty-notifications-row-urgent') &&
        !notificationRow('New mail').has_style_class_name('froonty-notifications-row-urgent'),
        rowTitles().join(','));
    const shows = (title, n, source) => {
        const row = notificationRow(title);
        return row && row._part('app').text === source.title &&
            row._part('app-icon').gicon?.equal(source.icon) &&
            row._part('age').text === `· ${view._format.timeAgo(n.datetime)}` &&
            row._part('title').text === title && row._part('body').text === n.body;
    };
    const iconOf = title => notificationRow(title)?._part('icon');
    check('notifications: each row names its app with its icon, and shows its age, title and body',
        shows('New mail', recent, mail) && shows('Older mail', older, mail) &&
        shows('Build failed', critical, build) && notificationRow('New mail')._part('age').text.length > 2,
        ['New mail', 'Older mail'].map(t => {
            const row = notificationRow(t);
            return `${row?._part('app').text}|${row?._part('age').text}|${row?._part('title').text}|${row?._part('body').text}`;
        }).join(' / '));
    check('notifications: the notification\'s own icon shows only when it has one',
        iconOf('New mail')?.visible && iconOf('New mail').gicon?.equal(recent.gicon) &&
        !iconOf('Older mail')?.visible);
    const longBody = notificationRow('Long body')?._part('body');
    const [, wrapped] = longBody?.get_preferred_height(longBody.width) ?? [0, 0];
    const oneLine = longBody?.get_preferred_height(-1)[1] ?? 0;
    check('notifications: a long body stops at three lines, its last one ellipsized',
        longBody && isEllipsized(longBody) && longBody.height < wrapped &&
        Math.abs(longBody.height - 3 * oneLine) <= 1,
        `height=${longBody?.height} wrapped=${wrapped} line=${oneLine} ellipsized=${longBody && isEllipsized(longBody)}`);
    check('notifications: body markup is shown as GNOME\'s list shows it, without the markup',
        notificationRow('Markup')?._part('body').text === 'Bold & it <x>',
        notificationRow('Markup')?._part('body').text);
    await screenshotTop(outDir, 'notifications-list', 520);

    // A modifier alone is not input to the island (the user may be about
    // to type into their window). After a hover-open the key focus is on
    // the pill; once Tab moved it into the island, a key is deliberate.
    // (More in testNotificationSafeguards.)
    await pressKeys(Clutter.KEY_Shift_L);
    check('notifications: a modifier-only key after a hover-open marks nothing; the dots stay',
        island().expanded && !recent.acknowledged && !older.acknowledged && !markup.acknowledged &&
        gnomeUnreadDot() && pillUnreadDot() && notificationsEntry().dot.visible,
        `seen=${recent.acknowledged} gnome=${gnomeUnreadDot()} tab=${notificationsEntry().dot.visible}`);
    await pressKeys(Clutter.KEY_Tab);
    await pressKeys(Clutter.KEY_x);
    check('notifications: once Tab moved the focus into the island, a key marks them seen; GNOME\'s, the pill\'s, 📅\'s and the tab\'s dots go',
        recent.acknowledged && older.acknowledged && markup.acknowledged && dotsOff() &&
        !notificationRow('New mail')._part('new').visible && destroyed.length === 0,
        `seen=${recent.acknowledged} gnome=${gnomeUnreadDot()} tab=${notificationsEntry().dot.visible}`);
    s.set_int('hover-open-delay', 0);

    // Watching only while on screen.
    const shown = counts(mail, older);
    await collapse();
    const collapsed = counts(mail, older);
    await expand();
    await clickActor(tabButton('clock'));
    await sleep(animationWait());
    const otherTab = counts(mail, older);
    check('notifications: one handler on the tray, each source and each notification while on screen; none collapsed or on another tab',
        sameCounts(base, shown, 1) && sameCounts(base, collapsed) && sameCounts(base, otherTab),
        `base=${JSON.stringify(base)} shown=${JSON.stringify(shown)} collapsed=${JSON.stringify(collapsed)} ` +
        `other tab=${JSON.stringify(otherTab)}`);
    await clickActor(tabButton('notifications'));
    await sleep(animationWait());

    // Live: one arriving while on screen.
    const live = notify(mail, 'Live', {urgency: Urgency.NORMAL});
    await sleep(SETTLE_MS);
    const titlesNow = rowTitles();
    check('notifications: one arriving while on screen appears in its place with its new-dot; not seen, its banner held',
        titlesNow.indexOf('Live') === titlesNow.indexOf('Build failed') + 1 &&
        notificationRow('Live')?._part('new').visible && !live.acknowledged &&
        tray.queueCount >= 1 && !tray.visible,
        `${titlesNow} seen=${live.acknowledged} queue=${tray.queueCount} trayVisible=${tray.visible}`);

    // Updated in place: GNOME re-stamps its time, so it moves up.
    const olderRow = notificationRow('Older mail');
    older.set({title: 'Older mail, updated', body: 'Updated body'});
    await sleep(SETTLE_MS);
    check('notifications: an update in place changes the row\'s text and age, and moves it up',
        notificationRow('Older mail, updated') === olderRow &&
        olderRow._part('body').text === 'Updated body' &&
        olderRow._part('age').text === `· ${view._format.timeAgo(older.datetime)}` &&
        rowTitles().indexOf('Older mail, updated') === rowTitles().indexOf('Build failed') + 1,
        rowTitles().join(','));
    await screenshotTop(outDir, 'notifications-live', 520);

    // Its banner waits. The next key marks the list seen, but not the one
    // waiting for its banner: GNOME's banner marks it seen once the island
    // closes (testNotificationSafeguards follows that). Removed here, so
    // no banner shows during the checks that follow.
    const liveLow = notify(mail, 'Live, low');
    await sleep(SETTLE_MS);
    await pressKeys(Clutter.KEY_x);
    check('notifications: the next key marks a new one seen, but leaves the one waiting for its banner unseen, with its dot',
        liveLow.acknowledged && !live.acknowledged && tray._notificationQueue.includes(live) &&
        notificationRow('Live')?._part('new').visible,
        `low=${liveLow.acknowledged} live=${live.acknowledged} queue=${tray.queueCount}`);
    live.destroy(Reason.SOURCE_CLOSED);
    liveLow.destroy(Reason.SOURCE_CLOSED);

    // Closed by its app (here, the test): its row goes.
    markup.destroy(Reason.SOURCE_CLOSED);
    await sleep(SETTLE_MS);
    check('notifications: one closed by its app leaves the list',
        !notificationRow('Markup') && island().expanded);

    // A deliberate open marks what it lists seen, and removes nothing.
    await collapse();
    const unseen = notify(mail, 'Unseen again', {seconds: 5});
    await sleep(SETTLE_MS);
    const dotBefore = gnomeUnreadDot() && pillUnreadDot();
    const logBefore = destroyed.length;
    await expand();
    check('notifications: a deliberate open marks the listed ones seen: every dot goes, every notification stays',
        dotBefore && unseen.acknowledged && dotsOff() && destroyed.length === logBefore &&
        notificationRow('Unseen again') && mail.notifications.includes(unseen) &&
        mail.notifications.includes(recent) && build.notifications.includes(critical),
        `dot before=${dotBefore} seen=${unseen.acknowledged} log=${JSON.stringify(destroyed)}`);

    // Another tab on screen: a LOW one lights the tab's dot (GNOME's rule).
    await clickActor(tabButton('clock'));
    await sleep(animationWait());
    const low = notify(mail, 'Low while open');
    await sleep(SETTLE_MS);
    const entry = notificationsEntry();
    check('notifications: a LOW one arriving with Clock on screen lights the tab\'s dot and 📅\'s; the tab says so',
        entry.dot.visible && entry.dot.mapped && island()._hub._header.unreadBadge.visible &&
        entry.button.accessible_name.endsWith(', unread notifications') && !low.acknowledged,
        `tab dot=${entry.dot.visible} name="${entry.button.accessible_name}"`);
    await screenshotTop(outDir, 'notifications-tab-dot', 520);
    await clickActor(tabButton('notifications'));
    await sleep(animationWait());
    check('notifications: clicking the tab shows it and marks it seen; the dot goes',
        low.acknowledged && dotsOff() && entry.button.accessible_name === 'Notifications');

    // A click on a row: GNOME's activate(), then the island closes.
    notify(mailSource(), 'Click me');
    await sleep(SETTLE_MS);
    await clickActor(notificationRow('Click me')._part('title'));
    await sleep(animationWait());
    check('notifications: a click on a row activates it once; GNOME removes it (dismissed); the island closes, no grab left',
        activated.filter(t => t === 'Click me').length === 1 &&
        destroyed.filter(([t]) => t === 'Click me').map(([, r]) => r).join() === `${Reason.DISMISSED}` &&
        !island().expanded && !island()._grabHelper.grabbed && Main.modalCount === modalBefore,
        `activated=${activated} destroyed=${JSON.stringify(destroyed)} expanded=${island().expanded} modal=${Main.modalCount}`);

    await expand();
    const resident = notify(mailSource(), 'Resident', {resident: true});
    await sleep(SETTLE_MS);
    await clickActor(notificationRow('Resident')._part('title'));
    await sleep(animationWait());
    check('notifications: a resident one stays after a click, as in GNOME',
        activated.includes('Resident') && mail.notifications.includes(resident) &&
        !destroyed.some(([t]) => t === 'Resident') && !island().expanded);

    // Actions: at most three buttons; a click runs the app's action.
    await expand();
    notify(mailSource(), 'Actions', {actions: ['One', 'Two', 'Three', 'Four']});
    await sleep(SETTLE_MS);
    const actionButtons = notificationRow('Actions')?._part('actions').get_children() ?? [];
    check('notifications: four actions show the first three, with their labels',
        actionButtons.length === 3 && actionButtons.map(b => b.label).join(',') === 'One,Two,Three',
        actionButtons.map(b => b.label).join(','));
    await movePointerTo(...away);
    await screenshotTop(outDir, 'notifications-urgent-actions', 520);
    await clickActor(actionButtons[1]);
    await sleep(animationWait());
    check('notifications: clicking the second runs the app\'s action; GNOME removes it; the island closes',
        ran.join(',') === 'Two' && destroyed.some(([t, r]) => t === 'Actions' && r === Reason.DISMISSED) &&
        !island().expanded && Main.modalCount === modalBefore,
        `ran=${ran} expanded=${island().expanded}`);

    // × dismisses that one only; the island stays open.
    await expand();
    notify(mailSource(), 'Dismiss me');
    await sleep(SETTLE_MS);
    const listedBefore = rowTitles().length;
    await clickActor(notificationRow('Dismiss me')._part('dismiss'));
    await sleep(SETTLE_MS);
    check('notifications: × dismisses only that one (reason 2); the others stay; the island stays open',
        destroyed.filter(([t]) => t === 'Dismiss me').map(([, r]) => r).join() === `${Reason.DISMISSED}` &&
        rowTitles().length === listedBefore - 1 && !notificationRow('Dismiss me') && island().expanded,
        `${rowTitles()} expanded=${island().expanded}`);

    // Keyboard: Tab to a row, Delete dismisses it (the focus moves on),
    // Enter activates the next.
    notify(mailSource(), 'Key A');
    notify(mailSource(), 'Key B');
    await sleep(SETTLE_MS);
    const mainOf = title => notificationRow(title)?._part('main') ?? null;
    for (let i = 0; i < 40 && global.stage.key_focus !== mainOf('Key B'); i++)
        await pressKeys(Clutter.KEY_Tab);
    check('notifications: Tab reaches a row', global.stage.key_focus === mainOf('Key B'),
        `focus=${global.stage.key_focus}`);
    const keyA = mainOf('Key A');
    await pressKeys(Clutter.KEY_Delete);
    check('notifications: Delete dismisses it (reason 2), and the focus moves to the next row',
        destroyed.some(([t, r]) => t === 'Key B' && r === Reason.DISMISSED) &&
        global.stage.key_focus === keyA && island().expanded,
        `focus=${global.stage.key_focus} rows=${rowTitles()}`);
    await pressKeys(Clutter.KEY_Return);
    await sleep(animationWait());
    check('notifications: Enter activates it; GNOME removes it; the island closes',
        activated.includes('Key A') && destroyed.some(([t]) => t === 'Key A') && !island().expanded);

    // "Clear all": two clicks, for exactly what was listed at the first.
    await expand();
    let v = notificationsView();
    const listed = [...v._service.items];
    const onlyOurs = listed.length > 0 && listed.every(n => sources.includes(n.source));
    check('notifications: only the test\'s own notifications are listed (Clear all touches nothing else)',
        onlyOurs, `${listed.length} listed`);
    if (onlyOurs) {
        const clearLog = destroyed.length;
        await clickActor(v._clearButton);
        check('notifications: "Clear all" asks first: "Clear N?", nothing removed yet',
            v._confirmButton.visible && v._confirmButton.label === `Clear ${listed.length}?` &&
            v._keepButton.visible && !v._clearButton.visible && destroyed.length === clearLog,
            `label=${v._confirmButton.label} destroyed=${destroyed.length - clearLog}`);
        await screenshotTop(outDir, 'notifications-confirm', 520);
        await clickActor(v._keepButton);
        check('notifications: "Keep them" keeps them all',
            !v._confirmButton.visible && v._clearButton.visible && destroyed.length === clearLog &&
            v._service.items.length === listed.length);

        await clickActor(v._clearButton);
        const between = notify(mailSource(), 'Between clicks');
        await sleep(SETTLE_MS);
        await clickActor(v._confirmButton);
        await sleep(SETTLE_MS);
        const cleared = destroyed.slice(clearLog);
        check('notifications: confirming clears exactly the first click\'s list, each dismissed; one added since stays',
            cleared.length === listed.length && cleared.every(([, r]) => r === Reason.DISMISSED) &&
            !cleared.some(([t]) => t === 'Between clicks') && rowTitles().join() === 'Between clicks' &&
            island().expanded,
            `cleared=${JSON.stringify(cleared)} rows=${rowTitles()}`);

        await clickActor(v._clearButton);
        await collapse();
        await expand();
        check('notifications: collapsing drops a pending "Clear all"',
            !v._confirmButton.visible && !v._keepButton.visible && v._clearButton.visible &&
            mail.notifications.includes(between));
        const single = notificationRow('Between clicks');
        const [, singleHeight] = single?.get_preferred_height(single.width) ?? [0, 0];
        check('notifications: a lone row keeps its own height (the list does not stretch it)',
            single && Math.abs(single.height - singleHeight) <= 1 && single.height < v._scroll.height / 2,
            `row ${single?.height}, natural ${singleHeight}, list ${v._scroll.height}`);

        between.destroy(Reason.SOURCE_CLOSED);
        await sleep(SETTLE_MS);
        check('notifications: empty: "No notifications", and no Clear button',
            v._empty.visible && !v._scroll.visible && !v._clearButton.visible &&
            v._status.text === '0 notifications', `status=${v._status.text}`);
        await screenshotTop(outDir, 'notifications-empty', 520);
    }

    // Do Not Disturb (default session mode only: when it ends, Ubuntu
    // Dock logs TypeErrors of its own; see testCalendarMenu).
    const dock = Main.extensionManager.lookup('ubuntu-dock@ubuntu.com');
    if (dock?.state !== ExtensionState.ACTIVE) {
        const [isolated, where] = privacyIsIsolated(outDir);
        check('notifications: GNOME\'s notification settings are the private test copy', isolated, where);
        if (isolated) {
            const gnomeSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
            const whileDnd = notify(mailSource(), 'While Do Not Disturb');
            gnomeSettings.set_boolean('show-banners', false);
            await sleep(SETTLE_MS);
            check('notifications: under Do Not Disturb the header says so, the toggle is on, the list stays',
                v._status.text.startsWith('Do Not Disturb · ') && v._dndButton.checked &&
                notificationRow('While Do Not Disturb') !== null, v._status.text);
            await screenshotTop(outDir, 'notifications-dnd', 520);
            await clickActor(v._dndButton);
            check('notifications: the toggle ends Do Not Disturb (GNOME\'s own key)',
                await waitFor(() => gnomeSettings.get_boolean('show-banners')) && !v._dndButton.checked);
            gnomeSettings.reset('show-banners');
            whileDnd.destroy(Reason.SOURCE_CLOSED);
            await sleep(SETTLE_MS);
        }
    }

    await testFdoNotifications(Reason);

    // Size: its own, live from Settings.
    await expand();
    if (island()._hub.activeFeature?.id !== 'notifications') {
        await clickActor(tabButton('notifications'));
        await sleep(animationWait());
    }
    const [w, h] = pill().get_transformed_size();
    s.set_int('notifications-width', 520);
    s.set_int('notifications-height', 360);
    await sleep(animationWait());
    const [w2, h2] = pill().get_transformed_size();
    check('notifications: 400×440 by default, and live with the settings',
        w === 400 * scale() && h === 440 * scale() && w2 === 520 * scale() && h2 === 360 * scale(),
        `${w}x${h} then ${w2}x${h2}`);
    s.reset('notifications-width');
    s.reset('notifications-height');
    await sleep(animationWait());

    // Never removed behind the user's back.
    notify(mailSource(), 'Stays');
    notify(mail, 'Stays too', {urgency: Urgency.CRITICAL, acknowledged: true});
    await sleep(SETTLE_MS);
    await collapse();
    await expand();
    const kept = [...mail.notifications];
    const state = () => kept.map(n => alive(mail) && mail.notifications.includes(n)
        ? `listed:${n.acknowledged}` : 'gone').join(',');
    const before = state();
    const keepLog = destroyed.length;
    for (let i = 0; i < 5; i++) {
        await collapse();
        await expand();
        island()._hub.select('clock');
        await sleep(SETTLE_MS);
        island()._hub.select('notifications');
        await sleep(SETTLE_MS);
        await setExtensionEnabled(false);
        await setExtensionEnabled(true);
        await expand();
    }
    check('notifications: open, close, switch tabs and disable/enable while shown, 5 times: nothing removed or changed',
        state() === before && destroyed.length === keepLog && kept.length === 2,
        `${before} -> ${state()} destroyed=${JSON.stringify(destroyed.slice(keepLog))}`);

    // Disable while on screen: no handler left; enable and reopen: once.
    await collapse();
    const anchor = kept[0];
    const idle = counts(mail, anchor);
    await expand();
    const onScreen = counts(mail, anchor);
    await setExtensionEnabled(false);
    const disabled = counts(mail, anchor);
    await setExtensionEnabled(true);
    const enabled = counts(mail, anchor);
    await expand();
    const reopened = counts(mail, anchor);
    check('notifications: disable while on screen leaves no handler on the tray, a source or a notification; reopened, once',
        sameCounts(idle, onScreen, 1) && sameCounts(idle, disabled) && sameCounts(idle, enabled) &&
        sameCounts(idle, reopened, 1),
        [idle, onScreen, disabled, enabled, reopened].map(c => JSON.stringify(c)).join(' '));

    // Only the test's own sources; the island as found.
    await collapse();
    for (const source of sources) {
        if (alive(source))
            source.destroy(Reason.SOURCE_CLOSED);
    }
    s.set_int('hover-open-delay', 0);
    island()._hub.select('clock');
    s.reset('hub-last-tab');
    s.reset('claude-attention-app');
    s.reset('claude-attention-browsers');
    await sleep(SETTLE_MS);
    hub = island()._hub;
    check('notifications: the test\'s sources are gone, Clock is shown again',
        sources.every(source => !alive(source)) && hub.activeFeature?.id === 'clock');
}

// A real notification over D-Bus, through GNOME's own daemon (the
// org.gnome.Shell.Notifications service in front of the Shell): its
// actions reach the app as ActionInvoked and NotificationClosed, which
// the service sends back to the sender, here the Shell itself.
async function testFdoNotifications(Reason) {
    const signals = [];
    const subscription = Gio.DBus.session.signal_subscribe(null, 'org.freedesktop.Notifications',
        null, '/org/freedesktop/Notifications', null, Gio.DBusSignalFlags.NONE,
        (_connection, _sender, _path, _iface, name, params) => signals.push([name, ...params.deepUnpack()]));
    const sent = [];
    const send = title => new Promise((resolve, reject) => {
        Gio.DBus.session.call('org.freedesktop.Notifications', '/org/freedesktop/Notifications',
            'org.freedesktop.Notifications', 'Notify',
            new GLib.Variant('(susssasa{sv}i)', ['Froonty test', 0, 'dialog-information-symbolic',
                title, 'Sent over D-Bus', ['default', 'Open', 'reply', 'Reply'],
                {urgency: new GLib.Variant('y', 0)}, -1]),
            new GLib.VariantType('(u)'), Gio.DBusCallFlags.NONE, 5000, null,
            (connection, result) => {
                try {
                    resolve(connection.call_finish(result).deepUnpack()[0]);
                } catch (e) {
                    reject(e);
                }
            });
    });
    // The Shell's object behind it (alive while listed).
    const shellNotification = title => Main.messageTray.getSources()
        .flatMap(source => source.notifications).find(n => n.title === title) ?? null;
    const reasons = new Map();
    const deliver = async title => {
        const id = await send(title);
        await waitFor(() => notificationRow(title) !== null, 3000);
        // Laid out on the next frame: a click before that misses the row.
        await sleep(SETTLE_MS);
        const n = shellNotification(title);
        n?.connect('destroy', (_n, reason) => reasons.set(title, reason));
        sent.push(title);
        return id;
    };
    const signalled = (name, id, value) =>
        waitFor(() => signals.some(([n, i, v]) => n === name && i === id && v === value), 3000);

    try {
        island().expand();
        await sleep(animationWait());
        const replyId = await deliver('Over D-Bus: reply');
        const buttons = notificationRow('Over D-Bus: reply')?._part('actions').get_children() ?? [];
        check('notifications: a real notification sent over D-Bus is listed, its "Reply" action a button',
            buttons.length === 1 && buttons[0].label === 'Reply', buttons.map(b => b.label).join(','));
        await clickActor(buttons[0]);
        check('notifications: its "Reply" runs GNOME\'s action, which removes it (dismissed); the island closes',
            await waitFor(() => reasons.get('Over D-Bus: reply') === Reason.DISMISSED) && !island().expanded,
            `reason=${reasons.get('Over D-Bus: reply')}`);
        check('notifications: the app gets ActionInvoked "reply" over D-Bus',
            await signalled('ActionInvoked', replyId, 'reply'), JSON.stringify(signals));

        island().expand();
        await sleep(animationWait());
        const closeId = await deliver('Over D-Bus: dismiss');
        await clickActor(notificationRow('Over D-Bus: dismiss')._part('dismiss'));
        check('notifications: × on it: GNOME destroys it dismissed, and the app gets NotificationClosed reason 2',
            await waitFor(() => reasons.get('Over D-Bus: dismiss') === Reason.DISMISSED) &&
            await signalled('NotificationClosed', closeId, 2), JSON.stringify(signals));

        const openId = await deliver('Over D-Bus: open');
        await clickActor(notificationRow('Over D-Bus: open')._part('title'));
        check('notifications: a click on it: the app gets ActionInvoked "default"',
            await signalled('ActionInvoked', openId, 'default') &&
            reasons.get('Over D-Bus: open') === Reason.DISMISSED, JSON.stringify(signals));
        await sleep(animationWait());
    } finally {
        Gio.DBus.session.signal_unsubscribe(subscription);
        // Should a check have failed half-way: only the test's own.
        for (const title of sent)
            shellNotification(title)?.destroy(Reason.SOURCE_CLOSED);
        island().collapse();
        await sleep(animationWait());
    }
}

// ---------------------------------------------------------------- notifications: safeguards
//
// Accidents that must not cost the user a notification or mark one seen
// unread: keys and scrolls after a hover-open, a double click on ×, a held
// Delete, a double Enter on "Clear all", an app updating a notification
// while "Clear N?" waits, a click on an app's notification sent without a
// default action (GNOME's rule, documented), and GNOME's dot while banners
// are held. Only the test's own notifications (its own sources, and its
// own over org.freedesktop.Notifications) are touched; all are removed at
// the end.

const centerOf = actor => {
    const b = boxOf(actor);
    return [(b.x1 + b.x2) / 2, (b.y1 + b.y2) / 2];
};

// One D-Bus notification: [id, the Shell's object for it].
async function sendFdoNotification(appName, title, {replaces = 0, actions = [], hints = {}} = {}) {
    const id = await new Promise((resolve, reject) => {
        Gio.DBus.session.call('org.freedesktop.Notifications', '/org/freedesktop/Notifications',
            'org.freedesktop.Notifications', 'Notify',
            new GLib.Variant('(susssasa{sv}i)', [appName, replaces, 'dialog-information-symbolic',
                title, 'Sent over D-Bus', actions,
                {urgency: new GLib.Variant('y', 0), ...hints}, -1]),
            new GLib.VariantType('(u)'), Gio.DBusCallFlags.NONE, 5000, null,
            (connection, result) => {
                try {
                    resolve(connection.call_finish(result).deepUnpack()[0]);
                } catch (e) {
                    reject(e);
                }
            });
    });
    const shellNotification = () => Main.messageTray.getSources()
        .flatMap(source => source.notifications).find(n => n.title === title) ?? null;
    await waitFor(() => shellNotification() !== null && notificationRow(title) !== null, 3000);
    // Laid out on the next frame: a click before that misses the row.
    await sleep(SETTLE_MS);
    return [id, shellNotification()];
}

async function testNotificationSafeguards(outDir) {
    const MessageTray = await import('resource:///org/gnome/shell/ui/messageTray.js');
    const {Urgency, NotificationDestroyedReason: Reason} = MessageTray;
    const tray = Main.messageTray;
    const s = settings();
    const monitor = Main.layoutManager.primaryMonitor;
    const away = [monitor.x + 60, monitor.y + monitor.height / 2];
    // Every destruction of the test's notifications, [title, reason].
    const destroyed = [];
    const gone = title => destroyed.filter(([t]) => t === title).map(([, r]) => r).join();
    const sources = [];
    const fdo = new Map(); // title -> the Shell's notification, for clean-up
    const alive = source => tray.getSources().includes(source);
    let own = null;
    const ownSource = () => {
        if (!own || !alive(own)) {
            own = new MessageTray.Source({title: 'Froonty safeguards', iconName: 'mail-unread-symbolic'});
            tray.add(own);
            sources.push(own);
        }
        return own;
    };
    const notify = (title, {urgency = Urgency.LOW, seconds = 0} = {}) => {
        const source = ownSource();
        const n = new MessageTray.Notification({
            source,
            title,
            body: `${title}: Froonty headless test`,
            urgency,
            datetime: GLib.DateTime.new_now_local().add_seconds(-seconds),
        });
        n.connect('destroy', (_n, reason) => destroyed.push([title, reason]));
        source.addNotification(n);
        return n;
    };
    const sendFdo = async (appName, title, options) => {
        const [id, n] = await sendFdoNotification(appName, title, options);
        // An update (replaces_id) is the same object, already followed.
        if (n && ![...fdo.values()].includes(n))
            n.connect('destroy', (_n, reason) => destroyed.push([title, reason]));
        if (n)
            fdo.set(title, n);
        return [id, n];
    };
    // Between sections: only the test's own go (closed by their "app").
    const removeOwn = async () => {
        if (own && alive(own))
            own.destroy(Reason.SOURCE_CLOSED);
        await sleep(SETTLE_MS);
    };
    const expand = async () => {
        island().expand();
        await sleep(animationWait());
    };
    const collapse = async () => {
        island().collapse();
        await sleep(animationWait());
    };
    const onlyOurs = () => notificationsView()._service.items
        .every(n => sources.includes(n.source) || [...fdo.values()].includes(n));
    const focus = () => global.stage.key_focus;
    const signals = [];
    const subscription = Gio.DBus.session.signal_subscribe(null, 'org.freedesktop.Notifications',
        null, '/org/freedesktop/Notifications', null, Gio.DBusSignalFlags.NONE,
        (_connection, _sender, _path, _iface, name, params) => signals.push([name, ...params.deepUnpack()]));

    try {
        await collapse();
        island()._hub.select('notifications');
        await sleep(SETTLE_MS);

        // ------------------------------------------------ after a hover-open
        // The pointer rests where the pill was (over the open island's
        // header), the key focus is on the pill: the user may only have
        // been reading the time while typing into their window.
        const h1 = notify('Hover: one', {seconds: 30});
        const h2 = notify('Hover: two', {seconds: 60});
        await sleep(SETTLE_MS);
        s.set_int('hover-open-delay', 350);
        await movePointerTo(...away);
        const pillSpot = pillCenter();
        const hoverOpen = async () => {
            await movePointerTo(...away);
            await movePointerTo(...pillSpot);
            await sleep(800);
        };
        const unseen = () => !h1.acknowledged && !h2.acknowledged && gnomeUnreadDot() &&
            pillUnreadDot() && notificationsEntry().dot.visible;
        await hoverOpen();
        check('notifications safeguards: hover-open lists them and marks nothing',
            island().expanded && notificationRow('Hover: one') !== null && unseen() && focus() === pill(),
            `expanded=${island().expanded} focus=${focus()}`);
        await pressKeys(Clutter.KEY_Shift_L);
        await pressKeys(Clutter.KEY_Control_L);
        await pressKeys(Clutter.KEY_Alt_L);
        check('notifications safeguards: Shift, Control or Alt alone after a hover-open mark nothing',
            island().expanded && unseen(), `seen=${h1.acknowledged}`);
        await pressKeys(Clutter.KEY_x);
        check('notifications safeguards: a key while the focus is still on the pill (meant for the window below) marks nothing',
            island().expanded && unseen() && focus() === pill(), `seen=${h1.acknowledged}`);
        const under = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, ...pillSpot);
        pointer.notify_discrete_scroll(now(), Clutter.ScrollDirection.DOWN, Clutter.ScrollSource.WHEEL);
        await sleep(SETTLE_MS);
        check('notifications safeguards: a scroll where the pill was (the header, not the list) marks nothing',
            island().expanded && unseen() && under !== null && !island()._hub._content.contains(under),
            `under=${under && describeActor(under)} seen=${h1.acknowledged}`);
        await pressKeys(Clutter.KEY_space);
        await sleep(animationWait());
        check('notifications safeguards: Space on the pill closes the island and marks nothing',
            !island().expanded && unseen(), `expanded=${island().expanded} seen=${h1.acknowledged}`);

        await hoverOpen();
        await pressKeys(Clutter.KEY_Tab);
        const inside = focus() !== null && focus() !== pill() && pill().contains(focus());
        check('notifications safeguards: Tab moves the focus into the island, and marks nothing by itself',
            island().expanded && inside && unseen(), `focus=${focus()} seen=${h1.acknowledged}`);
        await pressKeys(Clutter.KEY_x);
        check('notifications safeguards: then a key marks them seen, and the dots go',
            h1.acknowledged && h2.acknowledged && !gnomeUnreadDot() && !notificationsEntry().dot.visible,
            `seen=${h1.acknowledged},${h2.acknowledged} gnome=${gnomeUnreadDot()}`);
        await collapse();

        const h3 = notify('Hover: three', {seconds: 5});
        await sleep(SETTLE_MS);
        await hoverOpen();
        await movePointerTo(...centerOf(notificationRow('Hover: three')._part('title')));
        await sleep(SETTLE_MS);
        const stillUnseen = !h3.acknowledged;
        pointer.notify_discrete_scroll(now(), Clutter.ScrollDirection.DOWN, Clutter.ScrollSource.WHEEL);
        await sleep(SETTLE_MS);
        check('notifications safeguards: after a hover-open, moving onto the list marks nothing; a scroll over it does',
            stillUnseen && h3.acknowledged && island().expanded, `before=${stillUnseen} after=${h3.acknowledged}`);
        s.set_int('hover-open-delay', 0);
        await movePointerTo(...away);
        await screenshotTop(outDir, 'notifications-hover-input', 520);
        check('notifications safeguards: nothing was removed by any of that',
            destroyed.length === 0, JSON.stringify(destroyed));
        await removeOwn();

        // ------------------------------------------------ a double click on ×
        // × removes its row at once; the next row moves up under the
        // pointer, its × exactly where the first was.
        notify('Double C', {seconds: 30});
        notify('Double B', {seconds: 20});
        notify('Double A', {seconds: 10});
        await sleep(SETTLE_MS);
        check('notifications safeguards: newest first: A, B, C', rowTitles().join() === 'Double A,Double B,Double C',
            rowTitles().join());
        const [x, y] = centerOf(notificationRow('Double A')._part('dismiss'));
        const yB = centerOf(notificationRow('Double B')._part('dismiss'))[1];
        pointer.notify_absolute_motion(now(), x, y);
        await sleep(50);
        for (let i = 0; i < 2; i++) {
            pointer.notify_button(now(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
            await sleep(30);
            pointer.notify_button(now(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
            await sleep(i === 0 ? 120 : SETTLE_MS);
        }
        const xB = notificationRow('Double B') ? centerOf(notificationRow('Double B')._part('dismiss')) : [];
        check('notifications safeguards: a double click on × dismisses that one only; the next one, moved under the pointer, stays',
            gone('Double A') === `${Reason.DISMISSED}` && gone('Double B') === '' && gone('Double C') === '' &&
            Math.abs(xB[1] - y) < 2 && island().expanded,
            `destroyed=${JSON.stringify(destroyed.filter(([t]) => t.startsWith('Double')))} ×A y=${y}, ×B y=${yB} then ${xB[1]}`);
        await sleep(Clutter.Settings.get_default().double_click_time + 100);
        await clickAt(x, y);
        check('notifications safeguards: a click there after the double-click time dismisses the next one (on purpose)',
            gone('Double B') === `${Reason.DISMISSED}` && gone('Double C') === '',
            JSON.stringify(destroyed.filter(([t]) => t.startsWith('Double'))));
        await movePointerTo(...away);
        await removeOwn();

        // ------------------------------------------------ a held Delete
        for (const [i, seconds] of [[4, 40], [3, 30], [2, 20], [1, 10]])
            notify(`Delete ${i}`, {seconds});
        await sleep(SETTLE_MS);
        const mainOf = title => notificationRow(title)?._part('main') ?? null;
        for (let i = 0; i < 40 && focus() !== mainOf('Delete 1'); i++)
            await pressKeys(Clutter.KEY_Tab);
        let repeats = 0;
        const probe = pill().connect('captured-event', (_actor, event) => {
            if (event.type() === Clutter.EventType.KEY_PRESS &&
                event.get_flags() & Clutter.EventFlags.FLAG_REPEATED)
                repeats++;
            return Clutter.EVENT_PROPAGATE;
        });
        const focusedFirst = focus() === mainOf('Delete 1');
        keyboard.notify_keyval(now(), Clutter.KEY_Delete, Clutter.KeyState.PRESSED);
        await sleep(1500);
        keyboard.notify_keyval(now(), Clutter.KEY_Delete, Clutter.KeyState.RELEASED);
        await sleep(SETTLE_MS);
        pill().disconnect(probe);
        check('notifications safeguards: Delete held down dismisses one; the keyboard\'s repeats, now on the next row, dismiss nothing more',
            focusedFirst && repeats > 0 && gone('Delete 1') === `${Reason.DISMISSED}` &&
            ['Delete 2', 'Delete 3', 'Delete 4'].every(t => gone(t) === '') &&
            focus() === mainOf('Delete 2') && island().expanded,
            `focused=${focusedFirst} repeats=${repeats} rows=${rowTitles()} focus=${focus()}`);

        // ------------------------------------------------ Clear all from the keyboard
        const v = notificationsView();
        check('notifications safeguards: only the test\'s own notifications are listed (Clear all touches nothing else)',
            onlyOurs(), `${v._service.items.length} listed`);
        if (onlyOurs()) {
            for (let i = 0; i < 40 && focus() !== v._clearButton; i++)
                await pressKeys(Clutter.KEY_Tab);
            const before = destroyed.length;
            const onClear = focus() === v._clearButton;
            await pressKeys(Clutter.KEY_Return);
            const keepFocused = focus() === v._keepButton;
            await pressKeys(Clutter.KEY_Return);
            check('notifications safeguards: Enter twice on "Clear all": the first asks (the focus on "Keep them"), the second keeps them',
                onClear && keepFocused && destroyed.length === before && !v._confirmButton.visible &&
                v._clearButton.visible && focus() === v._clearButton && rowTitles().length === 3,
                `onClear=${onClear} keepFocused=${keepFocused} destroyed=${destroyed.length - before} focus=${focus()}`);
            await pressKeys(Clutter.KEY_Return);
            const asked = v._confirmButton.visible && v._confirmButton.label === 'Clear 3?' &&
                focus() === v._keepButton;
            await pressKeys(Clutter.KEY_Shift_L, Clutter.KEY_Tab);
            const onConfirm = focus() === v._confirmButton;
            await pressKeys(Clutter.KEY_Return);
            check('notifications safeguards: confirming from the keyboard takes a move to "Clear 3?" (Shift+Tab), then Enter',
                asked && onConfirm && ['Delete 2', 'Delete 3', 'Delete 4'].every(t => gone(t) === `${Reason.DISMISSED}`) &&
                rowTitles().length === 0 && island().expanded,
                `asked=${asked} onConfirm=${onConfirm} rows=${rowTitles()}`);
        }
        await removeOwn();

        // ------------------------------------------------ updated while "Clear N?" waits
        // As a chat app does: the same notification (replaces_id), new
        // text, unseen again; GNOME re-stamps it and it moves up.
        notify('Clear: one', {seconds: 20});
        notify('Clear: two', {seconds: 10});
        const [chatId, chat] = await sendFdo('Froonty test chat', 'Chat: 1 new message');
        if (onlyOurs() && chat) {
            await clickActor(v._clearButton);
            const askedFor = v._confirmButton.label;
            await sendFdo('Froonty test chat', 'Chat: 2 new messages', {replaces: chatId});
            await sleep(SETTLE_MS);
            const sameObject = fdo.get('Chat: 2 new messages') === chat;
            check('notifications safeguards: an app updating one in place while "Clear N?" waits takes it out of the question',
                askedFor === 'Clear 3?' && sameObject && v._confirmButton.visible &&
                v._confirmButton.label === 'Clear 2?' && rowTitles()[0] === 'Chat: 2 new messages',
                `asked=${askedFor} now=${v._confirmButton.label} same=${sameObject} rows=${rowTitles()}`);
            await screenshotTop(outDir, 'notifications-confirm-updated', 520);
            await clickActor(v._confirmButton);
            await sleep(SETTLE_MS);
            check('notifications safeguards: confirming dismisses the two shown at the first click; the updated one stays',
                gone('Clear: one') === `${Reason.DISMISSED}` && gone('Clear: two') === `${Reason.DISMISSED}` &&
                gone('Chat: 1 new message') === '' && rowTitles().join() === 'Chat: 2 new messages',
                `rows=${rowTitles()} destroyed=${JSON.stringify(destroyed.slice(-3))}`);
        } else {
            check('notifications safeguards: the chat notification arrived and only the test\'s are listed', false,
                `chat=${chat} ours=${onlyOurs()}`);
        }
        fdo.get('Chat: 2 new messages')?.destroy(Reason.SOURCE_CLOSED);
        await removeOwn();
        await collapse();

        // ------------------------------------------------ no default action
        // GNOME's daemon: a click on an app's notification sent without a
        // "default" action opens the app (Source.open()), which removes
        // every one of its notifications that is not resident. GNOME's own
        // list does the same; Froonty makes the same call.
        await expand();
        const [oneId] = await sendFdo('Froonty test siblings', 'Sibling one');
        const [twoId] = await sendFdo('Froonty test siblings', 'Sibling two');
        await sendFdo('Froonty test siblings', 'Sibling resident', {hints: {resident: new GLib.Variant('b', true)}});
        await sendFdo('Froonty test other app', 'Other app');
        const sameSource = fdo.get('Sibling one')?.source === fdo.get('Sibling two')?.source &&
            fdo.get('Sibling one')?.source !== fdo.get('Other app')?.source;
        const signalsBefore = signals.length;
        await clickActor(notificationRow('Sibling two')._part('title'));
        await sleep(animationWait());
        const closed = id => signals.slice(signalsBefore).some(([n, i, r]) => n === 'NotificationClosed' && i === id && r === 2);
        await waitFor(() => closed(oneId) && closed(twoId), 3000);
        // (GNOME's handler destroys it inside the 'activated' emission, and
        // a disposed object's later handlers do not run: the test's own
        // 'activated' log cannot see this click.)
        check('notifications safeguards: a click on one sent without a default action: GNOME removes all of that app\'s that are not resident (as its own list does); the resident one and another app\'s stay',
            sameSource &&
            gone('Sibling one') === `${Reason.DISMISSED}` && gone('Sibling two') === `${Reason.DISMISSED}` &&
            closed(oneId) && closed(twoId) && gone('Sibling resident') === '' && gone('Other app') === '' &&
            !signals.slice(signalsBefore).some(([n]) => n === 'ActionInvoked') && !island().expanded,
            `sameSource=${sameSource} destroyed=${JSON.stringify(destroyed.filter(([t]) => /Sibling|Other/.test(t)))} ` +
            `signals=${JSON.stringify(signals.slice(signalsBefore))}`);
        for (const title of ['Sibling resident', 'Other app'])
            fdo.get(title)?.destroy(Reason.SOURCE_CLOSED);
        await sleep(SETTLE_MS);

        // ------------------------------------------------ GNOME's dot while banners are held
        // The open island holds banners. One waiting for its banner is not
        // marked seen by Froonty (GNOME counts unseen minus queued, and
        // drops seen ones from its queue only once banners are released),
        // so a later unseen one still lights the dot.
        await expand();
        const queued = notify('Held: normal', {urgency: Urgency.NORMAL});
        const lowBefore = notify('Held: low before');
        await sleep(SETTLE_MS);
        const inQueue = tray._notificationQueue.includes(queued) && !tray.visible;
        await pressKeys(Clutter.KEY_x);
        check('notifications safeguards: a key marks the list seen, except one waiting for its banner (its row keeps its dot); no dot is due',
            inQueue && lowBefore.acknowledged && !queued.acknowledged &&
            notificationRow('Held: normal')?._part('new').visible && !gnomeUnreadDot(),
            `inQueue=${inQueue} low=${lowBefore.acknowledged} queued=${queued.acknowledged} gnome=${gnomeUnreadDot()}`);
        await clickActor(tabButton('clock'));
        await sleep(animationWait());
        const lowAfter = notify('Held: low after');
        await sleep(SETTLE_MS);
        check('notifications safeguards: then, with Clock on screen, a LOW one lights the tab\'s, 📅\'s and GNOME\'s dot',
            !lowAfter.acknowledged && notificationsEntry().dot.visible && island()._hub._header.unreadBadge.visible &&
            gnomeUnreadDot(), `tab=${notificationsEntry().dot.visible} gnome=${gnomeUnreadDot()} queue=${tray.queueCount}`);
        await collapse();
        check('notifications safeguards: once the island closes, the held banner shows, and GNOME\'s banner marks it seen',
            await waitFor(() => queued.acknowledged, 3000) && !lowAfter.acknowledged && pillUnreadDot(),
            `queued=${queued.acknowledged} low=${lowAfter.acknowledged} pill=${pillUnreadDot()}`);
        await removeOwn();
        await sleep(animationWait());
    } finally {
        Gio.DBus.session.signal_unsubscribe(subscription);
        s.set_int('hover-open-delay', 0);
        for (const n of fdo.values()) {
            if (tray.getSources().some(source => source.notifications.includes(n)))
                n.destroy(Reason.SOURCE_CLOSED);
        }
        for (const source of sources) {
            if (alive(source))
                source.destroy(Reason.SOURCE_CLOSED);
        }
        island().collapse();
        await sleep(animationWait());
        island()._hub.select('clock');
        s.reset('hub-last-tab');
        await sleep(SETTLE_MS);
    }
    check('notifications safeguards: the test\'s notifications are gone, Clock is shown again, no banner is up',
        sources.every(source => !alive(source)) && island()._hub.activeFeature?.id === 'clock' &&
        tray.queueCount === 0);
}

// ---------------------------------------------------------------- calendar tab (EDS)
//
// The Calendar tab over the real Evolution Data Server: the private one
// this session's own gnome-shell-calendar-server D-Bus-activates (private
// bus, XDG dirs under WORK). The test's own data (two test calendars and
// their events, a few events in the built-in "Personal") is written by
// the test through async ECal/EDataServer calls, never by Froonty, and
// only once edsIsolation() has shown that instance to be private.

const calendarEntry = () => island()?._hub._entries.get('calendar') ?? null;
const FT_MARKERS = ['Froonty test', 'froonty-test'];

// A callback-style async call as a promise (all arguments passed, so the
// Shell's promisified wrappers call the original).
function asyncCall(start, finish) {
    return new Promise((resolve, reject) => {
        start((source, result) => {
            try {
                resolve(finish(source, result));
            } catch (e) {
                reject(e);
            }
        });
    });
}
const lastOf = result => Array.isArray(result) ? result.at(-1) : result;

async function readTextFile(path) {
    try {
        const file = Gio.File.new_for_path(path);
        const result = await asyncCall(done => file.load_contents_async(null, done),
            (f, r) => f.load_contents_finish(r));
        return new TextDecoder().decode(result[1]);
    } catch {
        return null;
    }
}

// Every file under `root`: path → modification time.
async function fileTree(root) {
    const out = new Map();
    const walk = async dir => {
        let enumerator;
        try {
            enumerator = await asyncCall(done => dir.enumerate_children_async(
                'standard::name,standard::type,time::modified,time::modified-usec',
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, GLib.PRIORITY_DEFAULT, null, done),
            (d, r) => d.enumerate_children_finish(r));
        } catch {
            return;
        }
        for (;;) {
            const infos = await asyncCall(done => enumerator.next_files_async(64, GLib.PRIORITY_DEFAULT, null, done),
                (e, r) => e.next_files_finish(r));
            if (infos.length === 0)
                break;
            for (const info of infos) {
                const child = dir.get_child(info.get_name());
                if (info.get_file_type() === Gio.FileType.DIRECTORY)
                    await walk(child);
                else
                    out.set(child.get_path(), `${info.get_attribute_uint64('time::modified')}.${info.get_attribute_uint32('time::modified-usec')}`);
            }
        }
        await asyncCall(done => enumerator.close_async(GLib.PRIORITY_DEFAULT, null, done),
            (e, r) => e.close_finish(r)).catch(() => {});
    };
    await walk(Gio.File.new_for_path(root));
    return out;
}

// Whether the real home's EDS data mentions the test (read-only).
async function realHomeMentionsTest() {
    const home = GLib.get_home_dir();
    const files = [...(await fileTree(`${home}/.config/evolution/sources`)).keys(),
        `${home}/.local/share/evolution/calendar/system/calendar.ics`];
    for (const path of files) {
        if (FT_MARKERS.some(marker => path.includes(marker)))
            return path;
        const text = await readTextFile(path);
        if (text && FT_MARKERS.some(marker => text.includes(marker)))
            return path;
    }
    return null;
}

async function busOwnerEnviron(name) {
    const bus = Gio.DBus.session;
    await asyncCall(done => bus.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
        'StartServiceByName', new GLib.Variant('(su)', [name, 0]), null, Gio.DBusCallFlags.NONE, 10000, null, done),
    (c, r) => c.call_finish(r));
    const reply = await asyncCall(done => bus.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
        'GetConnectionUnixProcessID', new GLib.Variant('(s)', [name]), new GLib.VariantType('(u)'),
        Gio.DBusCallFlags.NONE, 10000, null, done), (c, r) => c.call_finish(r));
    const [pid] = reply.deepUnpack();
    const text = await readTextFile(`/proc/${pid}/environ`) ?? '';
    return new Map(text.split('\0').filter(Boolean).map(line => {
        const i = line.indexOf('=');
        return [line.slice(0, i), line.slice(i + 1)];
    }));
}

// The EDS the Shell under test talks to is the private test instance:
// private XDG dirs and bus for this process and for the D-Bus owners of
// EDS's registry and calendar factory. Otherwise nothing is written.
async function edsIsolation(work) {
    const problems = [];
    if (GLib.get_user_config_dir() !== `${work}/config`)
        problems.push(`config dir ${GLib.get_user_config_dir()}`);
    if (GLib.get_user_data_dir() !== `${work}/data`)
        problems.push(`data dir ${GLib.get_user_data_dir()}`);
    if (GLib.getenv('GSETTINGS_BACKEND') !== 'keyfile')
        problems.push('GSettings backend');
    const bus = GLib.getenv('DBUS_SESSION_BUS_ADDRESS') ?? '';
    if (!bus || bus.includes('/run/user/'))
        problems.push(`session bus ${bus}`);
    for (const name of ['org.gnome.evolution.dataserver.Sources5', 'org.gnome.evolution.dataserver.Calendar8']) {
        try {
            const environ = await busOwnerEnviron(name);
            if (environ.get('XDG_CONFIG_HOME') !== `${work}/config` || environ.get('XDG_DATA_HOME') !== `${work}/data`)
                problems.push(`${name}: ${environ.get('XDG_CONFIG_HOME')} ${environ.get('XDG_DATA_HOME')}`);
        } catch (e) {
            problems.push(`${name}: ${e.message}`);
        }
    }
    return problems;
}

const icsTime = time => time.to_utc().format('%Y%m%dT%H%M%SZ');
const icsDate = time => time.format('%Y%m%d');
const vevent = lines => `BEGIN:VEVENT\r\n${lines.join('\r\n')}\r\nEND:VEVENT\r\n`;

// Windows-style zone, as Exchange sends it: unknown to libical, known to
// the calendar once added (EDS gives it to Froonty on request).
const PACIFIC_VTIMEZONE = 'BEGIN:VTIMEZONE\r\nTZID:Pacific Standard Time\r\nBEGIN:STANDARD\r\n' +
    'DTSTART:16010101T020000\r\nTZOFFSETFROM:-0700\r\nTZOFFSETTO:-0800\r\n' +
    'RRULE:FREQ=YEARLY;BYDAY=1SU;BYMONTH=11\r\nEND:STANDARD\r\nBEGIN:DAYLIGHT\r\n' +
    'DTSTART:16010101T020000\r\nTZOFFSETFROM:-0800\r\nTZOFFSETTO:-0700\r\n' +
    'RRULE:FREQ=YEARLY;BYDAY=2SU;BYMONTH=3\r\nEND:DAYLIGHT\r\nEND:VTIMEZONE\r\n';

/** The test's own EDS writer (never Froonty's code). */
class TestEds {
    constructor(libs) {
        this.libs = libs;
        this.registry = null;
        this.sources = [];
        this.created = [];
        this.clients = new Map();
    }

    async start() {
        const {EDataServer} = this.libs;
        this.registry = await asyncCall(done => EDataServer.SourceRegistry.new(null, done),
            (_s, r) => EDataServer.SourceRegistry.new_finish(r));
    }

    async addCalendar(name, color) {
        const {EDataServer} = this.libs;
        const source = EDataServer.Source.new(null, null);
        source.set_parent('local-stub');
        source.set_display_name(name);
        const extension = source.get_extension('Calendar');
        extension.set_backend_name('local');
        extension.set_color(color);
        await asyncCall(done => this.registry.commit_source(source, null, done),
            (registry, r) => registry.commit_source_finish(r));
        const uid = source.get_uid();
        this.sources.push(uid);
        return uid;
    }

    async client(uid) {
        if (this.clients.has(uid))
            return this.clients.get(uid);
        const {ECal} = this.libs;
        const source = uid === 'system-calendar'
            ? this.registry.ref_builtin_calendar() : this.registry.ref_source(uid);
        const client = await asyncCall(done => ECal.Client.connect(source, ECal.ClientSourceType.EVENTS, 30, null, done),
            (_s, r) => ECal.Client.connect_finish(r));
        this.clients.set(uid, client);
        return client;
    }

    async addZone(uid, zone) {
        const client = await this.client(uid);
        await asyncCall(done => client.add_timezone(zone, null, done), (c, r) => c.add_timezone_finish(r));
    }

    async create(uid, ics) {
        const {ECal, ICalGLib} = this.libs;
        const client = await this.client(uid);
        const created = lastOf(await asyncCall(done => client.create_object(ICalGLib.Component.new_from_string(ics),
            ECal.OperationFlags.NONE, null, done), (c, r) => c.create_object_finish(r)));
        this.created.push([uid, created]);
        return created;
    }

    async modify(uid, ics, mod) {
        const {ECal, ICalGLib} = this.libs;
        const client = await this.client(uid);
        await asyncCall(done => client.modify_object(ICalGLib.Component.new_from_string(ics),
            mod ?? ECal.ObjModType.ALL, ECal.OperationFlags.NONE, null, done), (c, r) => c.modify_object_finish(r));
    }

    async removeEvent(uid, eventUid, rid = null) {
        const {ECal} = this.libs;
        const client = await this.client(uid);
        await asyncCall(done => client.remove_object(eventUid, rid, rid ? ECal.ObjModType.THIS : ECal.ObjModType.ALL,
            ECal.OperationFlags.NONE, null, done), (c, r) => c.remove_object_finish(r));
    }

    async setSelected(uid, selected) {
        const source = this.registry.ref_source(uid);
        source.get_extension('Calendar').set_selected(selected);
        await asyncCall(done => source.write(null, done), (s, r) => s.write_finish(r));
    }

    // Removes every event and calendar the test added.
    async cleanUp() {
        for (const [uid, eventUid] of this.created) {
            try {
                await this.removeEvent(uid, eventUid);
            } catch {
                // Already removed by the test.
            }
        }
        for (const uid of this.sources) {
            const source = this.registry?.ref_source(uid);
            if (source)
                await asyncCall(done => source.remove(null, done), (s, r) => s.remove_finish(r)).catch(() => {});
        }
        this.clients.clear();
    }
}

// Froonty's occurrences of an event, by its title: [{start, end, allDay}].
function shownOccurrences(service, title) {
    return service._store.occurrences(service.calendars.map(c => c.uid))
        .filter(({item}) => item.title === title)
        .map(({item, occurrence, calendarUid}) => ({...occurrence, calendarUid, title: item.title,
            cancelled: item.cancelled}));
}

const calendarCards = () => calendarEntry()?.view?.agenda.cards ?? [];
const cardOf = title => calendarCards().find(card => card.entry.item.title === title) ?? null;
const viewsComplete = service => [...service._views.values()].every(entry => entry.complete);
// Views over the month shown, delivered, and no month change waiting for
// the quiet period (service.js RANGE_QUIET_MS).
const calendarSettled = (service, timeoutMs = 5000) => waitFor(() => service.settled, timeoutMs);

// Scrolls the agenda so a card is in sight (before a pointer click).
async function revealCard(card) {
    const adjustment = calendarEntry().view.agenda.scrollView.vadjustment;
    const y = card.actor.get_allocation_box().y1;
    adjustment.value = Math.max(0, Math.min(y, adjustment.upper - adjustment.page_size));
    await sleep(SETTLE_MS);
}

// The hint, without EDS: a view over a service that says the bindings
// are missing.
async function testCalendarHint() {
    const {CalendarView} = await import(`file://${extension().path}/features/calendar/view.js`);
    const fake = {state: 'missing', calendars: [], connect: () => 1, disconnect: () => {}};
    const view = new CalendarView({clock: island()._clock}, fake);
    check('calendar: without gir1.2-ecal-2.0 the tab says what to install, with Online Accounts',
        view._hint.visible && !view._body.visible &&
        view._hintTitle.text.includes('Install gir1.2-ecal-2.0') &&
        view._hintButton.visible && view._hintButton.label === 'Online Accounts',
        view._hintTitle.text);
    view.destroy();
}

async function testCalendar(outDir) {
    const work = outDir;
    const {edsInstalled} = await import(`file://${extension().path}/features/calendar/eds.js`);
    const {detectProvider} = await import(`file://${extension().path}/features/calendar/providers.js`);
    await testCalendarHint();
    if (!await edsInstalled()) {
        check('calendar: note: ECal not installed; only the hint was tested', true, 'note: ECal not installed');
        return;
    }

    const problems = await edsIsolation(work);
    const homeBefore = await realHomeMentionsTest();
    check('calendar: EDS is the private test instance', problems.length === 0 && homeBefore === null,
        [...problems, homeBefore ? `real home already mentions the test: ${homeBefore}` : ''].join('; '));
    if (problems.length || homeBefore)
        return;

    const libs = {
        ECal: (await import('gi://ECal?version=2.0')).default,
        EDataServer: (await import('gi://EDataServer?version=1.2')).default,
        ICalGLib: (await import('gi://ICalGLib?version=3.0')).default,
    };
    const eds = new TestEds(libs);
    const s = settings();
    const desktop = new Gio.Settings({schema_id: 'org.gnome.desktop.calendar'});
    try {
        await eds.start();
        await calendarSteps(outDir, work, eds, libs, detectProvider, desktop);
        await testCalendarLoad(eds, libs);
    } finally {
        desktop.reset('show-weekdate');
        s.reset('calendar-hidden-sources');
        s.reset('calendar-granularity');
        await eds.cleanUp();
        if (island()?.expanded) {
            island().collapse();
            await sleep(animationWait());
        }
    }
    check('calendar: the real home\'s calendars never saw the test', await realHomeMentionsTest() === null);
    await testCalendarLifecycle();
}

async function openCalendarTab() {
    if (!island().expanded) {
        island().expand();
        await sleep(animationWait());
    }
    if (island()._hub.activeFeature?.id !== 'calendar') {
        await clickActor(tabButton('calendar'));
        await sleep(animationWait());
    }
}

async function calendarSteps(outDir, work, eds, libs, detectProvider, desktop) {
    const s = settings();
    const {ECal, ICalGLib} = libs;
    check('calendar: on by default (the first start found the bindings), right after Clock',
        s.get_boolean('calendar-enabled') && s.get_boolean('calendar-eds-checked') &&
        island()._hub._tabColumn.get_children().indexOf(tabButton('calendar')) === 1);
    s.set_string('calendar-granularity', 'month');

    // Over the built-in calendars only: what EDS keeps on disk, to compare
    // after Froonty has browsed (Froonty writes nothing).
    await openCalendarTab();
    let service = calendarEntry()?.service;
    let view = calendarEntry()?.view;
    await waitFor(() => service?.state === 'ready' && !service.loading, 8000);
    const [w, h] = pill().get_transformed_size();
    check('calendar: the tab opens at 620 × 380 and loads EDS',
        service?.state === 'ready' && w === 620 * scale() && h === 380 * scale(),
        `${w}x${h} state=${service?.state} ${service?.errorMessage ?? ''}`);
    check('calendar: GNOME\'s built-in calendars are listed',
        service.calendars.some(c => c.uid === 'system-calendar') &&
        service.calendars.some(c => c.uid === 'birthdays'),
        service.calendars.map(c => `${c.uid}:${c.name}`).join(', '));
    await sleep(500);
    const treeRoots = [`${work}/config/evolution/sources`, `${work}/data/evolution/calendar`];
    const treeBefore = new Map();
    for (const root of treeRoots)
        for (const [path, mtime] of await fileTree(root))
            treeBefore.set(path, mtime);

    // ------------------------------------------------ data
    const tz = service.timeZone;
    const hostTzid = tz.get_identifier();
    const now = GLib.DateTime.new_now(tz);
    const today = GLib.DateTime.new(tz, now.get_year(), now.get_month(), now.get_day_of_month(), 0, 0, 0);
    const dayAt = (days, hour, minute = 0) => {
        const d = today.add_days(days);
        return GLib.DateTime.new(tz, d.get_year(), d.get_month(), d.get_day_of_month(), hour, minute, 0);
    };
    const stamp = `${Date.now()}`;
    const uidOf = name => `froonty-test-${stamp}-${name}`;
    const local = (time, hour, minute = 0) => `${icsDate(time)}T${String(hour).padStart(2, '0')}${String(minute).padStart(2, '0')}00`;

    const testUid = await eds.addCalendar('Froonty test calendar', '#e01b24');
    await waitFor(() => service.calendars.some(c => c.uid === testUid));
    const hostZone = ICalGLib.Timezone.get_builtin_timezone(hostTzid);
    await eds.addZone(testUid, hostZone);
    const pacific = ICalGLib.Timezone.new();
    pacific.set_component(ICalGLib.Component.new_from_string(PACIFIC_VTIMEZONE));
    await eds.addZone(testUid, pacific);

    const nowStart = now.add_minutes(-10);
    await eds.create('system-calendar', vevent([`UID:${uidOf('allday')}`, 'SUMMARY:FT all-day',
        `DTSTART;VALUE=DATE:${icsDate(today)}`, `DTEND;VALUE=DATE:${icsDate(today.add_days(1))}`]));
    await eds.create(testUid, vevent([`UID:${uidOf('now')}`, 'SUMMARY:FT now',
        `DTSTART:${icsTime(nowStart)}`, `DTEND:${icsTime(now.add_minutes(20))}`]));
    await eds.create(testUid, vevent([`UID:${uidOf('next')}`, 'SUMMARY:FT next', 'LOCATION:Room <b>1</b>',
        `DTSTART:${icsTime(now.add_minutes(30))}`, `DTEND:${icsTime(now.add_minutes(60))}`]));
    const standup = uidOf('standup');
    await eds.create(testUid, vevent([`UID:${standup}`, 'SUMMARY:FT standup',
        `DTSTART;TZID=${hostTzid}:${local(today, 9)}`, `DTEND;TZID=${hostTzid}:${local(today, 9, 15)}`,
        'RRULE:FREQ=DAILY;COUNT=5', `EXDATE;TZID=${hostTzid}:${local(today.add_days(2), 9)}`]));
    await eds.modify(testUid, vevent([`UID:${standup}`, 'SUMMARY:FT standup (moved)',
        `RECURRENCE-ID;TZID=${hostTzid}:${local(today.add_days(1), 9)}`,
        `DTSTART;TZID=${hostTzid}:${local(today.add_days(1), 11, 30)}`,
        `DTEND;TZID=${hostTzid}:${local(today.add_days(1), 11, 45)}`]), ECal.ObjModType.THIS);
    await eds.create(testUid, vevent([`UID:${uidOf('winzone')}`, 'SUMMARY:FT winzone', 'STATUS:CANCELLED',
        `DTSTART;TZID=Pacific Standard Time:${local(today, 14)}`,
        `DTEND;TZID=Pacific Standard Time:${local(today, 15)}`]));

    // ------------------------------------------------ shown
    const titles = ['FT all-day', 'FT now', 'FT next', 'FT standup', 'FT standup (moved)', 'FT winzone'];
    const losAngeles = GLib.TimeZone.new_identifier('America/Los_Angeles');
    const winzoneStart = GLib.DateTime.new(losAngeles, today.get_year(), today.get_month(),
        today.get_day_of_month(), 14, 0, 0).to_unix();
    const allShown = await waitFor(() => titles.every(title => shownOccurrences(service, title).length > 0) &&
        shownOccurrences(service, 'FT winzone')[0]?.start === winzoneStart, 5000);
    check('calendar: every test event shows, live, without reopening the tab', allShown,
        titles.map(t => `${t}=${shownOccurrences(service, t).length}`).join(' '));
    await sleep(SETTLE_MS);

    const colorOf = title => cardOf(title)?.entry.calendar?.color;
    check('calendar: cards carry their calendar\'s colour',
        colorOf('FT now') === '#e01b24' && colorOf('FT all-day') === '#62a0ea' &&
        cardOf('FT now')?.bar.style.includes('#e01b24'),
        `${colorOf('FT now')} ${colorOf('FT all-day')}`);
    check('calendar: an all-day event reads "All day"',
        cardOf('FT all-day')?.meta.text.startsWith('All day'), cardOf('FT all-day')?.meta.text);

    const grid = service._grid();
    const expectedStandups = [0, 1, 3, 4].map(n => n === 1 ? dayAt(1, 11, 30) : dayAt(n, 9))
        .map(t => t.to_unix()).filter(t => t >= grid.start && t < grid.end);
    const standups = [...shownOccurrences(service, 'FT standup'), ...shownOccurrences(service, 'FT standup (moved)')]
        .map(o => o.start).sort((a, b) => a - b);
    check('calendar: a repeating event: EDS\'s expansion, the excluded day gone, the moved one moved',
        JSON.stringify(standups) === JSON.stringify(expectedStandups) &&
        shownOccurrences(service, 'FT standup (moved)').length === (expectedStandups.includes(dayAt(1, 11, 30).to_unix()) ? 1 : 0),
        `${standups.map(t => GLib.DateTime.new_from_unix_utc(t).to_timezone(tz).format('%d %H:%M'))} ` +
        `expected ${expectedStandups.map(t => GLib.DateTime.new_from_unix_utc(t).to_timezone(tz).format('%d %H:%M'))}`);

    const agenda = service.agenda();
    const timedAfterNow = agenda.days.flatMap(d => d.entries)
        .filter(e => !e.occurrence.allDay && !e.item.cancelled && e.start > now.to_unix())
        .sort((a, b) => a.start - b.start);
    const expectedNext = timedAfterNow[0]?.item.title;
    const nextCard = calendarCards().find(card => card.entry.state === 'next');
    check('calendar: "Now" on the event going on, "Next" on the next one',
        cardOf('FT now')?.state.text === 'Now' && cardOf('FT now')?.state.visible &&
        nextCard?.entry.item.title === expectedNext && nextCard?.state.text === 'Next' &&
        (expectedNext !== 'FT next' || cardOf('FT next')?.state.text === 'Next'),
        `now=${cardOf('FT now')?.state.text} next=${nextCard?.entry.item.title} expected ${expectedNext}`);
    const winzone = shownOccurrences(service, 'FT winzone')[0];
    check('calendar: an Exchange-style zone is fetched from the calendar; cancelled is struck through',
        winzone?.start === winzoneStart && winzone.cancelled &&
        cardOf('FT winzone')?.actor.has_style_class_name('froonty-calendar-card-cancelled'),
        `${winzone?.start} vs ${winzoneStart}`);
    check('calendar: event text is shown as text, never as markup',
        cardOf('FT next')?.meta.text.includes('Room <b>1</b>') && !cardOf('FT next')?.meta.clutter_text.use_markup,
        cardOf('FT next')?.meta.text);

    const todayDate = {y: today.get_year(), m: today.get_month(), d: today.get_day_of_month()};
    const todayCell = view.grid.cellOf(todayDate);
    const dotStyles = todayCell?._dots.get_children().filter(dot => dot.visible).map(dot => dot.style).join(' ') ?? '';
    check('calendar: today\'s cell is today, with both calendars\' dots',
        todayCell?.has_style_class_name('froonty-calendar-day-today') &&
        dotStyles.includes('#62a0ea') && dotStyles.includes('#e01b24'), dotStyles);
    check('calendar: no week numbers unless GNOME shows them',
        !desktop.get_boolean('show-weekdate') && !view.grid._weeks[0].visible);
    desktop.set_boolean('show-weekdate', true);
    await sleep(SETTLE_MS);
    check('calendar: GNOME\'s show-weekdate adds ISO week numbers',
        view.grid._weeks[0].visible && /^\d+$/.test(view.grid._weeks[0].text), view.grid._weeks[0].text);

    const hub = island()._hub;
    const content = boxOf(hub._content);
    const left = boxOf(view.grid.get_parent());
    const right = boxOf(view.agenda);
    const inside = b => b.x1 >= content.x1 - 1 && b.x2 <= content.x2 + 1 && b.y1 >= content.y1 - 1 && b.y2 <= content.y2 + 1;
    check('calendar: grid, divider and agenda sit inside the content, clear of the tabs and ⚙️',
        inside(left) && inside(right) && left.x2 <= right.x1 &&
        boxOf(hub._tabColumn).x2 <= left.x1 && boxOf(hub.settingsButton).y2 <= right.y1 + 1,
        `content=${JSON.stringify(content)} left=${JSON.stringify(left)} right=${JSON.stringify(right)}`);
    await screenshotTop(outDir, 'calendar', 420);

    // ------------------------------------------------ live
    const live = uidOf('live');
    await eds.create(testUid, vevent([`UID:${live}`, 'SUMMARY:FT live',
        `DTSTART:${icsTime(dayAt(0, 18))}`, `DTEND:${icsTime(dayAt(0, 19))}`]));
    check('calendar: an event added elsewhere shows within 3 s',
        await waitFor(() => cardOf('FT live') !== null, 3000));
    await eds.modify(testUid, vevent([`UID:${live}`, 'SUMMARY:FT live renamed',
        `DTSTART:${icsTime(dayAt(0, 18))}`, `DTEND:${icsTime(dayAt(0, 19))}`]));
    check('calendar: renamed elsewhere, the card follows',
        await waitFor(() => cardOf('FT live renamed') !== null && cardOf('FT live') === null, 3000));
    await eds.removeEvent(testUid, live);
    check('calendar: removed elsewhere, the card goes',
        await waitFor(() => cardOf('FT live renamed') === null, 3000));

    const moved = service._store.items(testUid).find(item => item.title === 'FT standup (moved)');
    const movedRid = moved?.key.split('\n')[1] ?? '';
    if (movedRid) {
        await eds.removeEvent(testUid, standup, movedRid);
        const day1 = [dayAt(1, 9).to_unix(), dayAt(1, 11, 30).to_unix()];
        check('calendar: removing the moved occurrence leaves none that day (removal keys match)',
            await waitFor(() => shownOccurrences(service, 'FT standup (moved)').length === 0 &&
                !shownOccurrences(service, 'FT standup').some(o => day1.includes(o.start)), 3000),
            `rid=${movedRid}`);
    } else {
        check('calendar: the moved occurrence has a recurrence id', false);
    }

    const secondUid = await eds.addCalendar('Froonty test calendar 2', 'rgb(46,194,126)');
    await eds.create(secondUid, vevent([`UID:${uidOf('second')}`, 'SUMMARY:FT second',
        `DTSTART:${icsTime(dayAt(0, 20))}`, `DTEND:${icsTime(dayAt(0, 21))}`]));
    check('calendar: a calendar added elsewhere shows with its events, coloured from rgb()',
        await waitFor(() => cardOf('FT second')?.entry.calendar.color === '#2ec27e', 5000),
        `${cardOf('FT second')?.entry.calendar.color}`);
    const views = service.viewCount;
    settings().set_strv('calendar-hidden-sources', [secondUid]);
    await sleep(SETTLE_MS);
    check('calendar: hidden in Froonty\'s settings: gone, its view stopped',
        cardOf('FT second') === null && service.viewCount === views - 1, `${views} -> ${service.viewCount}`);
    settings().reset('calendar-hidden-sources');
    check('calendar: shown again: back', await waitFor(() => cardOf('FT second') !== null, 3000));
    await eds.setSelected(secondUid, false);
    check('calendar: unticked in GNOME\'s calendars: gone (GNOME\'s rule)',
        await waitFor(() => cardOf('FT second') === null && !service.calendars.some(c => c.uid === secondUid), 3000));
    await eds.setSelected(secondUid, true);
    check('calendar: ticked again: back', await waitFor(() => cardOf('FT second') !== null, 3000));

    // ------------------------------------------------ navigation
    const label = () => view.grid.monthButton.label;
    const thisMonth = label();
    await clickActor(view.grid.nextButton);
    await waitFor(() => viewsComplete(service));
    await sleep(SETTLE_MS);
    const nextGrid = service._grid();
    const standupsNext = shownOccurrences(service, 'FT standup').filter(o => o.start >= nextGrid.start && o.start < nextGrid.end);
    const expectedNextMonth = [0, 3, 4].map(n => dayAt(n, 9).to_unix()).filter(t => t >= nextGrid.start && t < nextGrid.end);
    check('calendar: › shows the next month, with new views over its weeks',
        label() !== thisMonth && service.shownMonth.m === (today.get_month() % 12) + 1 &&
        service.viewCount === service.calendars.length &&
        JSON.stringify(standupsNext.map(o => o.start).sort()) === JSON.stringify(expectedNextMonth.sort()),
        `${thisMonth} -> ${label()} views=${service.viewCount}/${service.calendars.length}`);
    await clickActor(view.grid.monthButton);
    await sleep(SETTLE_MS);
    check('calendar: the month\'s name goes back to today',
        label() === thisMonth && JSON.stringify(service.selected) === JSON.stringify(todayDate));
    await calendarSettled(service);

    const switchTo = async granularity => {
        await clickActor(view._switchButtons.get(granularity));
        await sleep(SETTLE_MS);
    };
    await switchTo('day');
    const dayTitles = calendarCards().map(c => c.entry.item.title);
    check('calendar: Day lists only the selected day',
        service.granularity === 'day' && s.get_string('calendar-granularity') === 'day' &&
        dayTitles.includes('FT all-day') && !dayTitles.includes('FT standup (moved)') &&
        calendarCards().every(c => JSON.stringify(c.date) === JSON.stringify(todayDate)),
        dayTitles.join(', '));
    await switchTo('week');
    const shaded = view.grid.cells.filter(c => c.has_style_class_name('froonty-calendar-day-in-span'));
    const row = Math.floor(view.grid.cells.indexOf(todayCell) / 7);
    check('calendar: Week shades the selected row',
        shaded.length === 7 && shaded.every(c => Math.floor(view.grid.cells.indexOf(c) / 7) === row));
    await switchTo('month');
    const inMonth = view.grid.cells.filter(c => !c.has_style_class_name('froonty-calendar-day-other-month'));
    check('calendar: Month shades every day of the month',
        inMonth.every(c => c.has_style_class_name('froonty-calendar-day-in-span')) &&
        view.grid.cells.filter(c => c.has_style_class_name('froonty-calendar-day-in-span')).length === inMonth.length);
    const other = view.grid.cells.find(c => c.has_style_class_name('froonty-calendar-day-other-month'));
    const otherDate = other?.date;
    await clickActor(other);
    await sleep(SETTLE_MS);
    check('calendar: a day of another month shows that month',
        otherDate && service.shownMonth.m === otherDate.m && service.selected.d === otherDate.d);
    await clickActor(view.grid.monthButton);
    await sleep(SETTLE_MS);
    await calendarSettled(service);

    view.grid.previousButton.grab_key_focus();
    await pressKeys(Clutter.KEY_Tab);
    const afterOne = global.stage.key_focus;
    await pressKeys(Clutter.KEY_Tab);
    const afterTwo = global.stage.key_focus;
    await pressKeys(Clutter.KEY_Tab);
    const firstCell = global.stage.key_focus;
    const firstDate = firstCell?.date ? {...firstCell.date} : null;
    await pressKeys(Clutter.KEY_Return);
    await sleep(SETTLE_MS);
    check('calendar: Tab goes ‹, month, ›, then the days; Enter picks a day',
        afterOne === view.grid.monthButton && afterTwo === view.grid.nextButton &&
        view.grid.cells.includes(firstCell) &&
        JSON.stringify(service.selected) === JSON.stringify(firstDate),
        `${afterOne} ${afterTwo} ${firstCell} ${JSON.stringify(firstDate)} selected ${JSON.stringify(service.selected)}`);
    await clickActor(view.grid.monthButton);
    await sleep(SETTLE_MS);
    await calendarSettled(service);

    const treeAfter = new Map();
    for (const root of treeRoots)
        for (const [path, mtime] of await fileTree(root))
            treeAfter.set(path, mtime);
    // The test's own calendars and events are expected; nothing else may change.
    const changedFiles = [...new Set([...treeBefore.keys(), ...treeAfter.keys()])]
        .filter(path => treeBefore.get(path) !== treeAfter.get(path))
        .filter(path => !path.includes(testUid) && !path.includes(secondUid) && !path.includes('/calendar/system/'));
    check('calendar: Froonty wrote nothing to EDS (browsing, switching, hiding)',
        changedFiles.length === 0, changedFiles.join(', '));

    // ------------------------------------------------ links
    const google = detectProvider({collectionBackend: 'google'});
    const realDetect = service._detectProvider;
    const opened = [];
    service._detectProvider = info => info.uid === testUid ? google : realDetect(info);
    service.openUri = url => opened.push(url);
    service.today();
    await sleep(SETTLE_MS);
    const nextEntryCard = cardOf('FT next');
    const nextDay = nextEntryCard?.date;
    const dayUrl = d => `https://calendar.google.com/calendar/r/day/${d.y}/${d.m}/${d.d}`;
    if (nextEntryCard) {
        await revealCard(nextEntryCard);
        await clickActor(nextEntryCard.actor);
    }
    await sleep(animationWait());
    check('calendar: a card opens its day in the web calendar, after closing the island',
        nextEntryCard?.clickable && !island().expanded && opened.length === 1 && opened[0] === dayUrl(nextDay),
        `${opened} expanded=${island().expanded}`);
    await openCalendarTab();
    await sleep(SETTLE_MS);
    await screenshotTop(outDir, 'calendar-links', 420);
    const pillButton = view.providerButtons?.[0];
    if (pillButton)
        await clickActor(pillButton);
    await sleep(animationWait());
    check('calendar: the "Google" button opens the selected day',
        pillButton && opened.length === 2 && opened[1] === dayUrl(todayDate) && !island().expanded,
        `${opened}`);
    service._detectProvider = realDetect;
    delete service.openUri;

    // ------------------------------------------------ collapsed
    // The views stay, paused: no EDS call on collapse or reopen
    // (ClientView.start/stop are synchronous D-Bus calls).
    await openCalendarTab();
    await calendarSettled(service);
    const edsViews = () => [...service._views.values()].map(entry => entry.view).filter(Boolean);
    const before = edsViews();
    const running = before.filter(edsView => edsView.clientView.is_running()).length;
    island().collapse();
    await sleep(animationWait());
    const scheduler = service._adapter.scheduler;
    check('calendar: collapsed, the EDS views stay, running and paused',
        before.length === service.calendars.length && running === before.length &&
        edsViews().length === before.length && edsViews().every((edsView, i) => edsView === before[i]) &&
        before.every(edsView => !edsView.released && edsView.clientView.is_running()) && scheduler.paused,
        `views=${edsViews().length}/${before.length} running before=${running} paused=${scheduler.paused}`);
    let changes = 0;
    const changedId = service.connect('changed', () => changes++);
    await eds.create(testUid, vevent([`UID:${uidOf('hidden')}`, 'SUMMARY:FT while hidden',
        `DTSTART:${icsTime(dayAt(0, 21))}`, `DTEND:${icsTime(dayAt(0, 22))}`]));
    await sleep(1000);
    service.disconnect(changedId);
    const queued = before.some(edsView => edsView._pendingAdds.size > 0);
    check('calendar: an event added while collapsed wakes nothing and waits, unexpanded',
        changes === 0 && queued && shownOccurrences(service, 'FT while hidden').length === 0 && !scheduler.pending,
        `${changes} changes, queued=${queued}`);
    await openCalendarTab();
    check('calendar: reopened, it is there, from the same views',
        await waitFor(() => cardOf('FT while hidden') !== null, 3000) &&
        edsViews().every((edsView, i) => edsView === before[i]) && !scheduler.paused);
    const oldClientViews = before.map(edsView => edsView.clientView);
    await clickActor(view.grid.nextButton);
    await calendarSettled(service);
    // is_running() is the ClientView's own flag, which stop() clears.
    check('calendar: another month: new views; the old ones let go without a stop() call',
        before.every(edsView => edsView.released && edsView.clientView === null) &&
        oldClientViews.every(clientView => clientView.is_running()) &&
        edsViews().every(edsView => !before.includes(edsView)) && edsViews().length === before.length,
        `${edsViews().length} views`);
    await clickActor(view.grid.monthButton);
    await calendarSettled(service);

    // ------------------------------------------------ hint in the hub
    const feature = calendarEntry().feature;
    const create = feature.createService;
    feature.createService = ctx => {
        const fresh = create(ctx);
        fresh._loadEds = async () => ({status: 'missing'});
        return fresh;
    };
    try {
        s.set_boolean('calendar-enabled', false);
        await sleep(SETTLE_MS);
        s.set_boolean('calendar-enabled', true);
        await sleep(SETTLE_MS);
        await openCalendarTab();
        await sleep(SETTLE_MS);
        view = calendarEntry()?.view;
        check('calendar: in the hub, missing bindings show the hint',
            calendarEntry()?.service.state === 'missing' && view?._hint.visible,
            calendarEntry()?.service.state);
        await screenshotTop(outDir, 'calendar-hint', 420);
    } finally {
        feature.createService = create;
    }
    s.set_boolean('calendar-enabled', false);
    await sleep(SETTLE_MS);
    s.reset('calendar-enabled');
    await sleep(SETTLE_MS);
    await openCalendarTab();
    service = calendarEntry()?.service;
    check('calendar: with them, the events are back',
        await waitFor(() => cardOf('FT now') !== null || cardOf('FT next') !== null, 5000));
    island().collapse();
    await sleep(animationWait());
}

// ---------------------------------------------------------------- calendar load
//
// A large calendar over the real EDS (calendar-1, calendar-2): 50 daily or
// weekday series begun between 2016 and 2023, a minutely series, an
// hourly one since 2024, and 120 events in a Windows-named zone that the
// calendar knows and libical does not. Every expansion turn stays under a
// frame, and every event shows where it should. Written by the test
// (TestEds), removed by testCalendar's clean-up.
async function testCalendarLoad(eds, libs) {
    const {ICalGLib} = libs;
    if (island()?.expanded) {
        island().collapse();
        await sleep(animationWait());
    }
    const service = calendarEntry()?.service;
    if (service?.state !== 'ready') {
        check('calendar load: the service is ready', false, service?.state);
        return;
    }
    const tz = service.timeZone;
    const hostTzid = tz.get_identifier();
    const grid = service._grid();
    const days = Math.round((grid.end - grid.start) / 86400);
    const now = GLib.DateTime.new_now(tz);
    const stamp = `${Date.now()}`;
    const uid = await eds.addCalendar('Froonty test calendar 3', '#9141ac');
    const pacific = ICalGLib.Timezone.new();
    pacific.set_component(ICalGLib.Component.new_from_string(PACIFIC_VTIMEZONE));
    await eds.addZone(uid, pacific);

    const pad = n => String(n).padStart(2, '0');
    for (let i = 0; i < 50; i++) {
        const start = `${2016 + (i % 8)}0104T${pad(8 + (i % 10))}0000`;
        const end = `${2016 + (i % 8)}0104T${pad(8 + (i % 10))}1500`;
        await eds.create(uid, vevent([`UID:froonty-test-load-${stamp}-d${i}`, `SUMMARY:FT load ${i}`,
            `DTSTART;TZID=${hostTzid}:${start}`, `DTEND;TZID=${hostTzid}:${end}`,
            i % 2 ? 'RRULE:FREQ=DAILY' : 'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR']));
    }
    const minuteStart = GLib.DateTime.new_from_unix_utc(grid.start + 86400 + 9 * 3600);
    await eds.create(uid, vevent([`UID:froonty-test-load-${stamp}-minutely`, 'SUMMARY:FT load minutely',
        `DTSTART:${icsTime(minuteStart)}`, `DTEND:${icsTime(minuteStart.add_minutes(1))}`, 'RRULE:FREQ=MINUTELY']));
    await eds.create(uid, vevent([`UID:froonty-test-load-${stamp}-hourly`, 'SUMMARY:FT load hourly',
        'DTSTART:20240101T090000Z', 'DTEND:20240101T091500Z', 'RRULE:FREQ=HOURLY']));
    const losAngeles = GLib.TimeZone.new_identifier('America/Los_Angeles');
    const pacificDays = Array.from({length: 120}, (_, i) => now.add_days(i % 5));
    for (const [i, day] of pacificDays.entries()) {
        await eds.create(uid, vevent([`UID:froonty-test-load-${stamp}-p${i}`, `SUMMARY:FT load pacific ${i}`,
            `DTSTART;TZID=Pacific Standard Time:${icsDate(day)}T140000`,
            `DTEND;TZID=Pacific Standard Time:${icsDate(day)}T150000`]));
    }

    const scheduler = service._adapter.scheduler;
    scheduler.turns = 0;
    scheduler.longestTurn = 0;
    // The main loop's longest stall meanwhile, whatever ran (a note).
    let last = GLib.get_monotonic_time();
    let stall = 0;
    const probe = GLib.timeout_add(GLib.PRIORITY_HIGH, 2, () => {
        const t = GLib.get_monotonic_time();
        stall = Math.max(stall, t - last);
        last = t;
        return GLib.SOURCE_CONTINUE;
    });
    // The tab's redraws meanwhile: how many, and the longest (a note).
    const tabView = calendarEntry().view;
    const refresh = tabView._refresh;
    const redraws = [];
    tabView._refresh = function (...args) {
        const t = GLib.get_monotonic_time();
        refresh.apply(this, args);
        redraws.push(GLib.get_monotonic_time() - t);
    };
    const started = GLib.get_monotonic_time();
    await openCalendarTab();
    const pacificRight = () => {
        const starts = new Map();
        for (const {item, occurrence} of service._store.occurrences(service.calendars.map(c => c.uid))) {
            if (item.title?.startsWith('FT load pacific '))
                starts.set(item.title, occurrence.start);
        }
        return pacificDays.filter((day, i) => starts.get(`FT load pacific ${i}`) ===
            GLib.DateTime.new(losAngeles, day.get_year(), day.get_month(), day.get_day_of_month(), 14, 0, 0).to_unix()).length;
    };
    const loaded = await waitFor(() => service.settled && service.calendars.some(c => c.uid === uid) &&
        shownOccurrences(service, 'FT load minutely').length > 0 && pacificRight() === 120, 30000);
    const seconds = (GLib.get_monotonic_time() - started) / 1e6;
    GLib.source_remove(probe);
    delete tabView._refresh;

    const longest = scheduler.longestTurn / 1000;
    const longestRedraw = Math.max(0, ...redraws) / 1000;
    check('calendar load: 50 long-running series, a minutely and an hourly one: every expansion turn under a frame',
        loaded && longest < 16,
        `note: ${scheduler.turns} turns, longest ${longest.toFixed(1)} ms; the main loop's longest stall ` +
        `${(stall / 1000).toFixed(1)} ms; ${redraws.length} redraws of the tab, longest ` +
        `${longestRedraw.toFixed(1)} ms; loaded in ${seconds.toFixed(1)} s`);
    // service.js LOADING_REDRAW_MS, plus the visit's own and completions.
    check('calendar load: the tab redraws at most 5 times a second while the calendar loads',
        redraws.length <= Math.ceil(seconds * 5) + 6, `${redraws.length} redraws in ${seconds.toFixed(1)} s`);
    const counts = Array.from({length: 50}, (_, i) => shownOccurrences(service, `FT load ${i}`).length);
    const weekdays = (() => {
        let n = 0;
        for (let t = grid.start + 43200; t < grid.end; t += 86400)
            n += GLib.DateTime.new_from_unix_utc(t).to_timezone(tz).get_day_of_week() <= 5 ? 1 : 0;
        return n;
    })();
    check('calendar load: each daily series on every day of the grid, each weekday one on its weekdays',
        counts.every((n, i) => n === (i % 2 ? days : weekdays)), `${counts} (days ${days}, weekdays ${weekdays})`);
    const minutely = shownOccurrences(service, 'FT load minutely');
    const hourly = shownOccurrences(service, 'FT load hourly');
    check('calendar load: the minutely series from its first minute, the hourly one from the grid\'s start, 1000 each',
        minutely.length === 1000 && minutely[0].start === minuteStart.to_unix() &&
        minutely[999].start === minuteStart.to_unix() + 999 * 60 &&
        hourly.length === 1000 && hourly[0].start >= grid.start - 3600 && hourly[0].start <= grid.start + 3600,
        `${minutely.length} from ${minutely[0]?.start} (${minuteStart.to_unix()}), ${hourly.length} from ${hourly[0]?.start}`);
    const zones = service._adapter._clients.get(uid)?.zones;
    check('calendar load: 120 events in a zone libical does not know: all at 14:00 Pacific; the zone fetched once, kept',
        pacificRight() === 120 && Boolean(zones?.get('Pacific Standard Time')) && zones.size === 1,
        `${pacificRight()} of 120`);
    island().collapse();
    await sleep(animationWait());
}

// Disable while the tab loads, as a screen lock can: nothing is left
// running, no error is logged (run.sh greps the Shell log).
async function testCalendarLifecycle() {
    settings().set_string('hub-last-tab', 'calendar');
    const failures = [];
    for (let i = 0; i < 5; i++) {
        await setExtensionEnabled(false);
        await setExtensionEnabled(true);
        const service = calendarEntry()?.service;
        island().expand();
        await sleep(i * 20);
        await setExtensionEnabled(false);
        await sleep(i * 50);
        if (!service || service.viewCount !== 0 || service.clientCount !== 0 || service.registry !== null ||
            service._changedId !== 0 || service._quietId !== 0 || service._adapter?.scheduler.pending)
            failures.push(`#${i}: views=${service?.viewCount} clients=${service?.clientCount} registry=${service?.registry}`);
    }
    await setExtensionEnabled(true);
    check('calendar: disabled while loading (5×): no view, connection or registry left', failures.length === 0,
        failures.join('; '));
    // Left as the last tab: testLifecycle's cycles (some mid-expand) then
    // run with the Calendar tab.
}

// ---------------------------------------------------------------- Claude attention bar
// "When Claude needs you" (docs/features/claude-attention.md): Froonty's
// real hook script run as Claude Code runs it, state files written the way
// it writes them, and real GNOME notifications posing as the Claude app or
// a web browser (desktop files run.sh installs). Claude Code itself is
// never run. A self-contained block.

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

const ATTENTION_VARS = ['CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_PID', 'CLAUDE_CODE_SESSION_ID',
    'CLAUDE_PROJECT_DIR', 'CHROME_DESKTOP'];
const attention = () => island()?._pillBars?.get('claude')?.attention ?? null;
const attentionBar = () => attention()?.bar ?? null;
const attentionDir = () => Gio.File.new_for_path(GLib.build_filenamev(
    [GLib.get_user_runtime_dir(), 'froonty', 'claude-attention']));
const stateThere = session => attentionDir().get_child(`${session}.json`).query_exists(null);
const barShown = () => Boolean(attentionBar()?.actor.mapped && attentionBar().actor.opacity === 255);
const barHidden = () => !attentionBar()?.actor.mapped;
const barState = () => `shown=${barShown()} mapped=${attentionBar()?.actor.mapped} ` +
    `opacity=${attentionBar()?.actor.opacity} text="${attentionBar()?._text.text}" ` +
    `place="${attentionBar()?._place.text}" more="${attentionBar()?._more.text}" ` +
    `entries=${JSON.stringify(attention()?.service.entries.map(e => `${e.id}=${e.kind}`))} ` +
    `tray=${Main.messageTray.visible} overview=${Main.overview.visible}`;

// A command with none of a Claude Code session's variables but `env`.
async function runAttentionCommand(argv, env = {}, input = '') {
    const launcher = new Gio.SubprocessLauncher({
        flags: Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE |
            Gio.SubprocessFlags.STDERR_PIPE,
    });
    for (const name of ATTENTION_VARS)
        launcher.unsetenv(name);
    for (const [name, value] of Object.entries(env))
        launcher.setenv(name, String(value), true);
    const proc = launcher.spawnv(argv);
    const [stdout, stderr] = await proc.communicate_utf8_async(input, null);
    return {status: proc.get_if_exited() ? proc.get_exit_status() : -1, stdout, stderr};
}

function procStart(pid) {
    const [, bytes] = GLib.file_get_contents(`/proc/${pid}/stat`);
    const text = new TextDecoder().decode(bytes);
    return Number(text.slice(text.lastIndexOf(')') + 1).trim().split(/\s+/)[19]);
}

// As the hook script writes it: a new file renamed into the folder.
async function writeAttention(session, {kind = 'permission', at = Date.now(), entrypoint = 'claude-vscode',
    project = 'Alpha', pids, desktop = null}) {
    const {serializeEntry} = await import(`file://${extension().path}/features/claude/attention.js`);
    const dir = attentionDir();
    const temp = dir.get_parent().get_child(`.claude-attention-${session}.checks.tmp`);
    temp.replace_contents(serializeEntry({kind, at, session, entrypoint, project, pids, desktop}),
        null, false, Gio.FileCreateFlags.PRIVATE, null);
    temp.move(dir.get_child(`${session}.json`), Gio.FileCopyFlags.OVERWRITE, null, null);
}

// Whether the bar ever shows during `ms`.
async function everShown(ms) {
    let shown = false;
    for (let waited = 0; waited < ms; waited += 50) {
        shown ||= Boolean(attentionBar()?.actor.visible);
        await sleep(50);
    }
    return shown;
}

function notificationsCall(method, params, replyType) {
    return new Promise((resolve, reject) => {
        Gio.DBus.session.call('org.freedesktop.Notifications', '/org/freedesktop/Notifications',
            'org.freedesktop.Notifications', method, params,
            replyType ? new GLib.VariantType(replyType) : null,
            Gio.DBusCallFlags.NONE, -1, null, (conn, res) => {
                try {
                    resolve(conn.call_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
    });
}

// A real freedesktop notification, as an app sends one (async: the Shell
// is calling itself). With a default action, as Electron apps send them:
// a click then goes back to the app, and GNOME starts nothing.
async function sendNotification(appName, desktopEntry, summary, body, urgency) {
    const reply = await notificationsCall('Notify', new GLib.Variant('(susssasa{sv}i)', [
        appName, 0, '', summary, body, ['default', 'Open'],
        {'desktop-entry': new GLib.Variant('s', desktopEntry), 'urgency': new GLib.Variant('y', urgency)},
        -1]), '(u)');
    return reply.deepUnpack()[0];
}

// A screen lock, as far as an extension can tell: GNOME Shell disables
// extensions at a lock with Main.sessionMode.isLocked already set
// (ui/sessionMode.js _sync() sets it before 'updated'). The headless Shell
// has no screen shield to lock for real, so only that flag is set, for as
// long as Froonty is being disabled.
async function disableAsAtScreenLock() {
    const was = Main.sessionMode.isLocked;
    Main.sessionMode.isLocked = true;
    try {
        Main.extensionManager.disableExtension(UUID);
        await waitForState('INACTIVE');
    } finally {
        Main.sessionMode.isLocked = was;
    }
    return waitForExtensionManagerQuiet();
}

async function testClaudeAttention(outDir) {
    const MessageTray = await import('resource:///org/gnome/shell/ui/messageTray.js');
    const {CLEAR_COMMAND} = await import(`file://${extension().path}/features/claude/attentionSetup.js`);
    const hookScript = `${extension().path}/features/claude/attentionHook.js`;
    const s = settings();
    const tray = Main.messageTray;
    const monitor = Main.layoutManager.primaryMonitor;
    const away = [monitor.x + 60, monitor.y + monitor.height / 2];
    const children = [];
    const sources = [];
    const closed = new Map();
    for (const key of ['claude-attention-enabled', 'claude-attention-finished', 'claude-attention-app',
        'claude-attention-browsers'])
        s.reset(key);
    const signalId = Gio.DBus.session.signal_subscribe(null, 'org.freedesktop.Notifications',
        'NotificationClosed', '/org/freedesktop/Notifications', null, Gio.DBusSignalFlags.NONE,
        (_conn, _sender, _path, _iface, _signal, params) => {
            const [id, reason] = params.deepUnpack();
            closed.set(id, reason);
        });
    await movePointerTo(...away);

    try {
        // 1. Where it sits.
        const column = strip()?.get_first_child();
        check('attention: the strip holds a column: the pill, then the bar',
            column?.name === 'froontyColumn' && column.get_n_children() === 2 &&
            column.get_child_at_index(0) === pill() && pill()?.name === 'froontyPill' &&
            column.get_child_at_index(1) === attentionBar()?.actor,
            `${column?.get_children().map(describeActor)}`);
        check('attention: no bar while nothing waits', barHidden() && !attentionBar()?.actor.visible, barState());
        const dir = attentionDir();
        const mode = dir.query_exists(null)
            ? dir.query_info('unix::mode', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null)
                .get_attribute_uint32('unix::mode') & 0o777 : null;
        check('attention: its folder exists (0700) in the private runtime folder',
            mode === 0o700 && dir.get_path().startsWith(`${GLib.getenv('XDG_RUNTIME_DIR')}/`),
            `${dir.get_path()} mode=${mode?.toString(8)}`);
        let covers = pillCoversClock();
        check('attention: the pill still covers the top bar clock', covers.ok, covers.detail);

        // 2. End to end, through the real hook script.
        const claude = spawnChild(['/usr/bin/sleep', '600']);
        children.push(claude);
        await sleep(200);
        const pids = [[claude.pid, procStart(claude.pid)]];
        const input = JSON.stringify({session_id: 'froonty-test-1', cwd: '/tmp/Alpha',
            hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash',
            notification_type: 'permission_prompt'});
        const run = await runAttentionCommand(['/usr/bin/gjs', '-m', hookScript, 'notification'],
            {CLAUDE_CODE_ENTRYPOINT: 'claude-vscode', CLAUDE_PID: claude.pid, CLAUDE_PROJECT_DIR: '/tmp/Alpha'},
            input);
        check('attention: the hook script, run as Claude Code runs it, exits 0 and prints nothing',
            run.status === 0 && run.stdout === '' && run.stderr === '', JSON.stringify(run));
        const shownInTime = await waitFor(barShown, 1000);
        check('attention: within a second the bar says what and where',
            shownInTime && attentionBar()._text.text === 'Claude needs your permission' &&
            attentionBar()._place.text === 'Alpha · VS Code' && !attentionBar()._more.visible, barState());
        const p = boxOf(pill());
        const b = boxOf(attentionBar().actor);
        check('attention: under the pill, centered on it, on one line',
            b.y1 >= p.y2 + 6 * scale() - 1 && Math.abs((b.x1 + b.x2) / 2 - (p.x1 + p.x2) / 2) <= 1 &&
            b.y2 - b.y1 <= 40 * scale() && b.y2 - b.y1 > 0,
            `bar=[${b.x1},${b.y1} - ${b.x2},${b.y2}] pill=[${p.x1},${p.y1} - ${p.x2},${p.y2}]`);
        const name = attentionBar()._main.accessible_name;
        check('attention: its accessible name says both',
            name.includes('Claude needs your permission') && name.includes('Alpha · VS Code'), name);
        covers = pillCoversClock();
        check('attention: with the bar shown, the pill still covers the clock', covers.ok, covers.detail);
        await screenshotTop(outDir, 'attention-bar', 200);

        // 3. Claude Code's clear command (UserPromptSubmit, PostToolBatch).
        const clear = await runAttentionCommand(['/bin/sh', '-c', CLEAR_COMMAND],
            {CLAUDE_CODE_SESSION_ID: 'froonty-test-1'});
        const cleared = await waitFor(() => !stateThere('froonty-test-1') && barHidden(), 2000);
        check('attention: the clear command deletes the file and the bar goes',
            clear.status === 0 && clear.stdout === '' && cleared, `${JSON.stringify(clear)} ${barState()}`);

        // 4. Most urgent first; × and Settings' "Also when Claude finishes".
        await writeAttention('froonty-test-2', {kind: 'finished', at: Date.now(), pids});
        await writeAttention('froonty-test-3', {kind: 'permission', at: Date.now() - 60000, pids});
        await waitFor(() => barShown() && attentionBar()._more.text === '+1', 2000);
        check('attention: a permission before a newer finished reply, "+1" for it',
            attentionBar()._text.text === 'Claude needs your permission' && attentionBar()._more.visible &&
            attentionBar()._more.text === '+1' && attentionBar()._main.accessible_name.endsWith(', 1 more'),
            barState());
        await clickActor(attentionBar()._close);
        await movePointerTo(...away);
        await waitFor(() => attentionBar()._text.text === 'Claude finished' && !stateThere('froonty-test-3'), 2000);
        check('attention: × drops it (its file goes) and the next shows',
            barShown() && attentionBar()._text.text === 'Claude finished' && !stateThere('froonty-test-3') &&
            stateThere('froonty-test-2') && !attentionBar()._more.visible, barState());
        s.set_boolean('claude-attention-finished', false);
        await waitFor(() => barHidden() && !stateThere('froonty-test-2'), 2000);
        check('attention: "Also when Claude finishes" off hides it and deletes its file',
            barHidden() && !stateThere('froonty-test-2'), barState());
        s.reset('claude-attention-finished');

        // 5. A Claude Code that is gone.
        const gone = spawnChild(['/usr/bin/sleep', '600']);
        await sleep(200);
        const goneStart = procStart(gone.pid);
        gone.proc.force_exit();
        await waitFor(() => gone.exited, 2000);
        await writeAttention('froonty-test-4', {pids: [[gone.pid, goneStart]]});
        const goneShown = await everShown(1000);
        check('attention: a session whose Claude Code is gone never shows; its file goes',
            !goneShown && !stateThere('froonty-test-4'), barState());

        // 6. Out of the way of the open island, banners, Do Not Disturb and
        // the overview.
        await writeAttention('froonty-test-5', {pids});
        await waitFor(barShown, 2000);
        island().expand();
        check('attention: expanding the island hides the bar at once', !attentionBar().actor.mapped, barState());
        await sleep(animationWait());
        check('attention: hidden while the island is open', barHidden(), barState());
        await screenshotTop(outDir, 'attention-expanded', 520);
        island().collapse();
        await waitFor(barShown, animationWait() + 1000);
        check('attention: back once the island has collapsed', barShown(), barState());

        const source = new MessageTray.Source({title: 'Froonty test', iconName: 'dialog-information-symbolic'});
        sources.push(source);
        tray.add(source);
        source.addNotification(new MessageTray.Notification({source, title: 'Banner',
            body: 'Froonty headless test', urgency: MessageTray.Urgency.NORMAL}));
        await waitFor(() => tray.visible, 2000);
        check('attention: a GNOME banner takes its place', tray.visible && !attentionBar().actor.visible, barState());
        source.destroy();
        await waitFor(() => !tray.visible && barShown(), 2000 + MessageTray.ANIMATION_TIME);
        check('attention: back once the banner has gone', barShown(), barState());
        // Destroyed: never touched again.
        sources.length = 0;

        // Default session mode only: when Do Not Disturb ends, Ubuntu Dock
        // logs TypeErrors of its own (see testCalendarMenu).
        const dock = Main.extensionManager.lookup('ubuntu-dock@ubuntu.com');
        if (dock?.state !== ExtensionState.ACTIVE) {
            const gnomeNotifications = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
            gnomeNotifications.set_boolean('show-banners', false);
            await waitFor(barHidden, 1000);
            check('attention: Do Not Disturb hides it', barHidden(), barState());
            gnomeNotifications.reset('show-banners');
            await waitFor(barShown, 1000);
            check('attention: back when Do Not Disturb ends', barShown(), barState());
        }

        Main.overview.show();
        await waitFor(() => Main.overview.visible && !attentionBar().actor.visible, 3000);
        check('attention: hidden in the overview', !attentionBar().actor.visible, barState());
        Main.overview.hide();
        await waitFor(() => !Main.overview.visible && barShown(), 3000);
        check('attention: back when the overview closes', barShown(), barState());
        attention().service.dismiss('hook:froonty-test-5');
        await waitFor(barHidden, 1000);

        // 7. The window it waits in: Froonty's own settings window stands
        // for VS Code (a process of the chain owns it).
        extension().stateObj._settingsWindow.open();
        const window = await waitForSettingsWindow();
        await waitFor(() => global.display.focus_window === window, 3000);
        const tracker = Shell.WindowTracker.get_default();
        const prefsPid = window?.get_pid() ?? 0;
        const prefsApp = window ? tracker.get_window_app(window) : null;
        const fromPid = prefsPid > 0 ? tracker.get_app_from_pid(prefsPid) : null;
        const chain = prefsPid > 1 ? [...pids, [prefsPid, procStart(prefsPid)]] : pids;
        const windowDetail = `window=${window?.get_title()} pid=${prefsPid} app=${prefsApp?.get_id()} ` +
            `appFromPid=${fromPid?.get_id() ?? 'none'} focus=${global.display.focus_window?.get_title()}`;
        global.display.unset_input_focus(global.get_current_time());
        await sleep(SETTLE_MS);
        await writeAttention('froonty-test-6', {pids: chain, project: 'Froonty'});
        await waitFor(barShown, 2000);
        check('attention: it names the app whose window the session\'s processes own',
            barShown() && prefsApp && attentionBar()._place.text === `Froonty · ${prefsApp.get_name()}`,
            `${barState()} ${windowDetail}`);
        await clickActor(attentionBar()._main);
        await movePointerTo(...away);
        await waitFor(() => global.display.focus_window === window && !stateThere('froonty-test-6'), 3000);
        check('attention: a click brings that window to the front and drops the entry',
            window && global.display.focus_window === window && !stateThere('froonty-test-6') && barHidden(),
            `${barState()} ${windowDetail}`);
        await writeAttention('froonty-test-7', {pids: chain, project: 'Froonty'});
        const shownWhileLooking = await everShown(1000);
        check('attention: one arriving while its window has the focus never shows; its file goes',
            !shownWhileLooking && !stateThere('froonty-test-7'), barState());
        global.display.unset_input_focus(global.get_current_time());
        await sleep(SETTLE_MS);
        await writeAttention('froonty-test-8', {pids: chain, project: 'Froonty'});
        await waitFor(barShown, 2000);
        const shownBefore = barShown();
        if (window)
            Main.activateWindow(window, global.display.get_current_time_roundtrip());
        await waitFor(() => !stateThere('froonty-test-8') && barHidden(), 2000);
        check('attention: focusing its window clears it',
            shownBefore && !stateThere('froonty-test-8') && barHidden(), `before=${shownBefore} ${barState()}`);
        await closeSettingsWindows();

        // 8. The keyboard: Ctrl+Alt+Tab, Delete, Escape.
        await writeAttention('froonty-test-9', {pids});
        await waitFor(barShown, 2000);
        const item = Main.ctrlAltTabManager._items.find(i => i.root === attentionBar().actor);
        check('attention: listed by Ctrl+Alt+Tab while it shows', item?.proxy.mapped === true, barState());
        Main.ctrlAltTabManager.focusGroup(item, global.get_current_time());
        await sleep(SETTLE_MS);
        check('attention: Ctrl+Alt+Tab puts the keyboard focus on it',
            global.stage.key_focus === attentionBar()._main, `focus=${global.stage.key_focus}`);
        await pressKeys(Clutter.KEY_Delete);
        await waitFor(() => !stateThere('froonty-test-9') && barHidden(), 2000);
        check('attention: Delete dismisses it', !stateThere('froonty-test-9') && barHidden(), barState());
        check('attention: hidden, Ctrl+Alt+Tab does not list it', item && !item.proxy.mapped);
        await writeAttention('froonty-test-10', {pids});
        await waitFor(barShown, 2000);
        Main.ctrlAltTabManager.focusGroup(item, global.get_current_time());
        await sleep(SETTLE_MS);
        const focused = global.stage.key_focus === attentionBar()._main;
        await pressKeys(Clutter.KEY_Escape);
        check('attention: Escape takes the keyboard focus away, and the bar stays',
            focused && !(global.stage.key_focus && attentionBar().actor.contains(global.stage.key_focus)) &&
            barShown() &&
            stateThere('froonty-test-10'), `focused=${focused} now=${global.stage.key_focus} ${barState()}`);
        attention().service.dismiss('hook:froonty-test-10');
        await waitFor(barHidden, 1000);

        // 9. The Claude app's own notifications (GNOME's message tray).
        await writeAttention('froonty-test-app', {entrypoint: 'claude-desktop', pids});
        const first = await sendNotification('Claude', 'com.anthropic.Claude', 'Froonty',
            'Allow Claude to run git push?', 1);
        // Its banner shows first, then the bar.
        await waitFor(() => !tray.visible && barShown(), 15000);
        const appEntries = attention().service.entries;
        check('attention: the Claude app\'s notification shows with its title',
            barShown() && attentionBar()._text.text === 'Claude needs your permission' &&
            attentionBar()._place.text === 'Froonty · Claude', barState());
        check('attention: its own Claude Code session\'s hook entry stays hidden',
            appEntries.length === 1 && appEntries[0].origin === 'app' && stateThere('froonty-test-app'), barState());
        await notificationsCall('CloseNotification', new GLib.Variant('(u)', [first]), null);
        await waitFor(barHidden, 2000);
        check('attention: the app closing its notification clears the bar',
            barHidden() && closed.get(first) === 3, `reason=${closed.get(first)} ${barState()}`);

        const second = await sendNotification('Claude', 'com.anthropic.Claude', 'Froonty',
            'Allow Claude to run git push?', 0);
        await waitFor(barShown, 2000);
        await clickActor(attentionBar()._main);
        await movePointerTo(...away);
        await waitFor(() => closed.has(second) && barHidden(), 2000);
        check('attention: a click opens it as GNOME does, which removes the notification',
            closed.has(second) && barHidden(), `reason=${closed.get(second)} ${barState()}`);

        const third = await sendNotification('Claude', 'com.anthropic.Claude', 'Froonty',
            'Allow Claude to run git push?', 0);
        await waitFor(barShown, 2000);
        await clickActor(attentionBar()._close);
        await movePointerTo(...away);
        await waitFor(() => closed.has(third) && barHidden(), 2000);
        check('attention: × dismisses it in GNOME too (closed as dismissed, reason 2)',
            closed.get(third) === 2 && barHidden(), `reason=${closed.get(third)} ${barState()}`);

        s.set_boolean('claude-attention-app', false);
        await waitFor(barShown, 2000);
        check('attention: "Sessions in the Claude app" off: its hook entry shows instead',
            barShown() && attention().service.entries[0]?.id === 'hook:froonty-test-app' &&
            attentionBar()._place.text === 'Alpha · Claude', barState());
        s.reset('claude-attention-app');
        await waitFor(barHidden, 2000);
        check('attention: back on, hidden again', barHidden(), barState());
        attentionDir().get_child('froonty-test-app.json').delete(null);

        // 10. Browsers (off by default).
        const browser = await sendNotification('Test Browser', 'froonty-test-browser', 'Claude',
            'Claude responded · claude.ai', 0);
        const browserShown = await everShown(800);
        check('attention: a browser\'s claude.ai notification is ignored by default', !browserShown, barState());
        s.set_boolean('claude-attention-browsers', true);
        await waitFor(barShown, 2000);
        check('attention: with browsers on, it shows',
            barShown() && attentionBar()._text.text === 'Claude needs your attention' &&
            attentionBar()._place.text === 'Test Browser', barState());
        const other = await sendNotification('Test Browser', 'froonty-test-browser', 'Claude Dupont',
            'lunch?', 0);
        await sleep(300);
        check('attention: a browser notification not about claude.ai is not',
            attention().service.entries.length === 1, barState());
        for (const id of [browser, other])
            await notificationsCall('CloseNotification', new GLib.Variant('(u)', [id]), null);
        s.reset('claude-attention-browsers');
        await waitFor(barHidden, 2000);

        // 11. Turning the bar off.
        const handlerCounts = () => ({
            focus: countHandlers(global.display, 'notify::focus-window'),
            trayVisible: countHandlers(tray, 'notify::visible'),
            sourceAdded: countHandlers(tray, 'source-added'),
        });
        s.set_boolean('claude-attention-enabled', false);
        await waitFor(() => !attentionDir().query_exists(null), 2000);
        const off = handlerCounts();
        check('attention: off, its folder is gone, and so is the bar',
            !attentionDir().query_exists(null) && attention() === null &&
            strip().get_first_child().get_n_children() === 1, `exists=${attentionDir().query_exists(null)}`);
        const offRun = await runAttentionCommand(['/usr/bin/gjs', '-m', hookScript, 'notification'],
            {CLAUDE_CODE_ENTRYPOINT: 'claude-vscode', CLAUDE_PID: claude.pid}, input);
        check('attention: off, the hook script records nothing and exits 0',
            offRun.status === 0 && offRun.stdout === '' && !attentionDir().get_parent().get_child('claude-attention').query_exists(null),
            JSON.stringify(offRun));
        s.reset('claude-attention-enabled');
        await sleep(SETTLE_MS);
        // An entry whose app is known: the focus is watched while it shows.
        await writeAttention('froonty-test-11', {pids, desktop: 'froonty-test-browser.desktop'});
        await waitFor(barShown, 2000);
        const on = handlerCounts();
        check('attention: on again, it works, and holds its handlers (focus watched while an app waits)',
            barShown() && attentionBar()._place.text === 'Alpha · Test Browser' &&
            on.focus === off.focus + 1 && on.trayVisible > off.trayVisible && on.sourceAdded > off.sourceAdded,
            `off=${JSON.stringify(off)} on=${JSON.stringify(on)} ${barState()}`);
        s.set_boolean('claude-attention-enabled', false);
        await waitFor(() => !attentionDir().query_exists(null), 2000);
        check('attention: off again, every handler is back to where it was, the files gone',
            JSON.stringify(handlerCounts()) === JSON.stringify(off) && !attentionDir().query_exists(null),
            `off=${JSON.stringify(off)} now=${JSON.stringify(handlerCounts())}`);
        s.reset('claude-attention-enabled');
        await sleep(SETTLE_MS);
        check('attention: back on, the folder is back', attentionDir().query_exists(null) && attention() !== null);

        // 12. A screen lock (disable, enable) keeps what waits. A plain
        // disable does not: testClaudeAttentionIsland.
        await writeAttention('froonty-test-12', {pids});
        await waitFor(barShown, 2000);
        const enabledCounts = {
            ...handlerCounts(),
            overview: jsHandlerCount(Main.overview, 'showing'),
        };
        await disableAsAtScreenLock();
        await sleep(SETTLE_MS);
        const kept = stateThere('froonty-test-12');
        await setExtensionEnabled(true);
        await waitFor(barShown, 3000);
        const afterCounts = {...handlerCounts(), overview: jsHandlerCount(Main.overview, 'showing')};
        check('attention: across a screen lock (disable, enable), what waits is kept and shows again, handlers once',
            kept && barShown() && attention().service.entries[0]?.id === 'hook:froonty-test-12' &&
            JSON.stringify(afterCounts) === JSON.stringify(enabledCounts),
            `kept=${kept} before=${JSON.stringify(enabledCounts)} after=${JSON.stringify(afterCounts)} ${barState()}`);
    } finally {
        Gio.DBus.session.signal_unsubscribe(signalId);
        for (const source of sources)
            source.destroy();
        for (const key of ['claude-attention-enabled', 'claude-attention-finished', 'claude-attention-app',
            'claude-attention-browsers'])
            s.reset(key);
        await sleep(SETTLE_MS);
        for (const session of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', 'app']) {
            try {
                attentionDir().get_child(`froonty-test-${session}.json`).delete(null);
            } catch {}
        }
        for (const child of children) {
            if (!child.exited)
                child.proc.force_exit();
        }
        await closeSettingsWindows();
        await movePointerTo(...away);
        // Leave the island as found: its hub shown once (disable/enable
        // above made a new one; later checks measure the hub's actors,
        // which have no size before they are first shown).
        island().expand();
        await sleep(animationWait());
        island().collapse();
        await sleep(animationWait());
    }
}

// A terminal (or VS Code) with several windows: testWindows.js, one GTK
// process whose windows GNOME Shell counts as one app's
// (org.froonty.TestWindows, a desktop file run.sh installs). Which window a
// session waits in, what shows on arrival, and what a focus change clears.
async function testClaudeAttentionWindows(outDir) {
    const here = GLib.path_get_dirname(Gio.File.new_for_uri(import.meta.url).get_path());
    const TITLES = ['main.js - Alpha - Test Windows', 'catalin@host: ~/src/Froonty', '✳ Claude Code'];
    const APP_ID = 'org.froonty.TestWindows.desktop';
    const s = settings();
    const children = [];
    const sessions = [];
    const write = async (session, options) => {
        sessions.push(session);
        await writeAttention(session, options);
    };
    // With a fresh timestamp: an activation with a stale one can be turned
    // down by focus-stealing prevention (then the focus stays put).
    const focusOn = async window => {
        // Then, if that is turned down too (Ubuntu's session), raise and
        // focus the window directly.
        for (let i = 0; i < 3 && global.display.focus_window !== window; i++) {
            const time = global.display.get_current_time_roundtrip();
            if (i === 0) {
                Main.activateWindow(window, time);
            } else {
                window.raise();
                window.focus(time);
            }
            // eslint-disable-next-line no-await-in-loop
            await waitFor(() => global.display.focus_window === window, 1500);
        }
        await sleep(SETTLE_MS);
        return global.display.focus_window === window;
    };
    const ids = () => attention()?.service.entries.map(e => e.id.replace('hook:froonty-test-', '')).sort() ?? [];
    for (const key of ['claude-attention-enabled', 'claude-attention-finished', 'claude-attention-app'])
        s.reset(key);
    await movePointerTo(Main.layoutManager.primaryMonitor.x + 60, Main.layoutManager.primaryMonitor.y + 400);

    try {
        const windows = spawnChild(['/usr/bin/gjs', '-m', `${here}/testWindows.js`, ...TITLES]);
        const claude = spawnChild(['/usr/bin/sleep', '600']);
        children.push(windows, claude);
        const app = () => Shell.AppSystem.get_default().lookup_app(APP_ID);
        await waitFor(() => app()?.get_windows().length === TITLES.length, 15000);
        const [alpha, shell, claudeWindow] = TITLES.map(t => app()?.get_windows().find(w => w.get_title() === t));
        check('attention windows: a test app with three windows, one app for GNOME Shell',
            alpha && shell && claudeWindow,
            `windows=${app()?.get_windows().map(w => w.get_title())} exited=${windows.exited}`);
        if (!(alpha && shell && claudeWindow))
            return;
        const chain = [[claude.pid, procStart(claude.pid)], [windows.pid, procStart(windows.pid)]];

        // Which window: through the real ClaudeDesktop.resolve().
        const desktop = attention().desktop;
        const resolved = project => desktop.resolve({pids: chain, desktop: null, project});
        const a = resolved('Alpha');
        check('attention windows: the one window whose title names the project is known for sure',
            a?.appId === APP_ID && a.appName === 'Test Windows' && a.window === alpha && a.exact === true,
            `appId=${a?.appId} window=${a?.window?.get_title()} exact=${a?.exact}`);
        const f = resolved('Froonty');
        check('attention windows: a title that only contains the project (a shell\'s) is a guess, not for sure',
            f?.window === shell && f.exact === false, `window=${f?.window?.get_title()} exact=${f?.exact}`);
        const g = resolved('Gamma');
        check('attention windows: no title names it: the most recent window, not for sure',
            g?.window === app().get_windows()[0] && g.exact === false,
            `window=${g?.window?.get_title()} exact=${g?.exact}`);

        // 1. The user types in another window of the terminal (a shell
        // whose title holds the project folder): what Claude Code says
        // in its own window shows.
        check('attention windows: the test can focus the shell window', await focusOn(shell),
            `focus=${global.display.focus_window?.get_title()}`);
        await write('froonty-test-30', {kind: 'permission', entrypoint: 'cli', project: 'Froonty', pids: chain});
        await write('froonty-test-31', {kind: 'finished', entrypoint: 'cli', project: 'Froonty', pids: chain});
        await write('froonty-test-32', {kind: 'waiting', entrypoint: 'cli', project: 'Froonty', pids: chain});
        await waitFor(() => ids().length === 3, 2000);
        // A GNOME banner hides the bar (as it should): let it go first.
        await waitFor(() => !Main.messageTray.visible, 10000);
        await sleep(300);
        check('attention windows: a permission, a finished reply and an idle prompt show while another window of the terminal has the focus',
            JSON.stringify(ids()) === '["30","31","32"]' && barShown() &&
            attentionBar()._text.text === 'Claude needs your permission' &&
            attentionBar()._place.text === 'Froonty · Test Windows' && attentionBar()._more.text === '+2' &&
            ['30', '31', '32'].every(n => stateThere(`froonty-test-${n}`)),
            `focus=${global.display.focus_window?.get_title()} ${barState()}`);
        await screenshotTop(outDir, 'attention-windows', 200);

        // 2. The user goes to another window of that app (its own is not
        // known for sure): a permission clears, the rest stays.
        await focusOn(alpha);
        await waitFor(() => !stateThere('froonty-test-30'), 2000);
        await sleep(300);
        check('attention windows: focusing any window of its app clears a permission whose window is not known for sure, and only that',
            !stateThere('froonty-test-30') && JSON.stringify(ids()) === '["31","32"]' &&
            stateThere('froonty-test-31') && stateThere('froonty-test-32'),
            `focus=${global.display.focus_window?.get_title()} ${barState()}`);
        for (const n of ['31', '32'])
            attention().service.dismiss(`hook:froonty-test-${n}`);
        await waitFor(barHidden, 1000);

        // 3. Its own window, known for sure, has the focus: a terminal's
        // permission still shows (its tab may not be on screen); a finished
        // reply does not, nor VS Code's permission.
        await write('froonty-test-33', {kind: 'permission', entrypoint: 'cli', project: 'Alpha', pids: chain});
        await write('froonty-test-34', {kind: 'finished', entrypoint: 'cli', project: 'Alpha', pids: chain});
        await write('froonty-test-35', {kind: 'permission', entrypoint: 'claude-vscode', project: 'Alpha', pids: chain});
        await waitFor(() => !stateThere('froonty-test-34') && !stateThere('froonty-test-35') && ids().length === 1, 2000);
        await waitFor(() => !Main.messageTray.visible, 10000);
        await sleep(300);
        check('attention windows: its own window focused: a terminal permission shows, a finished reply and VS Code\'s permission do not',
            JSON.stringify(ids()) === '["33"]' && barShown() && stateThere('froonty-test-33') &&
            !stateThere('froonty-test-34') && !stateThere('froonty-test-35'),
            `focus=${global.display.focus_window?.get_title()} ${barState()}`);

        // 4. A Claude Code that crashed while its entry shows: found on
        // the next focus change. Focusing another window of the app than
        // the one known for sure leaves a permission there.
        const doomed = spawnChild(['/usr/bin/sleep', '600']);
        children.push(doomed);
        await sleep(200);
        await write('froonty-test-36', {kind: 'finished', entrypoint: 'cli', project: 'Gamma',
            pids: [[doomed.pid, procStart(doomed.pid)], [windows.pid, procStart(windows.pid)]]});
        await waitFor(() => ids().length === 2, 2000);
        const both = JSON.stringify(ids()) === '["33","36"]';
        doomed.proc.force_exit();
        await waitFor(() => doomed.exited, 2000);
        await focusOn(claudeWindow);
        await waitFor(() => !stateThere('froonty-test-36'), 2000);
        await sleep(300);
        check('attention windows: a focus change finds a crashed Claude Code; its entry and file go',
            both && !stateThere('froonty-test-36') && !ids().includes('36'), `both=${both} ${barState()}`);
        check('attention windows: focusing another window than its own (known for sure) leaves a permission',
            stateThere('froonty-test-33') && JSON.stringify(ids()) === '["33"]', barState());
        await focusOn(alpha);
        await waitFor(() => !stateThere('froonty-test-33') && barHidden(), 2000);
        check('attention windows: focusing its own window clears it',
            !stateThere('froonty-test-33') && barHidden(), barState());
    } finally {
        for (const child of children) {
            if (!child.exited)
                child.proc.force_exit();
        }
        await sleep(SETTLE_MS);
        for (const session of sessions) {
            try {
                attentionDir().get_child(`${session}.json`).delete(null);
            } catch {}
        }
        await waitFor(barHidden, 1000);
    }
}

// The island's side: a collapse cut short by a geometry change, a crash
// found when the island collapses, and Froonty turned off (not a lock).
async function testClaudeAttentionIsland() {
    const s = settings();
    const children = [];
    const hookScript = `${extension().path}/features/claude/attentionHook.js`;
    for (const key of ['claude-attention-enabled', 'claude-attention-finished', 'claude-attention-app'])
        s.reset(key);
    await movePointerTo(Main.layoutManager.primaryMonitor.x + 60, Main.layoutManager.primaryMonitor.y + 400);
    try {
        const claude = spawnChild(['/usr/bin/sleep', '600']);
        children.push(claude);
        await sleep(200);
        const pids = [[claude.pid, procStart(claude.pid)]];

        // 1. Collapsing, and the geometry changes (a monitor, the panel,
        // the scale, a size or radius setting): the collapse is cut short
        // and never completes; the bar still comes back.
        s.set_int('animation-duration', 1500);
        await writeAttention('froonty-test-40', {pids});
        await waitFor(barShown, 2000);
        island().expand();
        await sleep(animationWait());
        island().collapse();
        await sleep(400);
        const midway = Boolean(pill().get_transition('height')) && !attentionBar().actor.visible;
        s.set_int('corner-radius', s.get_int('corner-radius') === 10 ? 12 : 10);
        await waitFor(barShown, 3000);
        check('attention: a geometry change cutting a collapse short still brings the bar back',
            midway && barShown() && !pill().get_transition('height'), `midway=${midway} ${barState()}`);
        s.reset('corner-radius');
        s.reset('animation-duration');
        attention().service.dismiss('hook:froonty-test-40');
        await waitFor(barHidden, 1000);

        // 2. A Claude Code that crashed while its entry shows (no app, so
        // no focus is followed): found when the island collapses.
        const doomed = spawnChild(['/usr/bin/sleep', '600']);
        children.push(doomed);
        await sleep(200);
        await writeAttention('froonty-test-41', {kind: 'input', pids: [[doomed.pid, procStart(doomed.pid)]]});
        const shown = await waitFor(barShown, 2000);
        doomed.proc.force_exit();
        await waitFor(() => doomed.exited, 2000);
        await sleep(SETTLE_MS);
        const stillThere = stateThere('froonty-test-41');
        island().expand();
        await sleep(animationWait());
        island().collapse();
        await waitFor(() => !stateThere('froonty-test-41') && barHidden(), animationWait() + 2000);
        await sleep(SETTLE_MS);
        check('attention: a collapse of the island finds a crashed Claude Code; its entry and file go',
            shown && stillThere && !stateThere('froonty-test-41') && barHidden() &&
            attention().service.entries.length === 0,
            `shown=${shown} stillThere=${stillThere} ${barState()}`);

        // 3. Froonty turned off (not a screen lock): the folder goes, so
        // Claude Code's hooks record nothing; on again, nothing from before.
        const input = JSON.stringify({session_id: 'froonty-test-42', hook_event_name: 'Notification',
            notification_type: 'permission_prompt'});
        await writeAttention('froonty-test-43', {pids});
        await waitFor(barShown, 2000);
        await setExtensionEnabled(false);
        const gone = await waitFor(() => !attentionDir().query_exists(null), 3000);
        const offRun = await runAttentionCommand(['/usr/bin/gjs', '-m', hookScript, 'notification'],
            {CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_PID: claude.pid}, input);
        check('attention: Froonty turned off removes its folder, so the hook script records nothing',
            gone && offRun.status === 0 && offRun.stdout === '' && !attentionDir().query_exists(null),
            `gone=${gone} run=${JSON.stringify(offRun)}`);
        await setExtensionEnabled(true);
        await waitFor(() => attentionDir().query_exists(null) && attention() !== null, 3000);
        await sleep(500);
        check('attention: on again, the folder is back and nothing from before shows',
            attentionDir().query_exists(null) && attention()?.service.entries.length === 0 && barHidden() &&
            !stateThere('froonty-test-43'), barState());

        // The island turned off ("Show island"): the same.
        await writeAttention('froonty-test-44', {pids});
        await waitFor(barShown, 2000);
        s.set_boolean('island-enabled', false);
        const islandGone = await waitFor(() => !attentionDir().query_exists(null), 3000);
        s.reset('island-enabled');
        await waitFor(() => attention() !== null && attentionDir().query_exists(null), 3000);
        await sleep(SETTLE_MS);
        check('attention: the island turned off removes the folder too; back on, it is made again',
            islandGone && attentionDir().query_exists(null) && !stateThere('froonty-test-44'),
            `islandGone=${islandGone} ${barState()}`);
    } finally {
        s.reset('corner-radius');
        s.reset('animation-duration');
        s.reset('island-enabled');
        for (const child of children) {
            if (!child.exited)
                child.proc.force_exit();
        }
        await sleep(SETTLE_MS);
        for (const session of ['40', '41', '42', '43', '44']) {
            try {
                attentionDir().get_child(`froonty-test-${session}.json`).delete(null);
            } catch {}
        }
        // Leave the island as found: its hub shown once (see
        // testClaudeAttention).
        if (island()) {
            island().expand();
            await sleep(animationWait());
            island().collapse();
            await sleep(animationWait());
        }
    }
}

// ================================================================ media
// Media tab (docs/features/media.md), checked against fake players
// (fake-mpris.js) that the checks start as processes on this test
// Shell's PRIVATE session bus; the user's real players are never touched.

const FAKE_MPRIS = GLib.build_filenamev([
    GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]), 'fake-mpris.js']);
const MPRIS = 'org.mpris.MediaPlayer2.';
const mediaEntry = () => island()._hub._entries.get('media') ?? null;
const mediaService = () => mediaEntry()?.service?.service ?? null;
const mediaView = () => mediaEntry()?.view ?? null;
const accessory = () => island()?._accessory ?? null;
let mediaWork = null;

async function mediaShared() {
    return await import(`file://${extension().path}/features/media/shared.js`);
}

function busCallAsync(name, path, iface, method, params = null, replyType = null, timeout = 3000) {
    return new Promise((resolve, reject) => {
        Gio.DBus.session.call(name, path, iface, method, params,
            replyType ? new GLib.VariantType(replyType) : null, Gio.DBusCallFlags.NO_AUTO_START,
            timeout, null, (connection, result) => {
                try {
                    resolve(connection.call_finish(result));
                } catch (e) {
                    reject(e);
                }
            });
    });
}

const hasOwner = async name => (await busCallAsync('org.freedesktop.DBus', '/org/freedesktop/DBus',
    'org.freedesktop.DBus', 'NameHasOwner', new GLib.Variant('(s)', [name]), '(b)')).deepUnpack()[0];

const PROP_TYPES = {
    PlaybackStatus: 's', Rate: 'd', Position: 'x', Volume: 'd', CanGoNext: 'b', CanGoPrevious: 'b',
    CanPlay: 'b', CanPause: 'b', CanSeek: 'b', CanControl: 'b', 'x-fail': 'as', 'x-delay': 'i',
    'x-http-delay': 'i', 'x-ignore-set-position': 'b',
};

/** Sets a fake's state (fake-mpris.js Set): plain values, typed here. */
async function fakeSet(fake, values) {
    const out = {};
    for (const [key, value] of Object.entries(values)) {
        if (key === 'Metadata')
            out[key] = new GLib.Variant('a{sv}', metadataVariants(value));
        else if (key === 'x-tracks')
            out[key] = new GLib.Variant('aa{sv}', value.map(m => metadataVariants(m)));
        else
            out[key] = new GLib.Variant(PROP_TYPES[key], value);
    }
    await busCallAsync(fake.name, '/org/froonty/TestPlayer', 'org.froonty.TestPlayer', 'Set',
        new GLib.Variant('(a{sv})', [out]));
}

async function fakeCalls(fake) {
    const reply = await busCallAsync(fake.name, '/org/froonty/TestPlayer', 'org.froonty.TestPlayer',
        'Calls', null, '(s)');
    return JSON.parse(reply.deepUnpack()[0]);
}

const methodsOf = async fake => (await fakeCalls(fake)).map(c => c.method);

async function waitForAsync(predicate, timeoutMs = 3000) {
    for (let waited = 0; waited < timeoutMs; waited += 100) {
        // eslint-disable-next-line no-await-in-loop
        if (await predicate())
            return true;
        // eslint-disable-next-line no-await-in-loop
        await sleep(100);
    }
    return await predicate();
}

async function clearCalls(fake) {
    await busCallAsync(fake.name, '/org/froonty/TestPlayer', 'org.froonty.TestPlayer', 'ClearCalls');
}

async function fakeSeeked(fake, us) {
    await busCallAsync(fake.name, '/org/froonty/TestPlayer', 'org.froonty.TestPlayer', 'EmitSeeked',
        new GLib.Variant('(x)', [us]));
}

/**
 * Starts a fake player and waits for its name on the bus.
 *
 * @param {string} suffix its name after org.mpris.MediaPlayer2.
 * @param {object} [options] {args: extra fake-mpris.js arguments, state}
 */
async function spawnFake(suffix, {args = [], state = null} = {}) {
    const name = `${MPRIS}${suffix}`;
    const proc = Gio.Subprocess.new(['/usr/bin/gjs', '-m', FAKE_MPRIS, '--names', name,
        '--work', mediaWork, ...args], Gio.SubprocessFlags.NONE);
    const fake = {proc, name, suffix, exited: false};
    proc.wait_async(null, () => {
        fake.exited = true;
    });
    for (let waited = 0; waited < 8000; waited += 50) {
        // eslint-disable-next-line no-await-in-loop
        if (await hasOwner(name).catch(() => false))
            break;
        // eslint-disable-next-line no-await-in-loop
        await sleep(50);
    }
    if (state)
        await fakeSet(fake, state);
    return fake;
}

async function quitFake(fake) {
    if (!fake || fake.exited)
        return;
    await busCallAsync(fake.name, '/org/froonty/TestPlayer', 'org.froonty.TestPlayer', 'Quit')
        .catch(() => {});
    if (!await waitFor(() => fake.exited, 3000))
        fake.proc.force_exit();
}

const coverUrl = suffix => GLib.filename_to_uri(GLib.build_filenamev([mediaWork, `cover-${suffix}.png`]), null);
const song = (title, extra = {}) => ({
    'xesam:title': title,
    'xesam:artist': ['Test Band'],
    'xesam:album': 'Test Album',
    'mpris:length': 180e6,
    'mpris:trackid': `/org/froonty/track/${title.replace(/\W/g, '')}`,
    ...extra,
});
const playing = (title, extra = {}) => ({PlaybackStatus: 'Playing', Metadata: song(title, extra)});
const MUSIC = ['--desktop-entry', 'froonty-test-music'];
const BROWSER = ['--desktop-entry', 'froonty-test-browser'];

const seconds = text => {
    const parts = text.replace('−', '').split(':').map(Number);
    return parts.reduce((total, part) => total * 60 + part, 0);
};

// Clicks an actor that has just been shown, once it is laid out.
async function clickShown(actor) {
    await waitFor(() => actor.mapped && actor.allocation.get_width() > 0, 2000);
    await sleep(SETTLE_MS);
    await clickActor(actor);
}

async function openMediaTab() {
    if (!island().expanded) {
        island().expand();
        await sleep(animationWait());
    }
    if (island()._hub.activeFeature?.id !== 'media') {
        await clickActor(tabButton('media'));
        await sleep(animationWait());
    }
}

async function leaveMediaTab() {
    if (!island().expanded) {
        island().expand();
        await sleep(animationWait());
    }
    await clickActor(tabButton('clock'));
    await sleep(animationWait());
    island().collapse();
    await sleep(animationWait());
}

// Share of strongly red pixels in a stage rectangle (the fake's cover).
async function redIn(outDir, name, box) {
    const path = GLib.build_filenamev([outDir, `${name}.png`]);
    const stream = Gio.File.new_for_path(path).replace(null, false, Gio.FileCreateFlags.NONE, null);
    await new Shell.Screenshot().screenshot_area(Math.round(box.x1), Math.round(box.y1),
        Math.round(box.x2 - box.x1), Math.round(box.y2 - box.y1), stream);
    stream.close(null);
    const pixbuf = GdkPixbuf.Pixbuf.new_from_file(path);
    const pixels = pixbuf.get_pixels();
    const [n, stride] = [pixbuf.get_n_channels(), pixbuf.get_rowstride()];
    let red = 0;
    for (let y = 0; y < pixbuf.get_height(); y++) {
        for (let x = 0; x < pixbuf.get_width(); x++) {
            const i = y * stride + x * n;
            if (pixels[i] > 150 && pixels[i + 1] < 90 && pixels[i + 2] < 90)
                red++;
        }
    }
    return red / (pixbuf.get_width() * pixbuf.get_height());
}

// A pointer drag on the slider from one fraction to another.
async function dragSlider(slider, from, to) {
    const b = boxOf(slider);
    const radius = 5 * scale();
    const at = f => [b.x1 + radius + f * (b.x2 - b.x1 - 2 * radius), (b.y1 + b.y2) / 2];
    pointer.notify_absolute_motion(now(), ...at(from));
    await sleep(60);
    pointer.notify_button(now(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
    await sleep(60);
    for (let i = 1; i <= 8; i++) {
        pointer.notify_absolute_motion(now(), ...at(from + (to - from) * i / 8));
        // eslint-disable-next-line no-await-in-loop
        await sleep(25);
    }
    pointer.notify_button(now(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
    await sleep(SETTLE_MS);
}

async function testMedia(outDir) {
    mediaWork = outDir;
    const s = settings();
    const fakes = [];
    try {
        // H1
        const names = island()._hub._tabColumn.get_children().map(b => b.accessible_name);
        check('media: the Media tab is there by default, after Clock',
            s.get_boolean('media-enabled') && tabButton('media')?.accessible_name === 'Media' &&
            names[0] === 'Clock' && names[1] === 'Media', names.join(','));
        island().expand();
        await sleep(animationWait());
        await movePointerTo(...(() => {
            const b = boxOf(tabButton('media'));
            return [(b.x1 + b.x2) / 2, (b.y1 + b.y2) / 2];
        })());
        await sleep(SETTLE_MS);
        check('media: its tab\'s tooltip says "Media"', island()._hub._tooltip.actor.text === 'Media');

        // H2
        await clickActor(tabButton('media'));
        await sleep(animationWait());
        let view = mediaView();
        let service = mediaService();
        await waitFor(() => service?.ready && view._idle.visible, 3000);
        check('media: with no player, "Nothing playing" once ready; no tick',
            view._idle.visible && view._nothing.visible && view._nothing.text === 'Nothing playing' &&
            !view._main.visible && service.ticking === false,
            `idle=${view._idle.visible} ticking=${service?.ticking}`);
        await screenshotTop(outDir, 'media-idle', 320);
        const [w, h] = pill().get_transformed_size();
        check('media: the tab opens at its size (480 × 248)', w === 480 * scale() && h === 248 * scale(), `${w}x${h}`);

        // H3
        const a = await spawnFake('froontya', {args: MUSIC, state: {
            ...playing('First Song', {'mpris:artUrl': coverUrl('froontya')}), Position: 10e6,
        }});
        fakes.push(a);
        const shown = await waitFor(() => view._title.text === 'First Song' && view._art.hasImage, 5000);
        check('media: a playing player shows its title, artist and cover',
            shown && view._artist.text === 'Test Band' && view._main.visible && !view._idle.visible,
            `title=${view._title.text} artist=${view._artist.text} image=${view._art.hasImage}`);
        check('media: the cover tints the halo and the accent (red)',
            view._art.tint?.r > 0.8 && view._art.tint?.g < 0.2 && /box-shadow/.test(view._art.style ?? '') &&
            /rgba\(2\d\d, \d{1,2}, \d{1,2}, 1\)/.test(view.slider.style ?? ''),
            `tint=${JSON.stringify(view._art.tint)} style=${view.slider.style}`);
        const red = await redIn(outDir, 'media-art-pixels', boxOf(view._art));
        const art = boxOf(view._art);
        check('media: the cover is really drawn (pixel check)', red > 0.6, `${Math.round(red * 100)}% red`);
        check('media: the cover is square, as tall as the player row, inside the island',
            Math.abs((art.x2 - art.x1) - (art.y2 - art.y1)) <= 1 &&
            boxOf(view._controls).y2 <= boxOf(pill()).y2,
            `art=${art.x2 - art.x1}x${art.y2 - art.y1} row=${view._playerRow.height} ` +
            `stack=${view._stack.height} level=${view.level} controls=${boxOf(view._controls).y2} pill=${boxOf(pill()).y2} ` +
            `layout=${JSON.stringify(view._lastLayout)} artFixed=${view._art.natural_width_set}/${view._art.natural_height_set} ` +
            `artNat=${view._art.get_preferred_width(-1)}/${view._art.get_preferred_height(-1)} ` +
            `button=${JSON.stringify(boxOf(view.artButton))} buttonNat=${view.artButton.get_preferred_height(-1)} ` +
            `scale=${view._art.scale_x},${view._art.scale_y}`);
        await screenshotTop(outDir, 'media-playing', 320);

        // H7 (the focus is checked first, before pointer clicks move it)
        check('media: play/pause has the key focus when the tab shows',
            global.stage.key_focus === view.playButton, `${global.stage.key_focus}`);
        await clearCalls(a);
        await pressKeys(Clutter.KEY_space);
        check('media: Space toggles playback',
            await waitForAsync(async () => (await methodsOf(a)).includes('Pause')),
            JSON.stringify(await methodsOf(a)));
        await waitFor(() => !service.playback?.playing);
        await pressKeys(Clutter.KEY_space);
        await waitFor(() => service.playback?.playing);

        // H8
        await waitFor(() => service.ticking, 2000);
        const before = seconds(view._elapsed.text);
        await sleep(2200);
        const after = seconds(view._elapsed.text);
        check('media: the elapsed time advances while playing (about 2 s in 2.2 s)',
            after - before >= 1 && after - before <= 3 && service.ticking, `${before} -> ${after}`);

        // H4
        await clearCalls(a);
        await clickActor(view.playButton);
        const paused = await waitFor(() => service.playback?.playing === false, 3000);
        await sleep(500);
        check('media: play/pause by pointer sends Pause; paused shows the play icon, the cover shrinks',
            paused && (await methodsOf(a)).includes('Pause') &&
            view.playButton.child.icon_name === 'media-playback-start-symbolic' &&
            view.playButton.accessible_name === 'Play' && Math.abs(view._art.scale_x - 0.94) < 0.01,
            `icon=${view.playButton.child.icon_name} scale=${view._art.scale_x}`);
        check('media: no tick while paused', service.ticking === false);
        await screenshotTop(outDir, 'media-paused', 320);
        await clickActor(view.playButton);
        await waitFor(() => service.playback?.playing, 3000);

        // H5
        await clearCalls(a);
        await clickActor(view.nextButton);
        await sleep(SETTLE_MS);
        await clickActor(view.previousButton);
        await sleep(SETTLE_MS);
        check('media: Next and Previous by pointer reach the player',
            JSON.stringify((await methodsOf(a)).filter(m => m !== 'HTTP')) === '["Next","Previous"]',
            JSON.stringify(await methodsOf(a)));
        await fakeSet(a, {CanGoNext: false});
        check('media: CanGoNext false hides Next', await waitFor(() => !view.nextButton.visible) &&
            view.previousButton.visible);
        await fakeSet(a, {CanGoNext: true});
        await waitFor(() => view.nextButton.visible);

        // H6
        await fakeSet(a, {PlaybackStatus: 'Paused'});
        await fakeSeeked(a, 18e6);
        await waitFor(() => Math.abs(view.slider.value - 0.1) < 0.01);
        await clearCalls(a);
        await dragSlider(view.slider, 0.1, 0.5);
        await sleep(400);
        const seek = (await fakeCalls(a)).find(c => c.method === 'SetPosition');
        check('media: dragging the slider to 50% sends SetPosition(trackid, 90 s)',
            seek && seek.args[0] === '/org/froonty/track/FirstSong' && Math.abs(seek.args[1] - 90e6) <= 2e6,
            JSON.stringify(await fakeCalls(a)));
        await fakeSet(a, {Metadata: song('First Song', {
            'mpris:artUrl': coverUrl('froontya'), 'mpris:trackid': '/org/mpris/MediaPlayer2/TrackList/NoTrack',
        })});
        await fakeSeeked(a, 18e6);
        await waitFor(() => service.playback?.track.trackId === null && Math.abs(view.slider.value - 0.1) < 0.01);
        await clearCalls(a);
        await dragSlider(view.slider, 0.1, 0.5);
        await sleep(400);
        const relative = (await fakeCalls(a)).find(c => c.method === 'Seek');
        check('media: without a track id the slider sends Seek(offset)',
            relative && Math.abs(relative.args[0] - 72e6) <= 3e6, JSON.stringify(await fakeCalls(a)));
        await fakeSet(a, {PlaybackStatus: 'Playing', Metadata: song('First Song', {'mpris:artUrl': coverUrl('froontya')})});
        await waitFor(() => service.playback?.track.trackId !== null && service.playback?.playing);

        // H9
        await fakeSet(a, {Position: 100e6});
        island().collapse();
        await sleep(animationWait());
        check('media: collapsed, no tick', service.ticking === false && !mediaService());
        island().expand();
        await sleep(animationWait());
        view = mediaView();
        service = mediaService();
        check('media: reopened, the position is read afresh (1:40)',
            await waitFor(() => Math.abs(seconds(view._elapsed.text) - 100) <= 2, 3000), view._elapsed.text);

        // H10
        await fakeSeeked(a, 30e6);
        check('media: a Seeked signal moves the time at once (0:30)',
            await waitFor(() => Math.abs(seconds(view._elapsed.text) - 30) <= 1, 500), view._elapsed.text);

        // H11
        await fakeSet(a, {'x-fail': ['Next']});
        await clickActor(view.nextButton);
        check('media: a failed command says "Could not change playback."',
            await waitFor(() => view._artist.text === 'Could not change playback.'), view._artist.text);
        await screenshotTop(outDir, 'media-failed', 320);
        await fakeSet(a, {'x-fail': []});
        await clickActor(view.nextButton);
        check('media: the next command clears it', await waitFor(() => view._artist.text === 'Test Band'),
            view._artist.text);

        // H12
        const context = service.context();
        const oldOwner = context.owner;
        await quitFake(a);
        fakes.splice(fakes.indexOf(a), 1);
        const a2 = await spawnFake('froontya', {args: MUSIC, state: playing('First Song')});
        fakes.push(a2);
        await waitFor(() => service.playback && service.playback.owner !== oldOwner, 5000);
        const sent = await service.next(context);
        await sleep(300);
        check('media: a restarted player is one source; a press from before does not reach it',
            service.sources.length === 1 && service.playback?.owner !== oldOwner && sent === false &&
            !(await methodsOf(a2)).includes('Next'),
            `sources=${service.sources.length} sent=${sent} calls=${JSON.stringify(await methodsOf(a2))}`);

        // H13: two players, the source list
        const b = await spawnFake('froontyb', {args: [...BROWSER, '--omit', 'CanGoNext'],
            state: {PlaybackStatus: 'Paused', Metadata: song('Video One')}});
        fakes.push(b);
        check('media: with two players the source chip shows',
            await waitFor(() => service.sources.length === 2 && view._chip.visible),
            `${service.sources.length}`);
        await clickShown(view._chip);
        await sleep(SETTLE_MS);
        const rows = () => view._pickerRows.get_children();
        check('media: the source list lists Automatic, then each player',
            view.pickerOpen && rows().map(r => r.accessible_name).join(',') === 'Automatic,Test Music,Test Browser',
            rows().map(r => r.accessible_name).join(','));
        await screenshotTop(outDir, 'media-picker', 320);
        await clickShown(rows()[2] ?? view._chip);
        check('media: picking a player by pointer shows it (its Next shows: CanGoNext missing)',
            await waitFor(() => service.playback?.key === b.name && view._title.text === 'Video One') &&
            !view.pickerOpen && service.chosenKey === b.name && view.nextButton.visible,
            `${service.playback?.key} next=${view.nextButton.visible}`);
        await clickShown(view._chip);
        await sleep(SETTLE_MS);
        rows()[1].grab_key_focus();
        await pressKeys(Clutter.KEY_Return);
        check('media: picking a player by keyboard', await waitFor(() => service.playback?.key === a2.name) &&
            service.chosenKey === a2.name);
        await clickShown(view._chip);
        await sleep(SETTLE_MS);
        await clickShown(rows()[0] ?? view._chip);
        check('media: Automatic restores the automatic choice', await waitFor(() => service.automatic) &&
            service.playback?.key === a2.name);
        await clickShown(view._chip);
        await sleep(SETTLE_MS);
        await pressKeys(Clutter.KEY_Escape);
        check('media: Escape closes the source list first, the island stays',
            !view.pickerOpen && island().expanded);
        await pressKeys(Clutter.KEY_Escape);
        await sleep(animationWait());
        check('media: then Escape closes the island', !island().expanded);
        island().expand();
        await sleep(animationWait());
        view = mediaView();
        service = mediaService();
        await waitFor(() => service.ready && service.playback);

        // H14: the automatic choice
        await fakeSet(a2, {PlaybackStatus: 'Playing'});
        await sleep(100);
        await fakeSet(b, {PlaybackStatus: 'Playing'});
        check('media: a playing music player beats a playing browser',
            await waitFor(() => service.playback?.key === a2.name && service.sources.every(x => x.playing)));
        await fakeSet(a2, {PlaybackStatus: 'Paused'});
        check('media: with browsers followed, the latest to play wins',
            await waitFor(() => service.playback?.key === b.name), service.playback?.key);
        s.set_boolean('media-include-other-players', false);
        check('media: with browsers not followed, paused music beats a playing browser',
            await waitFor(() => service.playback?.key === a2.name), service.playback?.key);
        s.reset('media-include-other-players');
        await waitFor(() => service.playback?.key === b.name);
        await fakeSet(b, {PlaybackStatus: 'Paused'});
        await fakeSet(a2, {PlaybackStatus: 'Playing'});
        await waitFor(() => service.playback?.key === a2.name);

        // H15: a gap between songs
        let blank = false;
        const watchId = service.connect('changed', () => {
            blank ||= view._idle.visible || !service.playback;
        });
        await fakeSet(a2, {Metadata: {}});
        await sleep(600);
        await fakeSet(a2, {Metadata: song('Second Song')});
        await waitFor(() => view._title.text === 'Second Song');
        service.disconnect(watchId);
        check('media: a player that clears its song for under 1 s never shows "Nothing playing"',
            !blank && view._title.text === 'Second Song');

        // H16: size settings, extras
        s.set_int('media-height', 300);
        await sleep(animationWait());
        const [, tall] = pill().get_transformed_size();
        s.reset('media-height');
        await sleep(animationWait());
        await clickActor(view.lyricsChip);
        await sleep(animationWait() + 200);
        const [, withExtras] = pill().get_transformed_size();
        check('media: the size settings apply; lyrics grow the island by 224',
            tall === 300 * scale() && withExtras === (248 + 224) * scale() && view.extra === 'lyrics',
            `tall=${tall} extras=${withExtras}`);
        await screenshotTop(outDir, 'media-lyrics-open', 520);
        await clickActor(view.lyricsChip);
        await sleep(animationWait() + 200);
        check('media: closing them shrinks it back', pill().get_transformed_size()[1] === 248 * scale() &&
            view.extra === null);
        await screenshotTop(outDir, 'media-after-extras', 320);
    } finally {
        for (const fake of fakes)
            await quitFake(fake);
        s.reset('media-include-other-players');
        s.reset('media-height');
        await leaveMediaTab();
    }
}

async function testMediaPill(outDir) {
    mediaWork = outDir;
    const s = settings();
    const fakes = [];
    let liftedAnimations = false;
    const iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
    try {
        island().collapse();
        await sleep(animationWait());
        const [baseWidth] = pill().get_transformed_size();
        const a = await spawnFake('froontypill', {args: MUSIC, state: {
            ...playing('Pill Song', {'mpris:artUrl': coverUrl('froontypill')}), Position: 20e6,
        }});
        fakes.push(a);
        const acc = accessory();
        // H17
        const shown = await waitFor(() => acc?.showing && acc.leading.opacity === 255 && acc._art.hasImage, 5000);
        await sleep(animationWait());
        const time = boxOf(island()._collapsedView._timeLabel);
        const p = boxOf(pill());
        const content = island()._collapsedContentWidth();
        check('media: playing, the collapsed pill shows the cover and the bars beside the time',
            shown && acc.leading.visible && acc.trailing.visible && acc._bars.visible,
            `showing=${acc?.showing} opacity=${acc?.leading.opacity}`);
        check('media: the time stays centered (±1 px)',
            Math.abs((time.x1 + time.x2) / 2 - (p.x1 + p.x2) / 2) <= 1,
            `time=${(time.x1 + time.x2) / 2} pill=${(p.x1 + p.x2) / 2}`);
        const expected = island()._geometry.collapsedSize(content).width;
        check('media: the pill is wider only when needed',
            p.x2 - p.x1 === expected && (content > baseWidth || expected === baseWidth),
            `width=${p.x2 - p.x1} base=${baseWidth} content=${content}`);
        const covers = pillCoversClock();
        check('media: with music, the pill still covers the top bar clock', covers.ok, covers.detail);
        await screenshotTop(outDir, 'media-pill', 80);
        // H18
        check('media: the pill\'s accessible name includes the song',
            pill().accessible_name.includes('playing “Pill Song” by Test Band'), pill().accessible_name);

        // H20: a new song's notice
        await fakeSet(a, {Metadata: song('Next Up', {'mpris:artUrl': coverUrl('froontypill')})});
        await sleep(200);
        check('media: no notice before 0.5 s', !acc.peekText);
        check('media: a new song shows "Title · Artist" on the pill',
            await waitFor(() => acc.peekText === 'Next Up · Test Band', 1500) &&
            island()._collapsedView._peekLabel.visible, `${acc.peekText}`);
        await sleep(300);
        await screenshotTop(outDir, 'media-pill-peek', 80);
        check('media: the notice goes after 3 s', await waitFor(() => !acc.peekText, 3500) &&
            !island()._collapsedView._peekLabel.visible);
        const peeks = [];
        const peekId = acc.connect('changed', () => {
            if (acc.peekText && peeks.at(-1) !== acc.peekText)
                peeks.push(acc.peekText);
        });
        for (const title of ['Skip One', 'Skip Two', 'Skip Three']) {
            // eslint-disable-next-line no-await-in-loop
            await fakeSet(a, {Metadata: song(title)});
            // eslint-disable-next-line no-await-in-loop
            await sleep(120);
        }
        await sleep(1200);
        acc.disconnect(peekId);
        check('media: three quick changes give one notice, for the last',
            peeks.length === 1 && peeks[0] === 'Skip Three · Test Band', JSON.stringify(peeks));
        await waitFor(() => !acc.peekText, 4000);

        // H21: a click opens the Media tab
        s.set_string('hub-last-tab', 'clock');
        await sleep(SETTLE_MS);
        await clickAt(...pillCenter());
        await sleep(animationWait());
        check('media: a click on the pill with music opens the Media tab',
            island().expanded && island()._hub.activeFeature?.id === 'media');
        await clickActor(tabButton('clock'));
        await sleep(animationWait());
        island().collapse();
        await sleep(animationWait());
        s.set_boolean('media-pill-opens-tab', false);
        await waitFor(() => accessory()?.showing);
        await clickAt(...pillCenter());
        await sleep(animationWait());
        check('media: with media-pill-opens-tab off, the last tab opens',
            island().expanded && island()._hub.activeFeature?.id === 'clock');
        s.reset('media-pill-opens-tab');
        island().collapse();
        await sleep(animationWait());
        await waitFor(() => accessory()?.showing);

        // H22: swipes
        await movePointerTo(...pillCenter());
        const swipe = async dx => {
            for (let i = 0; i < 6; i++) {
                pointer.notify_scroll_continuous(now(), dx / 6, 0,
                    Clutter.ScrollSource.FINGER, Clutter.ScrollFinishFlags.NONE);
                // eslint-disable-next-line no-await-in-loop
                await sleep(16);
            }
            pointer.notify_scroll_continuous(now(), 0, 0, Clutter.ScrollSource.FINGER,
                Clutter.ScrollFinishFlags.HORIZONTAL | Clutter.ScrollFinishFlags.VERTICAL);
            await sleep(SETTLE_MS);
        };
        await clearCalls(a);
        await swipe(-60);
        const left = await methodsOf(a);
        await clearCalls(a);
        await swipe(60);
        const right = await methodsOf(a);
        await clearCalls(a);
        await swipe(-20);
        const small = await methodsOf(a);
        check('media: two fingers left on the pill: Next; right: Previous; 20 px: nothing',
            JSON.stringify(left) === '["Next"]' && JSON.stringify(right) === '["Previous"]' &&
            small.length === 0, `${JSON.stringify(left)} ${JSON.stringify(right)} ${JSON.stringify(small)}`);

        // H23: animations off, strip hidden. The headless Shell renders in
        // software, so GNOME Shell inhibits animations (main.js
        // _shouldEnableAnimations); lifted here only, and put back.
        if (!St.Settings.get().enable_animations) {
            St.Settings.get().uninhibit_animations();
            liftedAnimations = true;
        }
        const bars = () => accessory()._bars._bars;
        await waitFor(() => accessory()?.showing);
        const barsState = () => {
            const b = accessory()._bars;
            return `moving=${b.moving} animations=${St.Settings.get().enable_animations} ` +
                `mapped=${b.mapped} playing=${b._playing} enabled=${b._enabled} ` +
                `transitions=${bars().map(bar => Boolean(bar.get_transition('scale-y')))}`;
        };
        check('media: the bars move while playing', accessory()._bars.moving &&
            bars().some(bar => bar.get_transition('scale-y')), barsState());
        iface.set_boolean('enable-animations', false);
        await sleep(SETTLE_MS);
        check('media: with GNOME\'s animations off, the bars stand still',
            !accessory()._bars.moving && bars().every(bar => !bar.get_transition('scale-y')));
        iface.reset('enable-animations');
        await sleep(SETTLE_MS);
        strip().hide();
        await sleep(SETTLE_MS);
        check('media: over a fullscreen window (strip hidden) the bars stop',
            !accessory()._bars.moving && bars().every(bar => !bar.get_transition('scale-y')));
        strip().show();
        await sleep(animationWait());
        if (liftedAnimations)
            St.Settings.get().inhibit_animations();
        liftedAnimations = false;

        // H19: paused
        await fakeSet(a, {PlaybackStatus: 'Paused'});
        check('media: paused, the music leaves the pill and its width returns',
            await waitFor(() => !accessory().showing && !accessory().leading.visible, 3000) &&
            await waitFor(() => pill().get_transformed_size()[0] === baseWidth, 2000),
            `width=${pill().get_transformed_size()[0]} base=${baseWidth}`);

        // H24: covers from the internet
        const shared = await mediaShared();
        check('media: with the default settings no web session was ever made',
            shared.sharedMedia()?.fetcher.session === null);
        const web = await spawnFake('froontyweb', {args: [...MUSIC, '--http']});
        fakes.push(web);
        const [, portBytes] = GLib.file_get_contents(GLib.build_filenamev([outDir, 'fake-froontyweb.port']));
        const port = Number(new TextDecoder().decode(portBytes));
        await fakeSet(a, {PlaybackStatus: 'Paused'});
        await fakeSet(web, playing('Web Song', {'mpris:artUrl': `http://127.0.0.1:${port}/cover.png`}));
        const media = shared.sharedMedia();
        await waitFor(() => media.playback?.key === web.name && accessory().showing, 3000);
        await sleep(800);
        const httpCount = async () => (await methodsOf(web)).filter(m => m === 'HTTP').length;
        check('media: a web cover is not fetched while that is off (placeholder)',
            await httpCount() === 0 && media.art.state === 'blocked' && !accessory()._art.hasImage,
            `requests=${await httpCount()} art=${media.art.state}`);
        s.set_boolean('media-remote-art', true);
        check('media: turned on, it is fetched once',
            await waitFor(() => media.art.state === 'ready', 4000) && await httpCount() === 1,
            `requests=${await httpCount()} art=${media.art.state}`);
        s.set_boolean('media-remote-art', false);
        await sleep(800);
        check('media: turned off again, no request and the web cover goes',
            await httpCount() === 1 && media.art.state === 'blocked', `requests=${await httpCount()}`);
        s.reset('media-remote-art');
    } finally {
        for (const fake of fakes)
            await quitFake(fake);
        iface.reset('enable-animations');
        if (liftedAnimations)
            St.Settings.get().inhibit_animations();
        strip()?.show();
        for (const key of ['media-pill-opens-tab', 'media-remote-art'])
            s.reset(key);
        s.set_string('hub-last-tab', 'clock');
        await sleep(animationWait());
    }
}

async function testMediaExtras(outDir) {
    mediaWork = outDir;
    const s = settings();
    const fakes = [];
    try {
        // H25, H28: up next
        const q = await spawnFake('froontyqueue', {args: [...MUSIC, '--track-list'], state: {
            'x-tracks': [1, 2, 3].map(i => song(`Queue ${i}`, {'mpris:trackid': `/org/froonty/q/${i}`})),
        }});
        fakes.push(q);
        await fakeSet(q, playing('Queue 1', {'mpris:trackid': '/org/froonty/q/1'}));
        await openMediaTab();
        const view = mediaView();
        const service = mediaService();
        await waitFor(() => service.playback?.track.title === 'Queue 1', 3000);
        await clickActor(view.queueChip);
        await sleep(animationWait());
        const queue = view.panel('queue');
        check('media: Up next lists the songs after the current one',
            await waitFor(() => queue.client.state === 'ready', 3000) &&
            queue.client.rows.map(r => `${r.offset} ${r.title}`).join(',') === '1 Queue 2,2 Queue 3',
            `${queue.client.state} ${JSON.stringify(queue.client.rows)}`);
        await screenshotTop(outDir, 'media-queue', 520);
        await clearCalls(q);
        const play = queue._rows.get_children()[1].get_children().at(-1);
        await clickShown(play);
        check('media: "Play now" sends GoTo and the switch is seen',
            await waitFor(() => service.playback?.track.title === 'Queue 3', 3000) &&
            JSON.stringify((await fakeCalls(q)).find(c => c.method === 'GoTo')?.args) === '["/org/froonty/q/3"]',
            JSON.stringify(await fakeCalls(q)));
        await sleep(1700);
        check('media: no "did not switch" notice after a switch', queue.client.notice === null);
        await pressKeys(Clutter.KEY_Escape);
        await sleep(animationWait());
        check('media: Escape closes Up next, the island stays', view.extra === null && island().expanded &&
            !queue.client.subscribed);
        await pressKeys(Clutter.KEY_Escape);
        await sleep(animationWait());
        check('media: Escape again closes the island', !island().expanded);
        await quitFake(q);

        // Without a TrackList
        const plain = await spawnFake('froontyplain', {args: MUSIC, state: {
            ...playing('Plain Song', {
                'xesam:asText': '[00:01.00]Line one\n[00:10.00]Line two\n[00:20.00]Line three',
            }),
        }});
        fakes.push(plain);
        await openMediaTab();
        const v2 = mediaView();
        const s2 = mediaService();
        await waitFor(() => s2.playback?.track.title === 'Plain Song', 3000);
        await clickActor(v2.queueChip);
        await sleep(animationWait());
        check('media: a player without a TrackList says it shares no upcoming songs',
            await waitFor(() => v2.panel('queue').client.state === 'unsupported') &&
            v2.panel('queue')._message.text.text === 'This player does not share its upcoming songs.');

        // H26: lyrics from xesam:asText
        await clickActor(v2.lyricsChip);
        await sleep(animationWait());
        await fakeSet(plain, {PlaybackStatus: 'Paused'});
        await fakeSeeked(plain, 10.5e6);
        const lyrics = v2.panel('lyrics');
        check('media: the player\'s LRC lyrics show, the current line follows the position',
            await waitFor(() => lyrics.service.state === 'ready' && lyrics.activeLine === 1, 3000),
            `${lyrics.service.state} line=${lyrics.activeLine}`);
        await screenshotTop(outDir, 'media-lyrics', 520);
        for (let i = 0; i < 4; i++)
            // eslint-disable-next-line no-await-in-loop
            await clickShown(lyrics.later);
        check('media: Later shifts them (+1.00: line one again)',
            await waitFor(() => lyrics.activeLine === 0) && lyrics.reset.label === '+1.00', lyrics.reset.label);
        await clickShown(lyrics.reset);
        for (let i = 0; i < 4; i++)
            // eslint-disable-next-line no-await-in-loop
            await clickShown(lyrics.earlier);
        await fakeSeeked(plain, 9.5e6);
        check('media: Earlier shifts them the other way (−1.00 at 9.5 s: line two)',
            await waitFor(() => lyrics.activeLine === 1) && lyrics.reset.label === '−1.00', lyrics.reset.label);
        await clickActor(v2.lyricsChip);
        await sleep(animationWait());
        await quitFake(plain);

        // H27: online lyrics, only when allowed
        const web = await spawnFake('froontylrc', {args: [...MUSIC, '--http'], state: playing('Web Lyrics')});
        fakes.push(web);
        const [, portBytes] = GLib.file_get_contents(GLib.build_filenamev([outDir, 'fake-froontylrc.port']));
        GLib.setenv('FROONTY_LRCLIB_URL', `http://127.0.0.1:${Number(new TextDecoder().decode(portBytes))}/api/get`, true);
        await waitFor(() => s2.playback?.track.title === 'Web Lyrics', 3000);
        await clickActor(v2.lyricsChip);
        await sleep(animationWait());
        const panel = v2.panel('lyrics');
        await waitFor(() => panel.service.state === 'consent', 3000);
        const requests = async () => (await fakeCalls(web)).filter(c => c.method === 'HTTP').map(c => c.args[0]);
        check('media: online lookups off: the consent switch, and no request',
            panel.service.state === 'consent' && panel._consent.visible && (await requests()).length === 0,
            `${panel.service.state} ${JSON.stringify(await requests())}`);
        await screenshotTop(outDir, 'media-lyrics-consent', 520);
        await clickShown(panel._consent);
        check('media: allowed, lrclib is asked with the song, and its lines show',
            await waitFor(() => panel.service.state === 'ready', 4000) &&
            (await requests()).some(r => r.includes('track_name=Web Lyrics') && r.includes('artist_name=Test Band') &&
                r.includes('album_name=Test Album') && r.includes('duration=180')) &&
            panel._lines.get_children().some(l => l.text === 'Online one'),
            `${panel.service.state} ${JSON.stringify(await requests())}`);
        await fakeSet(web, {'x-http-delay': 1500});
        await fakeSet(web, {Metadata: song('Slow Lyrics')});
        await waitFor(() => panel.service.state === 'loading', 2000);
        await clickActor(v2.lyricsChip);
        await sleep(2000);
        check('media: hiding the lyrics cancels a slow answer',
            panel.service.lyrics === null && panel.service.state === 'loading');
        s.reset('media-lyrics-online');
        GLib.setenv('FROONTY_LRCLIB_URL', 'http://127.0.0.1:9/api/get', true);

        // H29: the volume row
        const mixer = Volume.getMixerControl();
        const sink = mixer.get_default_sink();
        const devices = [...mixer.get_sinks(), ...mixer.get_sources()].map(d => d.name);
        const isolated = devices.length > 0 && devices.every(n => n?.startsWith('froonty-test'));
        if (sink && isolated && v2._volume.ready) {
            const before = sink.is_muted;
            await clickActor(v2._volume.muteButton);
            const muted = await waitFor(() => sink.is_muted !== before);
            await clickActor(v2._volume.muteButton);
            await waitFor(() => sink.is_muted === before);
            const slider = boxOf(v2._volume.slider);
            await clickAt(slider.x1 + (slider.x2 - slider.x1) * 0.3, (slider.y1 + slider.y2) / 2);
            const volume = sink.volume / mixer.get_vol_max_norm();
            check('media: the volume row mutes the test speaker and sets its volume',
                muted && Math.abs(volume - 0.3) < 0.1, `muted=${muted} volume=${volume}`);
            sink.volume = mixer.get_vol_max_norm();
            sink.push_volume();
        } else {
            check('media: the volume row mutes the test speaker and sets its volume', false,
                `not isolated or not ready: ${devices.join(', ')} ready=${v2._volume.ready}`);
        }
    } finally {
        for (const fake of fakes)
            await quitFake(fake);
        s.reset('media-lyrics-online');
        GLib.setenv('FROONTY_LRCLIB_URL', 'http://127.0.0.1:9/api/get', true);
        await leaveMediaTab();
    }
}

async function testMediaPanic(outDir) {
    mediaWork = outDir;
    const s = settings();
    const fakes = [];
    try {
        const a = await spawnFake('froontypa', {args: MUSIC, state: playing('Panic One')});
        const b = await spawnFake('froontypb', {args: BROWSER, state: playing('Panic Two')});
        fakes.push(a, b);
        s.set_strv('panic-buttons', ['pause-media']);
        await sleep(SETTLE_MS);
        island().expand();
        await sleep(animationWait());
        const button = island()._hub._panicBar._buttons[0];
        check('media: "Pause all media" is a panic button',
            button?.actor.accessible_name === 'Pause all media');
        await waitFor(() => button.actor.reactive, 3000);
        await clickActor(button.actor);
        check('media: it pauses every playing player and stays checked',
            await waitFor(() => button.actor.checked, 3000) &&
                (await methodsOf(a)).includes('Pause') && (await methodsOf(b)).includes('Pause'),
            `${JSON.stringify(await methodsOf(a))} ${JSON.stringify(await methodsOf(b))}`);
        await sleep(600);
        await clickActor(button.actor);
        await sleep(600);
        check('media: a second click resumes them and unchecks it',
            !button.actor.checked && (await methodsOf(a)).includes('Play') && (await methodsOf(b)).includes('Play'),
            `${JSON.stringify(await methodsOf(a))} ${JSON.stringify(await methodsOf(b))}`);
        await screenshotTop(outDir, 'media-panic');
    } finally {
        for (const fake of fakes)
            await quitFake(fake);
        s.reset('panic-buttons');
        island().collapse();
        await sleep(animationWait());
    }
}
// ================================================================ end of media

// H31-H33 helpers: the footprint counts the shared service's holders.
let mediaSharedModule = null;

async function testMediaChoiceSurvivesLock() {
    mediaWork ??= GLib.get_tmp_dir();
    const s = settings();
    const fakes = [];
    try {
        const a = await spawnFake('froontylocka', {args: MUSIC, state: playing('Lock One')});
        const b = await spawnFake('froontylockb', {args: BROWSER, state: {PlaybackStatus: 'Paused', Metadata: song('Lock Two')}});
        fakes.push(a, b);
        const media = mediaSharedModule.sharedMedia();
        await waitFor(() => media.sources.length === 2, 3000);
        media.select(b.name);
        await waitFor(() => media.playback?.key === b.name);
        // A screen lock runs disable(); unlock runs enable().
        await setExtensionEnabled(false);
        const gone = mediaSharedModule.sharedMedia() === null && mediaSharedModule.mediaUsers() === 0;
        await setExtensionEnabled(true);
        const again = mediaSharedModule.sharedMedia();
        check('media: the chosen player survives a lock (disable, enable)',
            gone && await waitFor(() => again?.ready && again.playback?.key === b.name, 4000) &&
            again.chosenKey === b.name, `gone=${gone} chosen=${again?.chosenKey} shown=${again?.playback?.key}`);
        again.select(null);
        s.set_boolean('media-enabled', false);
        await sleep(SETTLE_MS);
        check('media: turned off live, the tab, the pill\'s music and the service go',
            !tabButton('media') && island()._accessory === null && mediaSharedModule.sharedMedia() === null,
            `tab=${Boolean(tabButton('media'))} accessory=${Boolean(island()._accessory)}`);
        s.reset('media-enabled');
        await sleep(SETTLE_MS);
        check('media: turned on again, they come back', Boolean(tabButton('media')) &&
            island()._accessory !== null && mediaSharedModule.sharedMedia() !== null);
    } finally {
        for (const fake of fakes)
            await quitFake(fake);
        s.reset('media-enabled');
        await sleep(SETTLE_MS);
    }
}

// ---------------------------------------------------------------- break
//
// The Break tab (docs/features/break.md) against GNOME's real break engine
// (Main.breakManager): the offer, the pill's cue (no expand, no grab), Take,
// Delay and Skip, GNOME's notifications off and given back, the sit/stand
// tracker, its panic button, the state file and the lock rule. GNOME's
// break settings are the private keyfile's only (checked first). A
// self-contained block.

const BREAK_SCHEMA = 'org.gnome.desktop.break-reminders';
const WELLBEING = {
    schema_id: 'org.gnome.desktop.notifications.application',
    path: '/org/gnome/desktop/notifications/application/gnome-wellbeing-panel/',
};
const breakEntry = () => island()?._hub._entries.get('break') ?? null;
const breakView = () => breakEntry()?.view ?? null;
const breakCueSource = () => island()?._cueSources.get('break')?.source ?? null;
const breakService = () => breakCueSource()?._service ?? null;
const breakCue = () => breakCueSource()?.current() ?? null;
// The cue the collapsed pill shows (not just what it would compute now).
const pillCueLevel = level =>
    island()?._collapsedView._cue.has_style_class_name(`froonty-pill-cue-level-${level}`) ?? false;
// GNOME's own break notification source (misc/breakManager.js), in the
// message tray or not.
const breakSourceInTray = () => {
    const source = Main.breakManagerDispatcher?._notificationSource?._source ?? null;
    return source !== null && Main.messageTray.getSources().includes(source);
};

function resetKeys(settings) {
    for (const key of settings.settings_schema.list_keys())
        settings.reset(key);
}

// Input once a second (a pointer nudge low on the primary monitor, away
// from the island, the dock and the top bar) until `predicate` holds.
async function keepActive(timeoutMs, predicate = () => false) {
    const monitor = Main.layoutManager.primaryMonitor;
    const x = monitor.x + Math.round(monitor.width / 2);
    const y = monitor.y + monitor.height - 60;
    for (let waited = 0; waited <= timeoutMs; waited += 250) {
        if (waited % 1000 === 0)
            pointer.notify_absolute_motion(now(), x + (waited % 2000 ? 2 : 0), y);
        if (predicate())
            return true;
        await sleep(250);
    }
    return predicate();
}

async function openBreakTab() {
    if (!island().expanded) {
        island().expand();
        await sleep(animationWait());
    }
    if (island()._hub.activeFeature?.id !== 'break') {
        await clickActor(tabButton('break'));
        await sleep(animationWait());
    }
}

// Scrolls the Break tab so `actor` is on screen (to click it).
async function scrollIntoView(view, actor) {
    const [, y] = actor.get_transformed_position();
    const [, listY] = view._list.get_transformed_position();
    const adjustment = view._scroll.vadjustment;
    adjustment.value = Math.max(0, Math.min(adjustment.upper - adjustment.page_size, y - listY - 20));
    await sleep(SETTLE_MS);
}

// The rectangle's pixels, through a screenshot.
async function areaPixbuf(outDir, name, b) {
    const path = GLib.build_filenamev([outDir, `${name}.png`]);
    const stream = Gio.File.new_for_path(path).replace(null, false, Gio.FileCreateFlags.NONE, null);
    await new Shell.Screenshot().screenshot_area(Math.round(b.x1), Math.round(b.y1),
        Math.round(b.x2 - b.x1), Math.round(b.y2 - b.y1), stream);
    stream.close(null);
    return GdkPixbuf.Pixbuf.new_from_file(path);
}

// Mean colour difference of two same-size pictures, the second one read
// flipped left to right when `flip`.
function pixelDifference(a, b, flip) {
    const [pa, pb] = [a.get_pixels(), b.get_pixels()];
    const w = Math.min(a.get_width(), b.get_width());
    const h = Math.min(a.get_height(), b.get_height());
    let sum = 0;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = y * a.get_rowstride() + x * a.get_n_channels();
            const j = y * b.get_rowstride() + (flip ? w - 1 - x : x) * b.get_n_channels();
            sum += Math.abs(pa[i] - pb[j]) + Math.abs(pa[i + 1] - pb[j + 1]) + Math.abs(pa[i + 2] - pb[j + 2]);
        }
    }
    return sum / (3 * w * h);
}

const inset = (b, n) => ({x1: b.x1 + n, y1: b.y1 + n, x2: b.x2 - n, y2: b.y2 - n});

async function testBreak(outDir) {
    const [isolated, where] = privacyIsIsolated(outDir);
    check('break: GNOME\'s break and notification settings are the private test copy', isolated, where);
    if (!isolated)
        return;

    const s = settings();
    const breaks = new Gio.Settings({schema_id: BREAK_SCHEMA});
    const eyes = new Gio.Settings({schema_id: `${BREAK_SCHEMA}.eyesight`});
    const movement = new Gio.Settings({schema_id: `${BREAK_SCHEMA}.movement`});
    const wellbeing = new Gio.Settings(WELLBEING);
    const gnomeKeys = [breaks, eyes, movement, wellbeing];
    const wellbeingUser = () => wellbeing.get_user_value('enable')?.print(true) ?? null;
    const lastEnd = () => Main.breakManager._breakLastEnd.get('eyesight');
    gnomeKeys.forEach(resetKeys);
    // Short eye breaks, so the checks wait seconds, not minutes.
    eyes.set_uint('interval-seconds', 14);
    eyes.set_uint('duration-seconds', 10);
    eyes.set_uint('delay-seconds', 10);
    movement.set_uint('interval-seconds', 3600);
    const modalBefore = Main.modalCount;

    try {
        check('break: off by default: no tab, no cue, GNOME\'s breaks and notifications untouched',
            !tabButton('break') && !island()._collapsedView.hasCue &&
            breaks.get_strv('selected-breaks').length === 0 && wellbeingUser() === null,
            `tab=${Boolean(tabButton('break'))} cue=${island()._collapsedView.hasCue} ` +
            `selected=${breaks.get_strv('selected-breaks')} wellbeing=${wellbeingUser()}`);

        s.set_boolean('break-enabled', true);
        await waitFor(() => breakService()?.loaded);
        check('break: turning it on adds the tab and writes nothing to GNOME',
            Boolean(tabButton('break')) && breaks.get_strv('selected-breaks').length === 0 &&
            wellbeingUser() === null && s.get_string('break-gnome-saved') === '');

        await openBreakTab();
        const view = breakView();
        check('break: GNOME\'s breaks are off, so the tab offers to turn them on',
            view?._offer.visible && view._offerButton.visible && !view._status.visible &&
            view._offerText.text.includes('GNOME’s break reminders are off'),
            `offer=${view?._offer.visible} text=${view?._offerText.text}`);
        await screenshotTop(outDir, 'break-offer', 540);

        await clickActor(view._offerButton);
        await waitFor(() => Main.breakManager.state !== 0);
        check('break: the offer turns on GNOME\'s eye and movement breaks; Froonty reminds instead',
            breaks.get_strv('selected-breaks').join() === 'eyesight,movement' &&
            Main.breakManager.state === 1 && !wellbeing.get_boolean('enable') &&
            JSON.parse(s.get_string('break-gnome-saved') || '{}')['wellbeing/enable']?.user === null,
            `selected=${breaks.get_strv('selected-breaks')} state=${Main.breakManager.state} ` +
            `enable=${wellbeing.get_boolean('enable')} saved=${s.get_string('break-gnome-saved')}`);

        // Another tab, so the pill's click has to come back to Break.
        await clickActor(tabButton('clock'));
        island().collapse();
        await sleep(animationWait());

        const due = await keepActive(20000, () => pillCueLevel(2));
        await sleep(animationWait());
        const cue = breakCue();
        const time = boxOf(island()._collapsedView._timeLabel);
        const pillBox = boxOf(pill());
        const covers = pillCoversClock();
        check('break: a due break shows a cue on the collapsed pill; nothing opens or grabs',
            due && island()._collapsedView.hasCue && !island().expanded &&
            Main.modalCount === modalBefore && pill().accessible_name.includes('Eye break due') &&
            island()._collapsedView._cue.has_style_class_name('froonty-pill-cue-level-2'),
            `due=${due} cue=${JSON.stringify(cue && {level: cue.level, text: cue.accessibleText})} ` +
            `expanded=${island().expanded} modal=${Main.modalCount} name=${pill().accessible_name}`);
        check('break: GNOME\'s break notification is not in the tray; no unread dots',
            !breakSourceInTray() && !gnomeUnreadDot() && !pillUnreadDot(),
            `tray=${breakSourceInTray()} gnomeDot=${gnomeUnreadDot()} pillDot=${pillUnreadDot()}`);
        check('break: the cue keeps the pill over the clock and the time centred',
            covers.ok && Math.abs((time.x1 + time.x2) / 2 - (pillBox.x1 + pillBox.x2) / 2) <= 1,
            `${covers.detail} time=[${time.x1},${time.x2}]`);
        await screenshotTop(outDir, 'break-cue-due', 120);

        // GNOME switches to BREAK_DUE up to a second after the due time.
        await keepActive(3000, () => Main.breakManager.state === 4);
        await clickActor(pill());
        await sleep(animationWait());
        check('break: clicking the pill opens the Break tab with Take, Delay and Skip',
            island().expanded && island()._hub.activeFeature?.id === 'break' &&
            view.takeButton.visible && view.delayButton.visible && view.skipButton.visible,
            `tab=${island()._hub.activeFeature?.id} take=${view.takeButton.visible} ` +
            `delay=${view.delayButton.visible} skip=${view.skipButton.visible}`);
        await screenshotTop(outDir, 'break-due-tab', 540);

        const before = lastEnd();
        await clickActor(view.delayButton);
        const level = breakService().model().level.level;
        check('break: Delay moves the break by 10 s; the cue drops below due; one delay today',
            Math.abs(lastEnd() - before - 10) <= 1 && level <= 1 &&
            breakService().state.today.eyesight.delayed === 1,
            `moved=${lastEnd() - before} level=${level} today=${JSON.stringify(breakService().state.today.eyesight)}`);

        await keepActive(15000, () => Main.breakManager.state === 4 && view.skipButton.visible);
        await clickActor(view.skipButton);
        check('break: Skip when due: GNOME is ACTIVE again, one skip today',
            Main.breakManager.state === 1 && breakService().state.today.eyesight.skipped === 1,
            `state=${Main.breakManager.state} today=${JSON.stringify(breakService().state.today.eyesight)}`);

        island().collapse();
        await sleep(animationWait());
        const overdue = await keepActive(20000, () => pillCueLevel(3));
        check('break: after a delay and a skip in a row, the next one is overdue at once (level 3)',
            overdue && breakCue()?.level === 3,
            `cue=${JSON.stringify(breakCue())}`);
        await screenshotTop(outDir, 'break-cue-overdue', 120);

        await keepActive(15000, () => Main.breakManager.state === 4);
        await clickActor(pill());
        await sleep(animationWait());
        const brightness = () => Main.layoutManager.uiGroup.get_effect('brightness');
        await clickActor(view.takeButton);
        const dimmed = await waitFor(() => brightness()?.enabled === true, 4000);
        check('break: Take collapses the island and GNOME dims the screen',
            dimmed && !island().expanded, `dimmed=${dimmed} expanded=${island().expanded}`);
        await sleep(1500);
        await screenshotTop(outDir, 'break-take-dim', 120);

        // Away for 12 s (more than the 10 s break), then back.
        const takenBefore = breakService().state.today.eyesight.taken;
        await sleep(12500);
        await movePointerTo(...pillCenter());
        await sleep(SETTLE_MS);
        const after = breakService().model();
        check('break: 12 s away, then back: the eye break is taken, the cue drops, no dimming',
            breakService().state.today.eyesight.taken === takenBefore + 1 &&
            after.level.level <= 1 && !brightness()?.enabled,
            `taken=${breakService().state.today.eyesight.taken} level=${after.level.level} ` +
            `dim=${brightness()?.enabled}`);

        // Hold breaks off for the rest, so the tab holds still.
        eyes.set_uint('interval-seconds', 3600);
        s.set_boolean('posture-enabled', true);
        await openBreakTab();
        await scrollIntoView(view, view.standingButton);
        await clickActor(view.standingButton);
        const standing = breakService().model().today.standingSeconds;
        check('break: clicking Standing checks it; the posture is standing',
            breakService().state.posture.mode === 'standing' && view.standingButton.checked &&
            !view.sittingButton.checked);
        await keepActive(4000);
        const gained = breakService().model().today.standingSeconds - standing;
        check('break: 4 s at the computer standing adds at least 3 s of standing', gained >= 3,
            `+${gained.toFixed(1)} s`);
        for (let i = 0; i < 40 && global.stage.key_focus !== view.sittingButton; i++)
            await pressKeys(Clutter.KEY_Tab);
        await pressKeys(Clutter.KEY_space);
        check('break: Tab and Space switch back to sitting',
            breakService().state.posture.mode === 'sitting' && view.sittingButton.checked,
            `focus=${global.stage.key_focus} mode=${breakService().state.posture.mode}`);
        await screenshotTop(outDir, 'break-posture', 540);

        s.set_strv('panic-buttons', ['sit-stand']);
        await sleep(SETTLE_MS);
        const [sitStand] = island()._hub._panicBar._buttons;
        check('break: the "Sitting or standing" panic button is in the bar, named',
            sitStand?.actor.accessible_name === 'Sitting or standing: sitting',
            `${sitStand?.actor.accessible_name}`);
        await clickActor(sitStand.actor);
        const iconPath = sitStand.actor.child.gicon?.get_file?.()?.get_path() ?? '';
        check('break: clicking it stands: checked, the standing pictogram',
            breakService().state.posture.mode === 'standing' && sitStand.actor.checked &&
            iconPath.endsWith('froonty-stand-symbolic.svg'),
            `mode=${breakService().state.posture.mode} checked=${sitStand.actor.checked} icon=${iconPath}`);
        s.reset('panic-buttons');
        await sleep(SETTLE_MS);

        const store = breakService()._store;
        await store.flush();
        const mode = file => file.query_info('unix::mode', Gio.FileQueryInfoFlags.NONE, null)
            .get_attribute_uint32('unix::mode') & 0o777;
        check('break: the state file is 0600 in a 0700 folder under the private data folder',
            store.stateFile.get_path().startsWith(GLib.build_filenamev([outDir, 'data'])) &&
            mode(store.stateFile) === 0o600 && mode(store.folder) === 0o700,
            `${store.stateFile.get_path()} ${mode(store.stateFile).toString(8)} ${mode(store.folder).toString(8)}`);

        // A screen lock: GNOME's notifications stay off under it, and what
        // Froonty counted survives.
        island().collapse();
        await sleep(animationWait());
        const old = breakService();
        const counted = JSON.stringify(old.state.today.eyesight);
        extension().stateObj._isSessionLocked = () => true;
        await setExtensionEnabled(false);
        const oldResources = old.resources;
        await setExtensionEnabled(true);
        delete extension().stateObj._isSessionLocked;
        await waitFor(() => breakService()?.loaded);
        check('break: a screen lock keeps GNOME\'s notifications off; posture and counts survive it',
            !wellbeing.get_boolean('enable') && breakService() !== old &&
            breakService().state.posture.mode === 'standing' &&
            JSON.stringify(breakService().state.today.eyesight) === counted,
            `enable=${wellbeing.get_boolean('enable')} mode=${breakService()?.state.posture.mode} ` +
            `counts=${JSON.stringify(breakService()?.state.today.eyesight)} was ${counted}`);
        check('break: the locked-away service left nothing connected',
            Object.values(oldResources).every(v => !v), JSON.stringify(oldResources));

        await setExtensionEnabled(false);
        const restored = wellbeingUser();
        await setExtensionEnabled(true);
        await sleep(SETTLE_MS);
        check('break: turned off unlocked, Froonty gives GNOME\'s notifications back; on again, takes them',
            restored === null && !wellbeing.get_boolean('enable'),
            `off=${restored} on=${wellbeing.get_boolean('enable')}`);

        s.set_boolean('island-enabled', false);
        await sleep(SETTLE_MS);
        const withoutIsland = wellbeingUser();
        s.reset('island-enabled');
        await sleep(SETTLE_MS);
        check('break: without the island GNOME reminds; with it again, Froonty',
            withoutIsland === null && !wellbeing.get_boolean('enable'),
            `hidden=${withoutIsland} shown=${wellbeing.get_boolean('enable')}`);

        // GNOME reminding: low urgency (its "notify" off), so the
        // notification is not shown as a banner and stays unread.
        eyes.set_boolean('notify', false);
        eyes.set_uint('interval-seconds', 14);
        s.set_boolean('break-pill-reminders', false);
        await sleep(SETTLE_MS);
        const gnomeReminds = wellbeingUser() === null &&
            await keepActive(20000, () => breakSourceInTray() && gnomeUnreadDot() && pillUnreadDot());
        check('break: "Remind me in the island" off: GNOME\'s notification and both dots are back',
            gnomeReminds, `enable=${wellbeingUser()} tray=${breakSourceInTray()} ` +
            `gnomeDot=${gnomeUnreadDot()} pillDot=${pillUnreadDot()}`);
        s.reset('break-pill-reminders');
        await sleep(SETTLE_MS);
        await keepActive(20000, () => Main.breakManager.state === 4);
        check('break: back on: GNOME\'s break notification leaves the tray',
            !wellbeing.get_boolean('enable') && !breakSourceInTray() && !gnomeUnreadDot(),
            `enable=${wellbeing.get_boolean('enable')} tray=${breakSourceInTray()} dot=${gnomeUnreadDot()}`);
        eyes.reset('notify');
        eyes.set_uint('interval-seconds', 3600);
        await keepActive(2000);

        await openBreakTab();
        const view2 = breakView();
        breakService().state.exercise.next = 0;
        view2._showStretch = false;
        view2._exerciseKey = null;
        view2._sync();
        await sleep(SETTLE_MS);
        check('break: with no break near, the tab offers "Show a stretch"',
            Boolean(view2.showStretchButton?.mapped), `${view2._exerciseKey}`);
        await scrollIntoView(view2, view2.showStretchButton);
        const stretchBox = boxOf(view2.showStretchButton);
        await screenshotTop(outDir, 'break-before-stretch', 540);
        await clickActor(view2.showStretchButton);
        await sleep(SETTLE_MS);
        const clickDetail = `expanded=${island().expanded} tab=${island()._hub.activeFeature?.id} ` +
            `button=[${stretchBox.x1},${stretchBox.y1} - ${stretchBox.x2},${stretchBox.y2}] ` +
            `content=${JSON.stringify(boxOf(island()._hub._content))} ` +
            `scroll=${view2._scroll.vadjustment.value}`;
        const card = view2.card;
        const files = card?.frames.map(f => f.icon.gicon.get_file().get_path()) ?? [];
        check('break: the first stretch: Workrave\'s pictures, the second one mirrored',
            card?.exercise.id === 'shoulder-arm-stretch' && files.length === 2 &&
            files.every(f => GLib.file_test(f, GLib.FileTest.EXISTS)) &&
            card.frames[0].icon.scale_x === 1 && card.frames[1].icon.scale_x === -1,
            `${card?.exercise.id} ${files.join(', ')} key=${view2._exerciseKey} ` +
            `exercises=${view2._exercises.length} shown=${view2._showStretch} ${clickDetail}`);
        if (!card)
            throw new Error('no exercise card');
        // Bring the pictures into view.
        const [, cardY] = card.get_transformed_position();
        const [, listY] = view2._list.get_transformed_position();
        view2._scroll.vadjustment.value = cardY - listY;
        await sleep(animationWait());
        const [a, b] = card.frames.map(f => inset(boxOf(f.picture), 3));
        const half = box => (box.x2 - box.x1) / 2;
        const inkMirroredLeft = await inkIn(outDir, 'break-frame-1-left', b.x1, b.y1, half(b), b.y2 - b.y1);
        const inkPlainRight = await inkIn(outDir, 'break-frame-0-right', a.x1 + half(a), a.y1, half(a), a.y2 - a.y1);
        const plain = await areaPixbuf(outDir, 'break-frame-0', a);
        const mirrored = await areaPixbuf(outDir, 'break-frame-1', b);
        const flipped = pixelDifference(plain, mirrored, true);
        const straight = pixelDifference(plain, mirrored, false);
        check('break: the mirrored picture is drawn flipped (ink and pixels)',
            Math.abs(inkMirroredLeft - inkPlainRight) <= 0.15 * Math.max(inkMirroredLeft, inkPlainRight) &&
            flipped < straight / 2,
            `ink ${inkMirroredLeft.toFixed(3)} vs ${inkPlainRight.toFixed(3)}; ` +
            `difference flipped ${flipped.toFixed(1)}, as is ${straight.toFixed(1)}`);
        await screenshotTop(outDir, 'break-card', 540);

        view2._scroll.vadjustment.value = 0;
        await sleep(SETTLE_MS);
        const [w, h] = pill().get_transformed_size();
        const content = boxOf(island()._hub._content);
        const buttons = [];
        const walk = actor => {
            for (const child of actor.get_children()) {
                if (child instanceof St.Button && child.mapped)
                    buttons.push(child);
                walk(child);
            }
        };
        walk(view2.actor);
        const outside = buttons.filter(button => {
            const box = boxOf(button);
            return box.x1 < content.x1 - 0.5 || box.x2 > content.x2 + 0.5;
        });
        const [, listWidth] = view2._list.get_preferred_width(-1);
        check('break: at 440 × 480 every button is inside the tab; nothing scrolls sideways',
            w === 440 * scale() && h === 480 * scale() && buttons.length >= 5 && outside.length === 0 &&
            view2._scroll.hscrollbar_policy === St.PolicyType.NEVER &&
            view2._list.width <= view2._scroll.width + 0.5,
            `${w}x${h} buttons=${buttons.length} outside=${outside.map(x => x.label ?? x.accessible_name)} ` +
            `list=${view2._list.width}/${listWidth} scroll=${view2._scroll.width}`);
        await screenshotTop(outDir, 'break-tab', 540);

        island().collapse();
        await sleep(animationWait());
        s.set_boolean('break-enabled', false);
        await sleep(SETTLE_MS);
        check('break: turned off: GNOME\'s notifications are back, its breaks stay on',
            wellbeingUser() === null && breaks.get_strv('selected-breaks').length === 2 &&
            !tabButton('break') && !island()._collapsedView.hasCue,
            `enable=${wellbeingUser()} selected=${breaks.get_strv('selected-breaks')}`);
    } finally {
        delete extension().stateObj?._isSessionLocked;
        for (const key of ['break-enabled', 'break-pill-reminders', 'posture-enabled', 'panic-buttons'])
            s.reset(key);
        await sleep(SETTLE_MS);
        gnomeKeys.forEach(resetKeys);
        if (island()?.expanded)
            island().collapse();
        await sleep(animationWait());
    }
}

// The public build (FROONTY_EXTENSION_DIR=an unzipped `make pack`, run
// with FROONTY_TEST_ONLY=testPublicBuild): its four tabs and two panic
// buttons only, each tab opens, and enable/disable leaves the Shell as
// it was.
async function testPublicBuild() {
    const hub = island()._hub;
    const names = hub._tabColumn.get_children()
        .map(b => b.accessible_name.replace(/, unread notifications$/, ''));
    check('public build: the tabs are Clock, Calendar, Notifications and Notes',
        names.join(',') === 'Clock,Calendar,Notifications,Notes', names.join(','));
    check('public build: the panic bar has the two mute buttons',
        hub._panicBar.actor.get_n_children() === 2, `${hub._panicBar.actor.get_n_children()}`);
    check('public build: no bar under the pill', island()._pillBars.size === 0);
    island().expand();
    await sleep(animationWait());
    const opened = [];
    for (const id of ['clock', 'calendar', 'notifications', 'notes']) {
        hub.select(id);
        // eslint-disable-next-line no-await-in-loop
        await sleep(SETTLE_MS);
        if (hub.activeFeature?.id === id && hub._entries.get(id)?.view)
            opened.push(id);
    }
    check('public build: every tab opens', opened.length === 4, opened.join(','));
    // The icons the kept tabs load from their own folders.
    const notesView = hub._entries.get('notes')?.view;
    const icons = [hub._entries.get('calendar')?.feature.icon, notesView?._foldUp, notesView?._foldDown]
        .map(icon => icon?.get_file().get_path() ?? 'none');
    const missing = icons.filter(path => !GLib.file_test(path, GLib.FileTest.EXISTS));
    check('public build: the bundled icons are there', missing.length === 0, missing.join(', '));
    hub.select('clock');
    island().collapse();
    await sleep(animationWait());

    check('public build: disable succeeds', await setExtensionEnabled(false), stateName());
    // No feature keeps memory across disable() in this build.
    check('public build: disable drops the in-memory data', extension().stateObj._memory === null,
        JSON.stringify(extension().stateObj._memory));
    const baseline = shellFootprint();
    const failures = [];
    for (let i = 0; i < 10; i++) {
        // eslint-disable-next-line no-await-in-loop
        if (!await setExtensionEnabled(true))
            failures.push(`enable #${i}: ${stateName()}`);
        if (i % 2 === 0) {
            island()?.expand();
            // eslint-disable-next-line no-await-in-loop
            await sleep(40);
        }
        // eslint-disable-next-line no-await-in-loop
        if (!await setExtensionEnabled(false))
            failures.push(`disable #${i}: ${stateName()}`);
    }
    check('public build: 10 enable/disable cycles', failures.length === 0, failures.join('; '));
    const after = shellFootprint();
    const isOurs = actor => /froonty/i.test(actor);
    const scrub = footprint => ({
        ...footprint,
        uiGroupChildren: footprint.uiGroupChildren.filter(isOurs),
        trackedChrome: footprint.trackedChrome.filter(isOurs),
    });
    const [x, y] = [scrub(baseline), scrub(after)];
    check('public build: shell footprint identical after the cycles',
        JSON.stringify(x) === JSON.stringify(y),
        Object.keys(x).filter(k => JSON.stringify(x[k]) !== JSON.stringify(y[k]))
            .map(k => `${k}: ${JSON.stringify(x[k])} -> ${JSON.stringify(y[k])}`).join('; '));
    check('public build: re-enable succeeds', await setExtensionEnabled(true), stateName());
}

// FROONTY_TEST_ONLY=testA,testB runs only those checks (while debugging).
const ONLY_TESTS = {
    testClaudeAttention, testClaudeAttentionWindows, testNotifications, testCalendar,
    testNotes, testMedia, testBreak, testHub, testLifecycle, testPublicBuild,
};

export async function runAll(outDir) {
    results.length = 0;
    const only = GLib.getenv('FROONTY_TEST_ONLY');
    if (only) {
        try {
            testLoaded();
            // A banner from the session's start would hide what is checked;
            // the session starts in the overview, where a window mapping
            // leaves GNOME a 'hidden' handler until it closes.
            await waitFor(() => !Main.messageTray.visible, 15000);
            Main.overview.hide();
            await waitFor(() => !Main.overview.visible && !Main.overview.animationInProgress, 5000);
            for (const name of only.split(','))
                // eslint-disable-next-line no-await-in-loop
                await ONLY_TESTS[name](outDir);
        } catch (e) {
            check('test run completed without exception', false, `${e}\n${e.stack}`);
        }
        return results;
    }
    // Pointer-driven checks move the pointer over the pill; keep hover-open
    // out of their way (testHoverOpen enables it explicitly).
    settings().set_int('hover-open-delay', 0);
    mediaWork = outDir;
    try {
        mediaSharedModule = await mediaShared();
        testLoaded();
        testGeometry();
        await testPointer(outDir);
        await testKeyboard();
        await testHubLayout(outDir);
        await testPanic(outDir);
        await testHubWithoutPanicButtons();
        // The camera panic button is switched off for now (panic/catalog.js).
        // await testPanicCamera(outDir);
        await testHoverOpen();
        await testLauncher();
        await testStartup();
        await testSettingsButton(outDir);
        await testCalendarMenu(outDir);
        await testNotifications(outDir);
        await testNotificationSafeguards(outDir);
        await testClaudeAttention(outDir);
        await testClaudeAttentionWindows(outDir);
        await testClaudeAttentionIsland();
        await testHub(outDir);
        await testNotes(outDir);
        await testNotesTabsAndColors(outDir);
        await testNotesHeader(outDir);
        await testAllNotesWindow(outDir);
        await testSettingsViewKey();
        await testLabelMenuLifecycle();
        await testClaude(outDir);
        await testClipboard(outDir);
        await testWriting(outDir);
        await testWritingFixes(outDir);
        await testKillProcess(outDir);
        await testCalendar(outDir);
        await testBreak(outDir);
        await testSettings(outDir);
        await testCoversPanelClock(outDir);
        await testMonitors();
        await testLifecycle(outDir);
        testLoaded();
        check('media: no web session after all checks with default settings',
            (mediaSharedModule.sharedMedia()?.fetcher.session ?? null) === null);
    } catch (e) {
        check('test run completed without exception', false, `${e}\n${e.stack}`);
    }
    settings()?.reset('hover-open-delay');
    return results;
}
