// SPDX-License-Identifier: GPL-3.0-or-later
// The clipboard switcher's pure parts (features/clipboard/switching.js) and
// its bookkeeping of GNOME's toggle-message-tray (messageTrayKey.js)
// against fake settings.
import GLib from 'gi://GLib';

import {MessageTrayKey} from '../../froonty@catalin/features/clipboard/messageTrayKey.js';
import {
    adjustTrayBinding, formatTrayRecord, isTerminal, normalizeAccelerator, parseTrayRecord, pasteKeys,
    popupPlacement, stepIndex, trayOffPlan, trayOnPlan, trayShortcutPlan,
} from '../../froonty@catalin/features/clipboard/switching.js';
import {done, eq, ok, test} from './test.js';

const GNOME_DEFAULT = ['<Super>v', '<Super>m'];

test('V steps to older entries and wraps; Shift+V steps back', () => {
    eq([0, 1, 2].map(i => stepIndex(i, 3)), [1, 2, 0]);
    eq([0, 1, 2].map(i => stepIndex(i, 3, true)), [2, 0, 1]);
    eq(stepIndex(0, 1), 0);
    eq(stepIndex(0, 1, true), 0);
    eq(stepIndex(0, 0), 0);
});

test('shortcuts compare whatever their spelling', () => {
    eq(normalizeAccelerator('<Super>v'), '<super>v');
    eq(normalizeAccelerator('<Mod4>V'), '<super>v');
    eq(normalizeAccelerator('<Shift><Super>v'), normalizeAccelerator('<Super><Shift>V'));
    eq(normalizeAccelerator('<Primary>v'), normalizeAccelerator('<Ctrl>v'));
    ok(normalizeAccelerator('<Super>m') !== normalizeAccelerator('<Super>v'));
});

test('GNOME\'s notification list loses the switcher\'s shortcut and keeps Super+M', () => {
    eq(adjustTrayBinding(GNOME_DEFAULT, ['<Super>v']), ['<Super>m']);
    // The user's machine: GNOME's Super+V was already off.
    eq(adjustTrayBinding([], ['<Super>v']), ['<Super>m']);
    eq(adjustTrayBinding(['<Mod4>V', '<Super>n'], ['<Super>v']), ['<Super>n', '<Super>m']);
    // A switcher on Super+M: GNOME's list keeps its Super+V.
    eq(adjustTrayBinding(GNOME_DEFAULT, ['<Super>m']), ['<Super>v']);
    eq(adjustTrayBinding(['<Super>m'], ['<Super>v']), ['<Super>m']);
});

test('the record of GNOME\'s value reads back, and damaged text is none', () => {
    const record = {original: [], written: ['<Super>m']};
    eq(parseTrayRecord(formatTrayRecord(record)), record);
    eq(parseTrayRecord(formatTrayRecord({original: null, written: ['<Super>m']})).original, null);
    eq(parseTrayRecord(''), null);
    eq(parseTrayRecord('{'), null);
    eq(parseTrayRecord('{"original": 3, "written": []}'), null);
    eq(parseTrayRecord('{"original": null, "written": [1]}'), null);
    eq(formatTrayRecord(null), '');
});

test('turning on changes GNOME\'s key once and remembers the user\'s value', () => {
    const on = trayOnPlan(null, {value: [], isDefault: false}, ['<Super>v']);
    eq(on, {write: ['<Super>m'], record: {original: [], written: ['<Super>m']}});
    // GNOME's default: remembered as "default", so turning off resets it.
    eq(trayOnPlan(null, {value: GNOME_DEFAULT, isDefault: true}, ['<Super>v']).record.original, null);
    // Already on (disable/enable at a screen lock): nothing changes.
    eq(trayOnPlan(on.record, {value: ['<Super>m'], isDefault: false}, ['<Super>v']),
        {write: null, record: on.record});
    // Nothing to change: nothing written, still remembered.
    eq(trayOnPlan(null, {value: ['<Super>m'], isDefault: false}, ['<Super>v']),
        {write: null, record: {original: ['<Super>m'], written: ['<Super>m']}});
});

test('turning off gives the user\'s value back, unless they changed GNOME\'s key since', () => {
    eq(trayOffPlan({original: [], written: ['<Super>m']}, {value: ['<Super>m']}), {action: 'set', value: []});
    eq(trayOffPlan({original: null, written: ['<Super>m']}, {value: ['<Super>m']}), {action: 'reset'});
    eq(trayOffPlan({original: [], written: ['<Super>m']}, {value: ['<Super>n']}), {action: 'none'});
    eq(trayOffPlan(null, {value: ['<Super>m']}), {action: 'none'});
});

test('a new switcher shortcut moves GNOME\'s value with it, from the user\'s original', () => {
    const record = {original: null, written: ['<Super>m']};
    const gnome = {value: ['<Super>m'], defaultValue: GNOME_DEFAULT};
    eq(trayShortcutPlan(record, gnome, ['<Super>c']),
        {write: ['<Super>v', '<Super>m'], record: {original: null, written: ['<Super>v', '<Super>m']}});
    // The user changed GNOME's key meanwhile: theirs.
    eq(trayShortcutPlan(record, {...gnome, value: ['<Super>n']}, ['<Super>c']), {write: null, record});
    eq(trayShortcutPlan(null, gnome, ['<Super>c']), {write: null, record: null});
});

// Gio.Settings' calls MessageTrayKey makes, over plain values.
function fakeSettings(values, defaults = {}) {
    return {
        values,
        get_strv: key => values[key] ?? defaults[key],
        set_strv: (key, v) => {
            values[key] = v;
        },
        get_string: key => values[key] ?? '',
        set_string: (key, v) => {
            values[key] = v;
        },
        get_user_value: key => key in values ? values[key] : null,
        get_default_value: key => new GLib.Variant('as', defaults[key]),
        reset: key => {
            delete values[key];
        },
    };
}

test('MessageTrayKey: on, kept through disable/enable, restored on off', () => {
    const froonty = fakeSettings({'clipboard-switcher-shortcut': ['<Super>v']});
    const gnome = fakeSettings({'toggle-message-tray': []}, {'toggle-message-tray': GNOME_DEFAULT});
    new MessageTrayKey(froonty, gnome).turnOn();
    eq(gnome.values['toggle-message-tray'], ['<Super>m']);
    ok(new MessageTrayKey(froonty, gnome).changed);
    // Each enable() turns it on again: no second change, the original kept.
    gnome.values['toggle-message-tray'] = ['<Super>m'];
    new MessageTrayKey(froonty, gnome).turnOn();
    eq(parseTrayRecord(froonty.values['clipboard-switcher-tray-backup']).original, []);
    new MessageTrayKey(froonty, gnome).turnOff();
    eq(gnome.values['toggle-message-tray'], []);
    eq(froonty.values['clipboard-switcher-tray-backup'], '');
    // Off again: nothing to give back.
    new MessageTrayKey(froonty, gnome).turnOff();
    eq(gnome.values['toggle-message-tray'], []);
});

test('MessageTrayKey: GNOME\'s default is reset, not copied; a shortcut change follows', () => {
    const froonty = fakeSettings({'clipboard-switcher-shortcut': ['<Super>v']});
    const gnome = fakeSettings({}, {'toggle-message-tray': GNOME_DEFAULT});
    const key = new MessageTrayKey(froonty, gnome);
    key.turnOn();
    eq(gnome.values['toggle-message-tray'], ['<Super>m']);
    froonty.values['clipboard-switcher-shortcut'] = ['<Super>c'];
    key.followShortcut();
    eq(gnome.values['toggle-message-tray'], ['<Super>v', '<Super>m']);
    key.turnOff();
    ok(!('toggle-message-tray' in gnome.values), 'reset to GNOME\'s default');
});

test('MessageTrayKey: without GNOME\'s key nothing is written, and off clears the record', () => {
    const froonty = fakeSettings({'clipboard-switcher-shortcut': ['<Super>v'],
        'clipboard-switcher-tray-backup': '{"original":[],"written":["<Super>m"]}'});
    const key = new MessageTrayKey(froonty, null);
    key.turnOn();
    key.followShortcut();
    key.turnOff();
    eq(froonty.values['clipboard-switcher-tray-backup'], '');
});

test('terminals are told by their text field or their app id', () => {
    ok(isTerminal(['org.gnome.Ptyxis.desktop', 'org.gnome.Ptyxis']));
    ok(isTerminal(['org.gnome.Terminal.desktop', 'Gnome-terminal']));
    ok(isTerminal(['org.gnome.Console.desktop', 'kgx']));
    ok(isTerminal(['Alacritty']));
    ok(isTerminal(['kitty']));
    ok(isTerminal(['org.codeberg.dnkl.foot']));
    ok(isTerminal(['org.wezfurlong.wezterm.desktop']));
    ok(isTerminal(['com.mitchellh.ghostty']));
    ok(isTerminal(['org.kde.konsole.desktop']));
    ok(isTerminal(['Some App'], true), 'VTE\'s terminal purpose');
    ok(!isTerminal(['org.gnome.TextEditor.desktop', 'gnome-text-editor']));
    ok(!isTerminal(['firefox_firefox.desktop', 'firefox']));
    ok(!isTerminal(['code.desktop', 'Code']), 'VS Code is not (its terminal is inside)');
    ok(!isTerminal(['org.gnome.Settings', 'football', 'mario']));
    ok(!isTerminal([]));
    eq(pasteKeys(true), ['Control_L', 'Shift_L', 'v']);
    eq(pasteKeys(false), ['Control_L', 'v']);
});

test('the pop-up goes below the text cursor, above without room, always on screen', () => {
    const monitor = {x: 0, y: 0, width: 1920, height: 1080};
    const size = {width: 360, height: 140};
    const options = {gap: 6, margin: 8};
    eq(popupPlacement({x: 500, y: 300, width: 2, height: 20}, size, monitor, options), {x: 500, y: 326, below: true});
    eq(popupPlacement({x: 500, y: 1000, width: 2, height: 20}, size, monitor, options), {x: 500, y: 854, below: false});
    // Near the right edge: moved left to fit.
    eq(popupPlacement({x: 1900, y: 300, width: 2, height: 20}, size, monitor, options).x, 1920 - 8 - 360);
    eq(popupPlacement({x: -40, y: 300, width: 0, height: 20}, size, monitor, options).x, 8);
    // A monitor too short for either side: inside it anyway.
    const short = {x: 0, y: 0, width: 800, height: 200};
    const tight = popupPlacement({x: 10, y: 90, width: 2, height: 20}, size, short, options);
    ok(tight.y >= 8 && tight.y + 140 <= 200, `y=${tight.y}`);
    // A second monitor's coordinates.
    const right = {x: 1920, y: 0, width: 1280, height: 800};
    eq(popupPlacement({x: 2000, y: 100, width: 2, height: 20}, size, right, options), {x: 2000, y: 126, below: true});
    // A window's middle.
    eq(popupPlacement({x: 100, y: 100, width: 800, height: 600}, size, monitor, {...options, centre: true}),
        {x: 320, y: 330, below: true});
});

await done();
