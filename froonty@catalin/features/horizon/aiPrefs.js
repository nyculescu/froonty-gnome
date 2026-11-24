// SPDX-License-Identifier: GPL-3.0-or-later
// Settings → Horizon → AI for Horizon (docs/features/horizon.md): this
// computer's model (Writing's), a ChatGPT plan signed in through Horizon's
// own horizon-chatgpt, or an API key kept in the keyring. Runs in the
// preferences process (GTK 4 + libadwaita).

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {cliJson, horizonBin, PROVIDERS, providerById, SOURCES} from './horizonAi.js';
import {clearKey, lookupKey, storeKey} from './horizonSecret.js';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async', 'communicate_utf8_finish');
Gio._promisify(Gio.Subprocess.prototype, 'wait_async', 'wait_finish');
Gio._promisify(Gio.DataInputStream.prototype, 'read_line_async', 'read_line_finish');

export function horizonAiGroup(settings) {
    const group = new Adw.PreferencesGroup({
        title: _('AI for Horizon'),
        description: _('What writes the briefings. Froonty puts this into Horizon’s config.json before each refresh, so Horizon’s setup wizard is not needed; without a config.json, it starts with Hacker News.'),
    });

    const source = new Adw.ComboRow({
        title: _('AI'),
        model: Gtk.StringList.new([
            _('This computer (Writing’s model)'),
            _('ChatGPT plan'),
            _('API key'),
            _('Horizon’s own setting (make horizon-wizard)'),
        ]),
    });
    group.add(source);

    const local = localRows(settings);
    const chatgpt = chatgptRows(settings);
    const api = apiRows(settings);
    const config = [new Adw.ActionRow({
        title: _('As in Horizon’s config.json'),
        subtitle: _('Froonty leaves it as Horizon’s wizard wrote it. Run make horizon-wizard in the project folder to change it.'),
    })];
    const rowsBySource = {local, chatgpt, api, config};
    for (const rows of Object.values(rowsBySource))
        rows.forEach(row => group.add(row));

    const sync = () => {
        const current = settings.get_string('horizon-ai');
        source.selected = Math.max(0, SOURCES.indexOf(current));
        for (const [id, rows] of Object.entries(rowsBySource))
            rows.forEach(row => (row.visible = id === current));
    };
    source.connect('notify::selected', () => {
        const value = SOURCES[source.selected];
        if (value && settings.get_string('horizon-ai') !== value)
            settings.set_string('horizon-ai', value);
    });
    settings.connect('changed::horizon-ai', sync);
    sync();
    return group;
}

function localRows(settings) {
    const row = new Adw.ActionRow({title: _('Model')});
    const sync = () => {
        const model = settings.get_string('writing-ollama-model');
        row.subtitle = model
            ? _('%s, on this computer (Froonty’s Ollama, started when needed). Change it in Settings → Writing.').format(model)
            : _('None yet. Choose or download one in Settings → Writing.');
    };
    settings.connect('changed::writing-ollama-model', sync);
    sync();
    return [row];
}

// horizon-chatgpt's output: lines as they come (the sign-in prints its
// address, then waits), and the whole text at the end.
async function runCli(args, onLine = null) {
    const launcher = new Gio.SubprocessLauncher({
        flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE,
    });
    // Into a pipe Python holds lines back; the address must come at once.
    launcher.setenv('PYTHONUNBUFFERED', '1', true);
    const proc = launcher.spawnv([horizonBin('horizon-chatgpt'), ...args]);
    if (!onLine) {
        const [stdout] = await proc.communicate_utf8_async(null, null);
        return {ok: proc.get_successful(), text: stdout ?? ''};
    }
    const stream = new Gio.DataInputStream({base_stream: proc.get_stdout_pipe()});
    let text = '';
    for (;;) {
        // eslint-disable-next-line no-await-in-loop
        const [line] = await stream.read_line_async(GLib.PRIORITY_DEFAULT, null);
        if (line === null)
            break;
        const decoded = new TextDecoder().decode(line);
        text += `${decoded}\n`;
        onLine(decoded);
    }
    await proc.wait_async(null);
    return {ok: proc.get_successful(), text};
}

function chatgptRows(settings) {
    const account = new Adw.ActionRow({title: _('ChatGPT account')});
    const signIn = new Gtk.Button({label: _('Sign in'), valign: Gtk.Align.CENTER});
    const signOut = new Gtk.Button({label: _('Sign out'), valign: Gtk.Align.CENTER, css_classes: ['flat']});
    account.add_suffix(signOut);
    account.add_suffix(signIn);

    const models = new Gtk.StringList();
    const model = new Adw.ComboRow({
        title: _('Model'),
        subtitle: _('From your account’s list; requests count toward your ChatGPT plan’s usage'),
        model: models,
    });
    let slugs = [];
    let filling = false;
    const fillModels = catalog => {
        filling = true;
        const chosen = settings.get_string('horizon-chatgpt-model');
        slugs = catalog.map(entry => entry.slug);
        if (chosen && !slugs.includes(chosen)) {
            slugs.unshift(chosen);
            catalog = [{slug: chosen, display_name: chosen}, ...catalog];
        }
        models.splice(0, models.get_n_items(), catalog.map(entry => entry.display_name || entry.slug));
        model.selected = Math.max(0, slugs.indexOf(chosen));
        model.sensitive = slugs.length > 0;
        filling = false;
        if (!chosen && slugs.length)
            settings.set_string('horizon-chatgpt-model', slugs[0]);
    };
    model.connect('notify::selected', () => {
        const slug = slugs[model.selected];
        if (!filling && slug && settings.get_string('horizon-chatgpt-model') !== slug)
            settings.set_string('horizon-chatgpt-model', slug);
    });

    const show = (status, busy = false) => {
        account.subtitle = status;
        signIn.sensitive = !busy;
        signOut.sensitive = !busy && Boolean(settings.get_string('horizon-chatgpt-account'));
    };

    const loadModels = async () => {
        const {ok, text} = await runCli(['models']);
        const catalog = ok ? cliJson(text) : null;
        fillModels(Array.isArray(catalog) ? catalog : []);
    };

    const refresh = async () => {
        if (!GLib.file_test(horizonBin('horizon-chatgpt'), GLib.FileTest.IS_EXECUTABLE)) {
            show(_('Horizon is not set up yet: run make horizon-setup in the project folder.'), true);
            model.sensitive = false;
            return;
        }
        show(_('Checking…'), true);
        const {text} = await runCli(['status']);
        const status = cliJson(text);
        if (status?.connected && status.plan_usage) {
            settings.set_string('horizon-chatgpt-account', status.client_id ?? '');
            show(status.email ? _('Signed in as %s').format(status.email) : _('Signed in'));
            await loadModels();
        } else {
            show(status?.connected
                ? _('Signed in, but plan usage is not allowed yet: sign in again')
                : _('Not signed in'));
            fillModels([]);
        }
    };

    signIn.connect('clicked', () => {
        show(_('Continue in your browser…'), true);
        runCli(['login', '--enable-plan', '--no-browser'], line => {
            const url = line.trim();
            if (/^https:\/\//.test(url))
                new Gtk.UriLauncher({uri: url}).launch(account.get_root(), null, null);
        }).then(({ok, text}) => {
            if (!ok) {
                show(_('Sign-in failed: %s').format(text.trim().split('\n').pop() ?? ''));
                return null;
            }
            return refresh();
        }).catch(e => show(_('Sign-in failed: %s').format(e.message)));
    });
    signOut.connect('clicked', () => {
        show(_('Signing out…'), true);
        runCli(['logout']).finally(() => {
            settings.set_string('horizon-chatgpt-account', '');
            settings.set_string('horizon-chatgpt-model', '');
            refresh().catch(e => show(e.message));
        });
    });

    // Checked when the row first shows, not for every Settings window.
    let checked = false;
    account.connect('map', () => {
        if (checked)
            return;
        checked = true;
        refresh().catch(e => show(e.message));
    });
    return [account, model];
}

function apiRows(settings) {
    const provider = new Adw.ComboRow({
        title: _('Provider'),
        model: Gtk.StringList.new(PROVIDERS.map(p => p.name)),
    });
    const model = new Adw.EntryRow({title: _('Model'), show_apply_button: true});
    const key = new Adw.PasswordEntryRow({title: _('API key'), show_apply_button: true});
    const saved = new Adw.ActionRow({title: _('Saved key')});
    const remove = new Gtk.Button({label: _('Remove'), valign: Gtk.Align.CENTER, css_classes: ['flat']});
    saved.add_suffix(remove);

    const current = () => providerById(settings.get_string('horizon-ai-provider')) ?? PROVIDERS[0];
    const syncSaved = () => {
        const p = current();
        lookupKey(p.id).then(value => {
            saved.subtitle = value
                ? _('In your keyring; Froonty hands it to Horizon only while a refresh runs')
                : _('None for %s. Paste one above; it is kept in your keyring, not in Froonty’s settings.').format(p.name);
            remove.sensitive = Boolean(value);
        }).catch(e => {
            saved.subtitle = _('The keyring could not be read: %s').format(e.message);
            remove.sensitive = false;
        });
    };
    const sync = () => {
        const p = current();
        provider.selected = PROVIDERS.indexOf(p);
        model.title = _('Model (empty: %s)').format(p.model);
        model.text = settings.get_string('horizon-ai-model');
        syncSaved();
    };
    provider.connect('notify::selected', () => {
        const id = PROVIDERS[provider.selected]?.id;
        if (id && settings.get_string('horizon-ai-provider') !== id) {
            settings.set_string('horizon-ai-provider', id);
            // Another provider's model names differ.
            settings.set_string('horizon-ai-model', '');
        }
    });
    model.connect('apply', () => settings.set_string('horizon-ai-model', model.text.trim()));
    key.connect('apply', () => {
        const value = key.text.trim();
        key.text = '';
        if (!value)
            return;
        const p = current();
        storeKey(p.id, value, _('Froonty: Horizon API key (%s)').format(p.name))
            .then(syncSaved)
            .catch(e => (saved.subtitle = _('Could not save it in the keyring: %s').format(e.message)));
    });
    remove.connect('clicked', () => {
        clearKey(current().id).finally(syncSaved);
    });
    settings.connect('changed::horizon-ai-provider', sync);
    settings.connect('changed::horizon-ai-model', () => {
        model.text = settings.get_string('horizon-ai-model');
    });
    sync();
    return [provider, model, key, saved];
}
