// SPDX-License-Identifier: GPL-3.0-or-later
// Settings → Break → Garmin (docs/features/break.md, "Garmin"): the
// switch, and, each only on a click: Set up (a Python environment with
// the pinned library, from PyPI), Sign in (the password goes to the
// helper on its stdin and is never stored), Sign out, Remove. Runs in
// the preferences process; the helper in a process of its own
// (garminRun.js).

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {switchRow} from '../../prefs/rows.js';
import {LIBRARY, dataDir, isSetUp, readStatus, removeAll, setUp, signIn, signOut} from './garminRun.js';

Gio._promisify(Adw.AlertDialog.prototype, 'choose', 'choose_finish');

// As Settings → Claude's Remove: red text on a light tint of it.
const CSS = `
button.froonty-garmin-remove { color: var(--destructive-color); background-color: alpha(currentColor, 0.12); }
button.froonty-garmin-remove:hover { background-color: alpha(currentColor, 0.18); }
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

const errorText = result => ({
    auth: _('Garmin did not accept the sign-in. Check the email and password, or the code.'),
    blocked: _('Garmin refused the connection for now (it blocks unofficial apps at times). Try again in a few hours.'),
    network: _('Garmin could not be reached. Check the connection.'),
    setup: _('The Garmin helper is not set up.'),
}[result?.error] ?? _('Something went wrong: %s').format(result?.message ?? '?'));

async function alert(widget, heading, body) {
    const dialog = new Adw.AlertDialog({heading, body});
    dialog.add_response('ok', _('OK'));
    await dialog.choose(widget, null);
}

// The email and password, or null (cancelled).
async function askCredentials(widget) {
    const list = new Gtk.ListBox({css_classes: ['boxed-list'], selection_mode: Gtk.SelectionMode.NONE});
    const email = new Adw.EntryRow({title: _('Email')});
    const password = new Adw.PasswordEntryRow({title: _('Password')});
    list.append(email);
    list.append(password);
    const dialog = new Adw.AlertDialog({
        heading: _('Sign in to Garmin Connect'),
        body: _('The password goes to Garmin only, through Froonty’s helper, and is not stored; only Garmin’s sign-in tokens are kept, in %s. With two-step verification, the code is asked next.')
            .format(dataDir()),
        extra_child: list,
    });
    dialog.add_response('cancel', _('Cancel'));
    dialog.add_response('sign-in', _('Sign in'));
    dialog.set_response_appearance('sign-in', Adw.ResponseAppearance.SUGGESTED);
    dialog.default_response = 'sign-in';
    const answer = await dialog.choose(widget, null);
    const result = answer === 'sign-in' && email.text && password.text
        ? {email: email.text.trim(), password: password.text} : null;
    password.text = '';
    return result;
}

async function askCode(widget) {
    const list = new Gtk.ListBox({css_classes: ['boxed-list'], selection_mode: Gtk.SelectionMode.NONE});
    const code = new Adw.EntryRow({title: _('Code'), input_purpose: Gtk.InputPurpose.DIGITS});
    list.append(code);
    const dialog = new Adw.AlertDialog({
        heading: _('Garmin’s code'),
        body: _('Garmin sent a code (by email or in its app). Enter it to finish signing in.'),
        extra_child: list,
    });
    dialog.add_response('cancel', _('Cancel'));
    dialog.add_response('ok', _('Continue'));
    dialog.set_response_appearance('ok', Adw.ResponseAppearance.SUGGESTED);
    dialog.default_response = 'ok';
    return await dialog.choose(widget, null) === 'ok' && code.text ? code.text.trim() : null;
}

/** The Garmin group of Settings → Break. */
export function garminGroup(settings) {
    addCss();
    const group = new Adw.PreferencesGroup({
        title: _('Garmin (optional)'),
        description: _('Reads today’s workouts from Garmin Connect, so “I worked out” fills itself. It uses python-garminconnect, an unofficial library Garmin may block at any time; it runs in a Python environment and a process of its own, never inside GNOME Shell, and when it fails Froonty goes on without it. Only Garmin’s sign-in tokens are kept, on this computer (%s, yours only, outside any repository); the password is never stored.')
            .format(dataDir()),
    });
    const toggle = switchRow(settings, 'break-garmin', _('Read workouts from Garmin Connect'),
        _('When the Break tab opens, after an away of 20 min or more, and at login; at most every 15 min'));
    group.add(toggle);

    const row = new Adw.ActionRow({title: _('Garmin Connect'), use_markup: false});
    const buttons = {
        setUp: new Gtk.Button({label: _('Set up'), valign: Gtk.Align.CENTER, css_classes: ['suggested-action']}),
        signIn: new Gtk.Button({label: _('Sign in…'), valign: Gtk.Align.CENTER, css_classes: ['suggested-action']}),
        signOut: new Gtk.Button({label: _('Sign out'), valign: Gtk.Align.CENTER}),
        remove: new Gtk.Button({label: _('Remove'), valign: Gtk.Align.CENTER, css_classes: ['froonty-garmin-remove']}),
    };
    Object.values(buttons).forEach(b => row.add_suffix(b));
    group.add(row);

    let busy = false;
    const sync = (line = null) => {
        const ready = isSetUp();
        const status = ready ? readStatus() : null;
        const signedIn = Boolean(status?.signedIn);
        let text;
        if (line)
            text = line;
        else if (!ready)
            text = _('Not set up: “Set up” makes a Python environment with %s, downloaded from PyPI.').format(LIBRARY);
        else if (!signedIn)
            text = _('Set up; not signed in.');
        else if (status.ok)
            text = _('Signed in%s; last read %s.').format(status.name ? ` (${status.name})` : '', status.at ?? '?');
        else
            text = `${errorText(status)} (${status.at ?? ''})`;
        row.subtitle = text;
        buttons.setUp.visible = !ready;
        buttons.signIn.visible = ready && !signedIn;
        buttons.signOut.visible = ready && Boolean(signedIn);
        buttons.remove.visible = ready;
        for (const b of Object.values(buttons))
            b.sensitive = !busy;
    };
    sync();

    const run = async (work, lineOf = null) => {
        if (busy)
            return;
        busy = true;
        sync(lineOf);
        try {
            await work();
        } catch (e) {
            await alert(row, _('Garmin'), errorText({error: 'other', message: e.message}));
        } finally {
            busy = false;
            sync();
        }
    };

    buttons.setUp.connect('clicked', () => run(async () => {
        const result = await setUp(line => {
            // pip's progress, one line at a time, as the row's subtitle.
            if (line.trim())
                row.subtitle = line.trim().slice(0, 160);
        });
        if (!result.ok)
            await alert(row, _('Garmin set-up'), errorText(result));
    }, _('Setting up…')));

    buttons.signIn.connect('clicked', () => run(async () => {
        const creds = await askCredentials(row);
        if (!creds)
            return;
        const result = await signIn(creds.email, creds.password, () => askCode(row));
        creds.password = null;
        if (result.ok)
            settings.set_boolean('break-garmin', true);
        else if (result.message !== 'cancelled')
            await alert(row, _('Garmin sign-in'), errorText(result));
    }, _('Signing in…')));

    buttons.signOut.connect('clicked', () => run(async () => {
        await signOut();
        settings.set_boolean('break-garmin', false);
    }));

    buttons.remove.connect('clicked', () => run(async () => {
        const dialog = new Adw.AlertDialog({
            heading: _('Remove the Garmin helper?'),
            body: _('Signs out and deletes %s: the Python environment and Garmin’s sign-in tokens.').format(dataDir()),
        });
        dialog.add_response('cancel', _('Cancel'));
        dialog.add_response('remove', _('Remove'));
        dialog.set_response_appearance('remove', Adw.ResponseAppearance.DESTRUCTIVE);
        if (await dialog.choose(row, null) !== 'remove')
            return;
        settings.set_boolean('break-garmin', false);
        await removeAll();
    }));

    // The switch means nothing without a sign-in.
    const syncToggle = () => {
        toggle.sensitive = isSetUp();
    };
    syncToggle();
    settings.connect('changed::break-garmin', () => {
        syncToggle();
        sync();
    });
    return group;
}
