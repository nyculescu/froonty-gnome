// SPDX-License-Identifier: GPL-3.0-or-later
// Notifications tab: the store over GNOME's message tray
// (shell/notificationStore.js), the service (features/notifications/
// service.js) and the hover bubble's text (features/notifications/text.js).
//
// GNOME's objects are fakes with the same shape as GNOME Shell 50.1's
// (ui/messageTray.js): a source keeps at most what it is given, emits
// 'notification-removed' from inside the notification's 'destroy', and
// destroys itself once empty; a destroyed notification is disposed, and
// any later access to it throws, so the store touching one fails a test.
// GNOME's notification settings are on a memory backend, never the real
// ones.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import {test, eq, ok, done} from './test.js';
import {
    MAX_ACTIONS, NotificationStore, compareEntries,
} from '../../froonty@catalin/shell/notificationStore.js';
import {NotificationsService} from '../../froonty@catalin/features/notifications/service.js';
import {
    BUBBLE_BODY, BUBBLE_WIDTH, bubbleText, cut, wrapLines,
} from '../../froonty@catalin/features/notifications/text.js';

// GNOME Shell 50.1's values (messageTray.js); the store gets them passed.
const CRITICAL = 3;
const DISMISSED = 2;
const SOURCE_CLOSED = 3;
const LOW = 0;
const NORMAL = 1;

const NOTIFICATION_DEFAULTS = {
    'title': null,
    'body': null,
    'use-body-markup': false,
    'gicon': null,
    'datetime': null,
    'urgency': NORMAL,
    'acknowledged': false,
    'resident': false,
};

const prop = {
    string: name => GObject.ParamSpec.string(name, null, null, GObject.ParamFlags.READWRITE, null),
    boolean: name => GObject.ParamSpec.boolean(name, null, null, GObject.ParamFlags.READWRITE, false),
};

const FakeNotification = GObject.registerClass({
    Properties: {
        'title': prop.string('title'),
        'body': prop.string('body'),
        'use-body-markup': prop.boolean('use-body-markup'),
        'gicon': GObject.ParamSpec.object('gicon', null, null, GObject.ParamFlags.READWRITE, Gio.Icon),
        'datetime': GObject.ParamSpec.boxed('datetime', null, null, GObject.ParamFlags.READWRITE, GLib.DateTime),
        'urgency': GObject.ParamSpec.int('urgency', null, null, GObject.ParamFlags.READWRITE, 0, 3, NORMAL),
        'acknowledged': prop.boolean('acknowledged'),
        'resident': prop.boolean('resident'),
    },
    Signals: {
        'destroy': {param_types: [GObject.TYPE_UINT]},
        'action-added': {},
        'action-removed': {},
        'activated': {},
    },
}, class FakeNotification extends GObject.Object {
    get title() {
        return this._get('title');
    }

    set title(v) {
        this._set('title', v);
    }

    get body() {
        return this._get('body');
    }

    set body(v) {
        this._set('body', v);
    }

    get useBodyMarkup() {
        return this._get('use-body-markup');
    }

    set useBodyMarkup(v) {
        this._set('use-body-markup', v);
    }

    get gicon() {
        return this._get('gicon');
    }

    set gicon(v) {
        this._set('gicon', v);
    }

    get datetime() {
        return this._get('datetime');
    }

    set datetime(v) {
        this._set('datetime', v);
    }

    get urgency() {
        return this._get('urgency');
    }

    set urgency(v) {
        this._set('urgency', v);
    }

    get acknowledged() {
        return this._get('acknowledged');
    }

    set acknowledged(v) {
        this._set('acknowledged', v);
    }

    get resident() {
        return this._get('resident');
    }

    set resident(v) {
        this._set('resident', v);
    }

    get actions() {
        this._check('actions');
        this._actions ??= [];
        return this._actions;
    }

    get destroyed() {
        return this._destroyed === true;
    }

    _check(what) {
        if (this._destroyed)
            throw new Error(`a destroyed notification was used: ${what}`);
    }

    _get(name) {
        this._check(name);
        return this._props && name in this._props ? this._props[name] : NOTIFICATION_DEFAULTS[name];
    }

    _set(name, value) {
        this._check(name);
        this._props ??= {};
        if (this._props[name] === value)
            return;
        this._props[name] = value;
        this.notify(name);
    }

    connect(signal, callback) {
        this._check(`connect ${signal}`);
        return super.connect(signal, callback);
    }

    disconnect(id) {
        this._check('disconnect');
        return super.disconnect(id);
    }

    addAction(label, callback) {
        const action = {
            label,
            activate: () => {
                callback();
                if (!this.resident)
                    this.destroy();
            },
        };
        this.actions.push(action);
        this.emit('action-added');
        return action;
    }

    activate() {
        this._check('activate');
        this.emit('activated');
        if (this._destroyed || this.resident)
            return;
        this.destroy();
    }

    destroy(reason = DISMISSED) {
        this._check('destroy');
        this.emit('destroy', reason);
        this._destroyed = true;
        this.run_dispose();
    }
});

const FakeSource = GObject.registerClass({
    Properties: {
        'title': prop.string('title'),
        'icon': GObject.ParamSpec.object('icon', null, null, GObject.ParamFlags.READWRITE, Gio.Icon),
    },
    Signals: {
        'destroy': {param_types: [GObject.TYPE_UINT]},
        'notification-added': {param_types: [GObject.Object.$gtype]},
        'notification-removed': {param_types: [GObject.Object.$gtype]},
    },
}, class FakeSource extends GObject.Object {
    get title() {
        return this._title ?? null;
    }

    set title(v) {
        if (this._title === v)
            return;
        this._title = v;
        this.notify('title');
    }

    get icon() {
        return this._icon ?? null;
    }

    set icon(v) {
        if (this._icon === v)
            return;
        this._icon = v;
        this.notify('icon');
    }

    get notifications() {
        if (this._disposed)
            throw new Error('a destroyed source was read: notifications');
        this._notifications ??= [];
        return this._notifications;
    }

    // As GNOME's Source.addNotification (without the 10-per-source cap).
    addNotification(notification) {
        notification.connect('destroy', () => {
            const index = this.notifications.indexOf(notification);
            this.notifications.splice(index, 1);
            this.emit('notification-removed', notification);
            if (!this._inDestruction && this.notifications.length === 0)
                this.destroy(SOURCE_CLOSED);
        });
        this.notifications.push(notification);
        this.emit('notification-added', notification);
    }

    destroy(reason = DISMISSED) {
        this._inDestruction = true;
        while (this.notifications.length > 0)
            this.notifications[0].destroy(reason);
        this.emit('destroy', reason);
        this._disposed = true;
        this.run_dispose();
    }
});

const FakeTray = GObject.registerClass({
    Signals: {
        'source-added': {param_types: [GObject.Object.$gtype]},
        'source-removed': {param_types: [GObject.Object.$gtype]},
    },
}, class FakeTray extends GObject.Object {
    getSources() {
        return [...this._sourceMap?.keys() ?? []];
    }

    // As MessageTray.add() for an app whose notifications are on.
    add(source) {
        this._sourceMap ??= new Map();
        const id = source.connect('destroy', () => this._remove(source));
        this._sourceMap.set(source, id);
        this.emit('source-added', source);
    }

    // An app switched off in Settings: removed, nothing destroyed.
    removeByPolicy(source) {
        source.disconnect(this._sourceMap.get(source));
        this._remove(source);
    }

    _remove(source) {
        this._sourceMap.delete(source);
        this.emit('source-removed', source);
    }
});

const ago = seconds => GLib.DateTime.new_now_local().add_seconds(-seconds);

function notify(source, {title = 'Title', body = 'Body', urgency = NORMAL, seconds = 60,
    acknowledged = false, time = undefined, actions = [], resident = false} = {}) {
    const n = new FakeNotification();
    n.title = title;
    n.body = body;
    n.urgency = urgency;
    n.datetime = time === undefined ? ago(seconds) : time;
    n.acknowledged = acknowledged;
    n.resident = resident;
    for (const label of actions)
        n.addAction(label, () => (n.ran ??= []).push(label));
    source.addNotification(n);
    return n;
}

function makeSource(tray, title = 'Mail') {
    const source = new FakeSource();
    source.title = title;
    source.icon = new Gio.ThemedIcon({name: 'mail-unread-symbolic'});
    tray.add(source);
    return source;
}

const makeStore = (tray, {waitingForBanner} = {}) =>
    new NotificationStore(tray, {critical: CRITICAL, dismissed: DISMISSED, waitingForBanner});

// Handler count, as checks.js countHandlers does.
function handlers(instance, signal) {
    const [name, detail] = signal.split('::');
    const match = detail ? {signalId: name, detail} : {signalId: name};
    const count = GObject.signal_handlers_block_matched(instance, match);
    GObject.signal_handlers_unblock_matched(instance, match);
    return count;
}

function counting(emitter, signal) {
    const log = [];
    emitter.connect(signal, (_e, ...args) => log.push(args));
    return log;
}

const titles = store => store.notifications.map(n => n.title);

// ---------------------------------------------------------------- order

test('order: urgent first, then newest first, then the latest arrival', () => {
    const entries = [
        {name: 'old', urgent: false, time: 100, seq: 1},
        {name: 'urgent-old', urgent: true, time: 50, seq: 2},
        {name: 'new', urgent: false, time: 300, seq: 3},
        {name: 'same-time-first', urgent: false, time: 200, seq: 4},
        {name: 'same-time-later', urgent: false, time: 200, seq: 5},
    ];
    eq(entries.sort(compareEntries).map(e => e.name),
        ['urgent-old', 'new', 'same-time-later', 'same-time-first', 'old']);
});

test('order: a notification without a time sorts after timed ones', () => {
    const entries = [
        {name: 'untimed', urgent: false, time: null, seq: 9},
        {name: 'timed', urgent: false, time: 1, seq: 1},
        {name: 'untimed-urgent', urgent: true, time: null, seq: 2},
        {name: 'urgent', urgent: true, time: 5, seq: 3},
    ];
    eq(entries.sort(compareEntries).map(e => e.name),
        ['urgent', 'untimed-urgent', 'timed', 'untimed']);
});

// ---------------------------------------------------------------- store

test('store: nothing is connected before watch()', () => {
    const tray = new FakeTray();
    const source = makeSource(tray);
    const n = notify(source);
    const store = makeStore(tray);
    eq([handlers(tray, 'source-added'), handlers(tray, 'source-removed'),
        handlers(source, 'notification-added'), handlers(source, 'notification-removed'),
        handlers(source, 'notify'), handlers(n, 'notify'), handlers(n, 'action-added')],
    [0, 0, 0, 0, 0, 0, 0]);
    eq(store.notifications, []);
    ok(!store.watching);
});

test('store: watch() lists every source\'s notifications, sorted, with one "changed"', () => {
    const tray = new FakeTray();
    const mail = makeSource(tray, 'Mail');
    const build = makeSource(tray, 'Build');
    notify(mail, {title: 'mail 10 min', seconds: 600});
    notify(build, {title: 'build 2 min', seconds: 120});
    notify(mail, {title: 'critical 30 min', seconds: 1800, urgency: CRITICAL, acknowledged: true});
    const store = makeStore(tray);
    const changed = counting(store, 'changed');
    store.watch();
    eq(titles(store), ['critical 30 min', 'build 2 min', 'mail 10 min']);
    eq(changed.length, 1);
    eq(store.unseenCount, 2);
    store.watch();
    eq(changed.length, 1, 'a second watch() is a no-op');
    eq([handlers(tray, 'source-added'), handlers(mail, 'notification-added')], [1, 1]);
    store.unwatch();
});

test('store: an add or remove while watching changes the list', () => {
    const tray = new FakeTray();
    const mail = makeSource(tray);
    const first = notify(mail, {title: 'first', seconds: 300});
    const store = makeStore(tray);
    store.watch();
    const changed = counting(store, 'changed');
    notify(mail, {title: 'second', seconds: 10});
    eq(titles(store), ['second', 'first']);
    const build = makeSource(tray, 'Build');
    notify(build, {title: 'third', seconds: 5});
    eq(titles(store), ['third', 'second', 'first']);
    first.destroy(SOURCE_CLOSED);
    eq(titles(store), ['third', 'second']);
    ok(!store.has(first));
    ok(changed.length >= 3, `${changed.length} changes`);
    store.unwatch();
});

test('store: a datetime or urgency change re-sorts (and notifies the row); other changes only notify the row', () => {
    const tray = new FakeTray();
    const mail = makeSource(tray);
    const a = notify(mail, {title: 'a', seconds: 600});
    const b = notify(mail, {title: 'b', seconds: 60});
    const store = makeStore(tray);
    store.watch();
    const changed = counting(store, 'changed');
    const rowChanged = counting(store, 'notification-changed');

    a.datetime = ago(1);
    eq(titles(store), ['a', 'b'], 'GNOME re-stamps an updated one: it moves up');
    b.urgency = CRITICAL;
    eq(titles(store), ['b', 'a'], 'critical goes on top');
    eq(changed.length, 2);
    eq(rowChanged.map(([n]) => n.title), ['a', 'b'], 'its age or outline changes too');

    a.title = 'a2';
    a.body = 'new body';
    a.useBodyMarkup = true;
    a.gicon = new Gio.ThemedIcon({name: 'dialog-information-symbolic'});
    a.addAction('Open', () => {});
    a.acknowledged = true;
    a.resident = true; // not shown: ignored
    eq(changed.length, 2, 'no re-sort');
    eq(rowChanged.length, 8);
    ok(rowChanged.slice(2).every(([n]) => n === a));
    eq(store.unseenCount, 1);
    store.unwatch();
});

test('store: a source title or icon change notifies its rows', () => {
    const tray = new FakeTray();
    const mail = makeSource(tray);
    const other = makeSource(tray, 'Other');
    const a = notify(mail);
    const b = notify(mail);
    notify(other);
    const store = makeStore(tray);
    store.watch();
    const rowChanged = counting(store, 'notification-changed');
    mail.title = 'Mail (2)';
    mail.icon = new Gio.ThemedIcon({name: 'mail-read-symbolic'});
    eq(rowChanged.length, 4);
    ok(rowChanged.every(([n]) => n === a || n === b));
    eq(store.describe(a).appName, 'Mail (2)');
    store.unwatch();
});

test('store: an app switched off drops its rows and destroys nothing; switched on, they are back', () => {
    const tray = new FakeTray();
    const mail = makeSource(tray);
    const build = makeSource(tray, 'Build');
    const a = notify(mail, {title: 'mail'});
    notify(build, {title: 'build'});
    const store = makeStore(tray);
    store.watch();
    tray.removeByPolicy(mail);
    eq(titles(store), ['build']);
    ok(!a.destroyed);
    eq([handlers(mail, 'notification-added'), handlers(a, 'notify')], [0, 0],
        'its handlers are gone with it');
    tray.add(mail);
    eq(titles(store).sort(), ['build', 'mail']);
    store.unwatch();
});

test('store: unwatch() leaves zero handlers on the tray, the sources and the notifications', () => {
    const tray = new FakeTray();
    const mail = makeSource(tray);
    const n = notify(mail, {actions: ['Reply']});
    const store = makeStore(tray);
    store.watch();
    ok(handlers(n, 'notify') === 1 && handlers(mail, 'notify') === 2);
    store.unwatch();
    eq([handlers(tray, 'source-added'), handlers(tray, 'source-removed'),
        handlers(mail, 'notification-added'), handlers(mail, 'notification-removed'),
        handlers(mail, 'notify'), handlers(n, 'notify'),
        handlers(n, 'action-added'), handlers(n, 'action-removed')],
    [0, 0, 0, 0, 0, 0, 0, 0]);
    eq(store.notifications, []);
    eq(store.unseenCount, 0);
    store.unwatch();
});

test('store: a notification destroyed while not watching is never touched again', () => {
    const tray = new FakeTray();
    const mail = makeSource(tray);
    const keep = notify(mail, {title: 'keep'});
    const gone = notify(mail, {title: 'gone'});
    const store = makeStore(tray);
    store.watch();
    store.unwatch();
    gone.destroy(SOURCE_CLOSED);
    // The fake throws on any access to `gone` (checked here): watching
    // again must not.
    for (const access of [() => gone.title, () => gone.actions, () => gone.disconnect(1)]) {
        let threw = false;
        try {
            access();
        } catch {
            threw = true;
        }
        ok(threw, 'the fake throws once destroyed');
    }
    store.watch();
    eq(titles(store), ['keep']);
    ok(!store.has(gone));
    eq(store.describe(gone), null);
    eq(store.dismiss(gone), false);
    // And while watching: destroyed, forgotten, then unwatch() touches nothing.
    keep.destroy(SOURCE_CLOSED);
    eq(titles(store), []);
    store.unwatch();
});

test('store: describe() gives plain fields; no app name gives null; at most 3 actions', () => {
    const tray = new FakeTray();
    const mail = makeSource(tray);
    const time = ago(120);
    const n = notify(mail, {title: 'Hello', body: '<b>Hi</b>', time,
        actions: ['One', 'Two', 'Three', 'Four']});
    n.useBodyMarkup = true;
    n.gicon = new Gio.ThemedIcon({name: 'avatar-default-symbolic'});
    const nameless = makeSource(tray, '');
    const quiet = notify(nameless, {acknowledged: true});
    const store = makeStore(tray);
    store.watch();
    const desc = store.describe(n);
    ok(desc.appIcon === mail.icon && desc.icon === n.gicon && desc.time.equal(time));
    eq({...desc, appIcon: 'checked', icon: 'checked', time: 'checked'}, {
        appName: 'Mail',
        appId: null,
        appIcon: 'checked',
        title: 'Hello',
        body: '<b>Hi</b>',
        useMarkup: true,
        icon: 'checked',
        time: 'checked',
        urgent: false,
        unseen: true,
        actions: ['One', 'Two', 'Three'],
    });
    eq(MAX_ACTIONS, 3);
    const other = store.describe(quiet);
    eq([other.appName, other.unseen, other.actions], [null, false, []]);
    store.unwatch();
});

// The Claude attention bar (docs/features/claude-attention.md §9) makes a
// store of its own that follows only the Claude app's and web browsers'
// sources, and tells them apart by the source's app.
const CLAUDE_APP = 'com.anthropic.Claude.desktop';
const withApp = (source, id) => Object.assign(source, {app: {get_id: () => id}});
const SOURCE_SIGNALS = ['notification-added', 'notification-removed', 'notify::title', 'notify::icon'];

test('store: a filter leaves every other source without a single handler', () => {
    const tray = new FakeTray();
    const claude = withApp(makeSource(tray, 'Claude'), CLAUDE_APP);
    const mail = makeSource(tray, 'Mail');
    const store = new NotificationStore(tray, {critical: CRITICAL, dismissed: DISMISSED},
        {filter: source => source.app?.get_id() === CLAUDE_APP});
    store.watch();
    const ask = notify(claude, {title: 'Froonty', body: 'Allow Claude to run the tests?'});
    const hello = notify(mail, {title: 'Hello'});
    eq(titles(store), ['Froonty']);
    ok(!store.has(hello) && !store.dismiss(hello) && !store.activate(hello), 'not listed, never touched');
    eq(SOURCE_SIGNALS.map(signal => handlers(mail, signal)), [0, 0, 0, 0]);
    eq(handlers(hello, 'notify'), 0);
    eq(SOURCE_SIGNALS.map(signal => handlers(claude, signal)), [1, 1, 1, 1]);
    const files = makeSource(tray, 'Files');
    eq(SOURCE_SIGNALS.map(signal => handlers(files, signal)), [0, 0, 0, 0], 'added later: none either');
    ok(store.dismiss(ask));
    eq(titles(store), []);
    store.unwatch();
    eq(SOURCE_SIGNALS.map(signal => handlers(mail, signal)), [0, 0, 0, 0]);
});

test('store: describe() gives the source\'s app id, or null without an app', () => {
    const tray = new FakeTray();
    const claude = withApp(makeSource(tray, 'Claude'), CLAUDE_APP);
    const plain = makeSource(tray, 'notify-send');
    const fromApp = notify(claude, {title: 'Froonty'});
    const fromNoApp = notify(plain, {title: 'Plain'});
    const store = makeStore(tray);
    store.watch();
    eq([store.describe(fromApp).appId, store.describe(fromNoApp).appId], [CLAUDE_APP, null]);
    store.unwatch();
});

test('store: acknowledgeAll() marks only listed unseen notifications and returns the count', () => {
    const tray = new FakeTray();
    const mail = makeSource(tray);
    const a = notify(mail);
    const b = notify(mail);
    const seen = notify(mail, {acknowledged: true});
    const off = makeSource(tray, 'Off');
    const hidden = notify(off);
    const store = makeStore(tray);
    store.watch();
    tray.removeByPolicy(off);
    eq(store.unseenCount, 2);
    eq(store.acknowledgeAll(), 2);
    ok(a.acknowledged && b.acknowledged && seen.acknowledged);
    ok(!hidden.acknowledged, 'not listed: not touched');
    eq(store.unseenCount, 0);
    eq(store.acknowledgeAll(), 0);
    eq(mail.notifications.length, 3, 'nothing removed');
    store.unwatch();
    eq(store.acknowledgeAll(), 0, 'nothing while not watching');
});

test('store: activate and activateAction call GNOME\'s methods once; ignored when not listed or out of range', () => {
    const tray = new FakeTray();
    const mail = makeSource(tray);
    const n = notify(mail, {actions: ['Open', 'Reply']});
    const resident = notify(mail, {resident: true, actions: ['Snooze']});
    const store = makeStore(tray);
    store.watch();
    const activated = counting(resident, 'activated');
    ok(store.activate(resident));
    eq(activated.length, 1);
    ok(store.has(resident), 'resident: kept');
    eq([store.activateAction(n, 3), store.activateAction(n, -1), store.activateAction(n, 2),
        store.activateAction(n, 1.5)], [false, false, false, false]);
    ok(store.activateAction(n, 1));
    eq(n.ran, ['Reply']);
    ok(!store.has(n), 'GNOME removes a non-resident one after its action');
    eq(store.activateAction(n, 0), false, 'gone: ignored');
    eq(store.activate(n), false);
    ok(store.activateAction(resident, 0));
    ok(store.has(resident));
    store.unwatch();
    eq(store.activate(resident), false, 'not watching: ignored');
    eq(activated.length, 1);
});

test('store: dismiss() destroys with the dismissed reason; again, or unlisted, it is ignored', () => {
    const tray = new FakeTray();
    const mail = makeSource(tray);
    const n = notify(mail);
    const other = notify(mail);
    const reasons = [];
    n.connect('destroy', (_n, reason) => reasons.push(reason));
    const store = makeStore(tray);
    eq(store.dismiss(n), false, 'not watching');
    store.watch();
    ok(store.dismiss(n));
    eq(reasons, [DISMISSED]);
    eq(store.dismiss(n), false);
    eq(titles(store).length, 1);
    ok(store.has(other));
    store.unwatch();
});

test('store: clear(snapshot) dismisses only the snapshot\'s live ones, one "changed", across a vanishing source', () => {
    const tray = new FakeTray();
    const mail = makeSource(tray);
    const build = makeSource(tray, 'Build');
    const a = notify(mail, {title: 'a'});
    const b = notify(build, {title: 'b'});
    const c = notify(build, {title: 'c'});
    const store = makeStore(tray);
    store.watch();
    const snapshot = store.snapshot();
    eq(snapshot.size, 3);
    const reasons = [];
    for (const n of snapshot.keys())
        n.connect('destroy', (_n, reason) => reasons.push(reason));
    // Between the two clicks: one goes by itself, one arrives.
    c.destroy(SOURCE_CLOSED);
    const newer = notify(mail, {title: 'newer'});
    const changed = counting(store, 'changed');
    eq(store.clear(snapshot), 2);
    eq(reasons, [SOURCE_CLOSED, DISMISSED, DISMISSED]);
    ok(a.destroyed && b.destroyed);
    eq(titles(store), ['newer']);
    ok(store.has(newer) && !newer.destroyed);
    eq(changed.length, 1);
    eq(tray.getSources(), [mail], 'Build emptied and destroyed itself on the way');
    eq(store.countUnchanged(snapshot), 0);
    eq(store.clear(snapshot), 0, 'again: nothing');
    store.unwatch();
});

test('store: an update in place after the snapshot keeps it out of clear(); being marked seen does not', () => {
    const tray = new FakeTray();
    const chat = makeSource(tray, 'Chat');
    const mail = makeSource(tray, 'Mail');
    const updated = notify(chat, {title: '1 new message', acknowledged: true});
    const seen = notify(mail, {title: 'unseen at the first click'});
    const other = notify(mail, {title: 'other', acknowledged: true});
    const urgent = notify(mail, {title: 'urgency', acknowledged: true});
    const retitled = notify(mail, {title: 'title only', acknowledged: true});
    const acted = notify(mail, {title: 'actions', acknowledged: true});
    const store = makeStore(tray);
    store.watch();
    const snapshot = store.snapshot();
    eq(store.countUnchanged(snapshot), 6);

    // As GNOME's FDO daemon does for replaces_id: the same object, new
    // text, unseen again; GNOME then re-stamps its time.
    updated.title = '2 new messages';
    updated.acknowledged = false;
    updated.datetime = ago(0);
    seen.acknowledged = true;
    urgent.urgency = CRITICAL;
    retitled.title = 'title only, changed';
    acted.addAction('Reply', () => {});
    eq(store.countUnchanged(snapshot), 2, 'the seen one and "other" are unchanged');

    eq(store.clear(snapshot), 2);
    ok(seen.destroyed && other.destroyed);
    ok(!updated.destroyed && !urgent.destroyed && !retitled.destroyed && !acted.destroyed);
    eq(titles(store).sort(), ['2 new messages', 'actions', 'title only, changed', 'urgency']);
    store.unwatch();
});

test('store: set unseen again by its app, with nothing else changed, is a change too', () => {
    const tray = new FakeTray();
    const mail = makeSource(tray);
    const unseen = notify(mail);
    const store = makeStore(tray);
    store.watch();
    const snapshot = store.snapshot();
    // GJS 1.88 notifies only on a change (as this fake); a GObject
    // property without that check notifies on every set.
    unseen.notify('acknowledged');
    eq(store.countUnchanged(snapshot), 0);
    eq(store.clear(snapshot), 0);
    ok(!unseen.destroyed);
    store.unwatch();
});

test('store: listed again (its app switched off and on), it is not the snapshot\'s any more', () => {
    const tray = new FakeTray();
    const mail = makeSource(tray);
    const n = notify(mail, {acknowledged: true});
    const store = makeStore(tray);
    store.watch();
    const snapshot = store.snapshot();
    tray.removeByPolicy(mail);
    tray.add(mail);
    ok(store.has(n));
    eq(store.countUnchanged(snapshot), 0);
    eq(store.clear(snapshot), 0);
    ok(!n.destroyed);
    store.unwatch();
});

test('store: acknowledgeAll() leaves one waiting for its banner to GNOME\'s banner', () => {
    const tray = new FakeTray();
    const mail = makeSource(tray);
    const queued = notify(mail, {title: 'queued'});
    const listed = notify(mail, {title: 'listed'});
    const queue = [queued];
    const store = makeStore(tray, {waitingForBanner: n => queue.includes(n)});
    store.watch();
    eq(store.acknowledgeAll(), 1);
    ok(listed.acknowledged && !queued.acknowledged);
    eq(store.unseenCount, 1);
    // Its banner shown (GNOME takes it off the queue and marks it seen).
    queue.length = 0;
    queued.acknowledged = true;
    eq(store.unseenCount, 0);
    // Out of the queue but still unseen (the queue was full, or banners
    // are off for its app): marked.
    const late = notify(mail, {title: 'late'});
    eq(store.acknowledgeAll(), 1);
    ok(late.acknowledged);
    store.unwatch();
});

// ---------------------------------------------------------------- service

const notificationSchema = () =>
    Gio.SettingsSchemaSource.get_default().lookup('org.gnome.desktop.notifications', true);

function memorySettings() {
    const settings = new Gio.Settings({
        settings_schema: notificationSchema(),
        backend: Gio.memory_settings_backend_new(),
    });
    eq(GObject.type_name(settings.backend.constructor.$gtype), 'GMemorySettingsBackend',
        'test settings must be in memory');
    return settings;
}

function fakeGnome(tray) {
    const gnome = {
        stores: 0,
        createStore() {
            this.stores++;
            return makeStore(tray);
        },
        plainText: text => text,
        timeAgo: () => '',
    };
    return gnome;
}

const flush = () => {
    while (GLib.MainContext.default().iteration(false))
        ;
};

const settingsHandlers = settings =>
    handlers(settings, 'changed') + handlers(settings, 'writable-changed');

test('service: no store, no settings and no handlers until shown; hidden again, none', () => {
    const tray = new FakeTray();
    const mail = makeSource(tray);
    const n = notify(mail);
    const gnome = fakeGnome(tray);
    const dnd = memorySettings();
    const service = new NotificationsService(gnome, {notificationSettings: dnd});
    service.start();
    eq([gnome.stores, settingsHandlers(dnd), handlers(tray, 'source-added'), handlers(n, 'notify')],
        [0, 0, 0, 0]);
    eq(service.items, []);
    service.setActive(true);
    eq(gnome.stores, 1);
    eq(service.items, [n]);
    eq([settingsHandlers(dnd), handlers(tray, 'source-added'), handlers(n, 'notify')], [2, 1, 1]);
    service.setActive(false);
    eq([settingsHandlers(dnd), handlers(tray, 'source-added'), handlers(n, 'notify')], [0, 0, 0]);
    eq(service.items, []);
    service.setActive(true);
    eq(gnome.stores, 1, 'the store is made once');
    service.stop();
});

test('service: Do Not Disturb follows show-banners; setDoNotDisturb writes it; dnd-changed only while active', () => {
    const tray = new FakeTray();
    const dnd = memorySettings();
    const service = new NotificationsService(fakeGnome(tray), {notificationSettings: dnd});
    const fired = counting(service, 'dnd-changed');
    dnd.set_boolean('show-banners', false);
    flush();
    eq(fired.length, 0, 'not while hidden');
    service.setActive(true);
    eq(fired.length, 1, 'once on showing');
    ok(service.doNotDisturb && service.canChangeDoNotDisturb);
    dnd.set_boolean('show-banners', true);
    flush();
    ok(!service.doNotDisturb);
    eq(fired.length, 2);
    ok(service.setDoNotDisturb(true));
    flush();
    eq(dnd.get_boolean('show-banners'), false);
    ok(service.doNotDisturb);
    service.setActive(false);
    eq(service.setDoNotDisturb(false), false, 'not while hidden');
    eq(dnd.get_boolean('show-banners'), false);
    dnd.set_boolean('show-banners', true);
    flush();
    eq(fired.length, 3, 'no more while hidden');
    service.stop();
});

test('service: without GNOME\'s tray it is unavailable and every call is a no-op', () => {
    const dnd = memorySettings();
    const service = new NotificationsService(null, {notificationSettings: dnd});
    ok(!service.available);
    service.setActive(true);
    const fake = {};
    const snapshot = new Map([[fake, 1]]);
    eq([service.items, service.describe(fake), service.markSeen(), service.activate(fake),
        service.activateAction(fake, 0), service.dismiss(fake), service.snapshot().size,
        service.countClearable(snapshot), service.clear(snapshot)],
    [[], null, 0, false, false, false, 0, 0, 0]);
    service.stop();
});

test('service: every call is a no-op while hidden; stop() is idempotent and releases everything', () => {
    const tray = new FakeTray();
    const mail = makeSource(tray);
    const n = notify(mail);
    const dnd = memorySettings();
    const service = new NotificationsService(fakeGnome(tray), {notificationSettings: dnd});
    service.setActive(true);
    const snapshot = service.snapshot();
    eq([snapshot.size, service.countClearable(snapshot)], [1, 1]);
    service.setActive(false);
    eq([service.describe(n), service.markSeen(), service.activate(n), service.dismiss(n),
        service.snapshot().size, service.countClearable(snapshot), service.clear(snapshot)],
    [null, 0, false, false, 0, 0, 0]);
    ok(!n.destroyed && !n.acknowledged);
    service.setActive(true);
    eq(service.markSeen(), 1);
    service.stop();
    service.stop();
    eq([settingsHandlers(dnd), handlers(tray, 'source-added'), handlers(mail, 'notification-added'),
        handlers(n, 'notify')], [0, 0, 0, 0]);
    ok(service._store === null && service._dnd === null);
    ok(!n.destroyed, 'stopping removes nothing');
});

// ---------------------------------------------------------------- bubble

test('bubble: wrapped at spaces, long words cut, the body cut at 600 characters', () => {
    eq(wrapLines('one two three four', 9), ['one two', 'three', 'four']);
    eq(wrapLines('abcdefghij xy', 4), ['abcd', 'efgh', 'ij', 'xy']);
    eq(wrapLines('  ', 10), []);
    eq(cut('short', 10), 'short');
    eq(cut('abcdefghijkl', 5), 'abcd…');
    const body = 'word '.repeat(200);
    const text = bubbleText({heading: 'Mail · 14:05', title: 'Hello', body});
    const lines = text.split('\n');
    eq(lines.slice(0, 2), ['Mail · 14:05', 'Hello']);
    ok(lines.every(line => line.length <= BUBBLE_WIDTH), 'every line fits');
    const shownBody = lines.slice(2).join(' ');
    ok(shownBody.endsWith('…') && shownBody.length <= BUBBLE_BODY, `${shownBody.length}`);
});

await done();
