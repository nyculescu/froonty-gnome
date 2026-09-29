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
    const width = 840, height = 260;
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
    await sleep(SETTLE_MS);
    check('hub: a single feature hides the tab row', !hub._tabBar.visible);
    settings().reset('notes-enabled');
    await sleep(SETTLE_MS);
    check('hub: enabling a feature adds its tab',
        hub._tabBar.visible && hub._tabBar.get_n_children() === 2);
    check('hub: clock is the active tab', hub.activeFeature?.id === 'clock');

    const {FEATURES} = await import(`file://${extension().path}/features/registry.js`);
    const log = [];
    FEATURES.push(makeFakeFeature(log));
    try {
        await setExtensionEnabled(false);
        await setExtensionEnabled(true);
        check('hub: a registered feature adds a tab',
            island()._hub._tabBar.get_n_children() === 3);
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
    const path = GLib.build_filenamev([outDir, `${name}.png`]);
    const stream = Gio.File.new_for_path(path).replace(null, false, Gio.FileCreateFlags.NONE, null);
    await new Shell.Screenshot().screenshot_area(Math.round(b.x1) + 8, Math.round(b.y1) + 8,
        Math.round(b.x2 - b.x1) - 16, Math.round(b.y2 - b.y1) - 16, stream);
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
    const [, , cursorY, lineH] = view._entry.clutter_text.position_to_coords(
        view._entry.clutter_text.cursor_position);
    check('editor: a long note is scrollable and typing keeps the cursor in view',
        vadj.upper > vadj.page_size && cursorY + lineH <= vadj.value + vadj.page_size + 20,
        `upper=${vadj.upper} page=${vadj.page_size} value=${vadj.value} cursorY=${cursorY}`);
    await screenshotTop(outDir, 'notes-long-bottom');
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
        window.delete(global.get_current_time());
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
        await testHoverOpen();
        await testLauncher();
        await testSettingsButton(outDir);
        await testHub(outDir);
        await testNotes(outDir);
        await testNotesTabsAndColors(outDir);
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
