// SPDX-License-Identifier: GPL-3.0-or-later
// Settings → Writing (docs/features/writing.md §2, §5): the tab, each engine
// with its switch (an engine switched off is not in the tab at all), its
// status, how to set it up by hand, and, where it can be done safely, a
// button that does it; Remove buttons that undo exactly that; and
// "Remove everything Froonty set up for Writing".
//
// Runs in the preferences process (GTK 4 + libadwaita). Set-up and removal
// only ever run here, on a click, after a confirmation that shows what
// will happen. Statuses are read when this page is shown.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {authCheck, CLAUDE_MODELS, locate, version as claudeVersion,
    workingFolder} from './engines/claudeCode.js';
import {VARIANTS} from './engines/languageTool.js';
import {baseUrl, probe, systemOllama} from './engines/ollama.js';
import {newSession} from './http.js';
import {defaultPaths, override} from './paths.js';
import {runProcess} from './process.js';
import {exists} from './setup/fs.js';
import {install, prepare, startService, stopService} from './setup/ollamaInstall.js';
import {MODEL_CHOICES, SIZES_DATE, modelRows, pullModel} from './setup/ollamaModels.js';
import {everythingRemovalPlan, execute, gatherFacts, NOT_REMOVED,
    ollamaRemovalPlan} from './setup/remove.js';
import {isModelName, readState} from './setup/state.js';

Gio._promisify(Adw.AlertDialog.prototype, 'choose', 'choose_finish');

const ENGINE_KEYS = ['writing-claude-code-enabled', 'writing-languagetool-enabled',
    'writing-ollama-enabled'];
const SIZE_KEYS = ['writing-width', 'writing-height'];
const PLAN_NAMES = {pro: 'Pro', max: 'Max', team: 'Team', enterprise: 'Enterprise'};

// ------------------------------------------------------------------ helpers

function label(text, {mono = false, dim = false} = {}) {
    const css = [];
    if (mono)
        css.push('monospace');
    if (dim)
        css.push('dim-label');
    return new Gtk.Label({
        label: text,
        wrap: true,
        wrap_mode: Pango.WrapMode.WORD_CHAR,
        xalign: 0,
        selectable: true,
        css_classes: css,
    });
}

// Numbered steps, each a sentence and optional commands, in an expander.
function stepsRow(title, steps) {
    const row = new Adw.ExpanderRow({title});
    const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 8,
        margin_top: 10,
        margin_bottom: 12,
        margin_start: 12,
        margin_end: 12,
    });
    steps.forEach(([text, ...commands], i) => {
        box.append(label(`${i + 1}. ${text}`));
        for (const command of commands)
            box.append(label(command, {mono: true}));
    });
    row.add_row(box);
    return row;
}

function noteRow(title, text) {
    return new Adw.ActionRow({title, subtitle: text, subtitle_selectable: true});
}

function button(text, css = []) {
    return new Gtk.Button({label: text, valign: Gtk.Align.CENTER, css_classes: css});
}

/** A confirmation; resolves to the response id. */
async function ask(window, {heading, body, details = null, responses, defaultResponse = 'cancel'}) {
    const dialog = new Adw.AlertDialog({heading, body});
    for (const [id, text, appearance] of responses) {
        dialog.add_response(id, text);
        if (appearance)
            dialog.set_response_appearance(id, appearance);
    }
    dialog.default_response = defaultResponse;
    dialog.close_response = 'cancel';
    if (details) {
        const scroll = new Gtk.ScrolledWindow({
            min_content_height: 120,
            max_content_height: 320,
            propagate_natural_height: true,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
        });
        scroll.set_child(label(details, {mono: true}));
        dialog.extra_child = scroll;
    }
    return await dialog.choose(window, null);
}

function tell(window, heading, body, details = null) {
    return ask(window, {heading, body, details, responses: [['cancel', _('Close')]]});
}

const short = path => path.replace(GLib.get_home_dir(), '~');

// One automation at a time, cancelled when the window closes.
class Operation {
    constructor(window, onChange) {
        this._window = window;
        this._onChange = onChange;
        this.cancellable = null;
        this.text = '';
        this.fraction = null;
        window.connect('close-request', () => {
            this.cancellable?.cancel();
            return false;
        });
    }

    get busy() {
        return this.cancellable !== null;
    }

    progress(text, fraction = null) {
        this.text = text;
        this.fraction = fraction;
        this._onChange();
    }

    cancel() {
        this.cancellable?.cancel();
    }

    async run(title, task) {
        if (this.busy)
            return;
        this.cancellable = new Gio.Cancellable();
        this.progress(_('Working…'));
        try {
            await task(this.cancellable);
        } catch (e) {
            if (e.code !== 'cancelled' && !this.cancellable.is_cancelled())
                await tell(this._window, title, e.message).catch(() => {});
        } finally {
            this.cancellable = null;
            this.text = '';
            this.fraction = null;
            this._onChange();
        }
    }
}

// ------------------------------------------------------------------ groups

function tabGroup(settings) {
    const group = new Adw.PreferencesGroup({
        title: _('Writing tab'),
        description: _('Paraphrase, fix grammar, shorten, change the tone of, or summarise text. Text leaves this computer only when you click one of these actions, and only to the engine named above the text box. Nothing is saved.'),
    });
    const enabled = new Adw.SwitchRow({title: _('Show the Writing tab')});
    settings.bind('writing-enabled', enabled, 'active', Gio.SettingsBindFlags.DEFAULT);
    group.add(enabled);
    const hint = new Adw.ActionRow({
        title: _('Turn on Show the Writing tab too.'),
        subtitle: _('An engine is switched on below, but the tab is off.'),
        css_classes: ['warning'],
    });
    const sync = () => {
        hint.visible = !settings.get_boolean('writing-enabled') &&
            ENGINE_KEYS.some(key => settings.get_boolean(key));
    };
    for (const key of ['writing-enabled', ...ENGINE_KEYS])
        settings.connect(`changed::${key}`, sync);
    sync();
    group.add(hint);
    return group;
}

function claudeGroup(ctx) {
    const {settings, paths} = ctx;
    const group = new Adw.PreferencesGroup({
        title: _('Claude Code'),
        description: _('Uses your Claude plan through your own Claude Code. Every run has all of Claude Code’s tools, MCP servers, skills, hooks and settings files turned off, so text that contains instructions cannot make it do anything.'),
    });
    const enabled = new Adw.SwitchRow({title: _('Offer Claude Code in the Writing tab')});
    settings.bind('writing-claude-code-enabled', enabled, 'active', Gio.SettingsBindFlags.DEFAULT);
    group.add(enabled);

    const status = new Adw.ActionRow({title: _('Status'), subtitle_selectable: true});
    const check = button(_('Check again'), ['flat']);
    status.add_suffix(check);
    group.add(status);

    const models = ['Haiku (lightest)', 'Sonnet'];
    const model = new Adw.ComboRow({
        title: _('Model'),
        subtitle: _('Haiku counts least toward your plan’s limits'),
        model: Gtk.StringList.new(models.map(m => _(m))),
    });
    const syncModel = () => {
        model.selected = Math.max(0, CLAUDE_MODELS.indexOf(settings.get_string('writing-claude-code-model')));
    };
    syncModel();
    settings.connect('changed::writing-claude-code-model', syncModel);
    model.connect('notify::selected', () =>
        settings.set_string('writing-claude-code-model', CLAUDE_MODELS[model.selected] ?? 'haiku'));
    group.add(model);

    group.add(stepsRow(_('How to set it up'), [
        [_('You need a Claude Pro, Max, Team or Enterprise plan. The free plan does not include Claude Code.')],
        [_('Install Claude Code if you do not have it. Froonty uses the one inside VS Code’s Claude Code extension, or claude in ~/.local/bin or on your PATH. To install it on its own (Anthropic’s installer; the alternative is Anthropic’s apt repository, see code.claude.com/docs/en/setup):'),
            'curl -fsSL https://claude.ai/install.sh | bash'],
        [_('Sign in with your Claude account (or start claude and follow the browser prompt), then check:'),
            'claude auth login', 'claude auth status --text'],
        [_('Froonty ignores ANTHROPIC_API_KEY and refuses a sign-in for API billing (Console): only a Claude plan is used.')],
        [_('Click Check again.')],
    ]));
    group.add(noteRow(_('Privacy'), _('Text goes to Anthropic under your Claude account’s terms and counts toward your plan’s usage limits. Whether it may be used to improve Claude follows your Claude privacy settings (code.claude.com/docs/en/data-usage). If extra usage is turned on for your account, requests past a limit may be billed as extra usage; Froonty has not verified this.')));
    group.add(noteRow(_('Remove'), _('Nothing to remove: Froonty installs nothing for Claude Code. Turning the switch off is enough. Uninstalling Claude Code itself is not part of Froonty: see code.claude.com/docs/en/setup#uninstall-claude-code (for its own installer: rm -f ~/.local/bin/claude; rm -rf ~/.local/share/claude).')));

    let run = 0;
    const refresh = async (force = false) => {
        const id = ++run;
        if (!force && !settings.get_boolean('writing-claude-code-enabled')) {
            status.subtitle = _('Switched off. Check again looks for Claude Code anyway.');
            return;
        }
        status.subtitle = _('Checking…');
        const show = text => {
            if (id === run)
                status.subtitle = text;
        };
        try {
            const bin = await locate().catch(() => null);
            if (!bin) {
                show(_('Not installed: see How to set it up.'));
                return;
            }
            const cwd = await workingFolder(paths);
            const found = await claudeVersion(bin, cwd);
            if (found.code === 'too-old') {
                show(_('Too old (%s; needs 2.1.259 or newer). Update Claude Code.').format(found.version));
                return;
            }
            const auth = await authCheck(bin, cwd);
            if (!auth.ok) {
                show({
                    'not-signed-in': _('Not signed in: run claude auth login in a terminal.'),
                    'api-key': _('Signed in for API billing or a cloud provider (not used): sign in with a Claude plan.'),
                    'not-a-plan': _('Signed in without a Pro, Max, Team or Enterprise plan.'),
                }[auth.code] ?? auth.message);
                return;
            }
            const plan = PLAN_NAMES[auth.plan] ? _('%s plan').format(PLAN_NAMES[auth.plan])
                : _('a long-lived token');
            show(_('Ready: %s · %s · %s').format(plan, found.version ?? '?', bin));
        } catch (e) {
            show(_('Could not check: %s').format(e.message));
        }
    };
    check.connect('clicked', () => refresh(true));
    // Only while this page is on screen (the switch above, Remove everything).
    settings.connect('changed::writing-claude-code-enabled', () => {
        if (group.get_mapped())
            refresh();
    });
    return {group, refresh};
}

function languageToolGroup(ctx) {
    const {settings} = ctx;
    const group = new Adw.PreferencesGroup({
        title: _('LanguageTool'),
        description: _('Grammar and spelling, online. Nothing to install and no account.'),
    });
    const enabled = new Adw.SwitchRow({title: _('Offer LanguageTool in the Writing tab')});
    settings.bind('writing-languagetool-enabled', enabled, 'active', Gio.SettingsBindFlags.DEFAULT);
    group.add(enabled);
    const status = new Adw.ActionRow({title: _('Status')});
    group.add(status);

    const variants = new Adw.EntryRow({
        title: _('Preferred language variants, such as en-GB,pt-BR'),
        show_apply_button: true,
    });
    const syncVariants = () => {
        variants.text = settings.get_string('writing-languagetool-variants');
        variants.remove_css_class('error');
    };
    syncVariants();
    settings.connect('changed::writing-languagetool-variants', syncVariants);
    variants.connect('apply', () => {
        const value = variants.text.replace(/\s+/g, '');
        if (value && !VARIANTS.test(value)) {
            variants.add_css_class('error');
            return;
        }
        settings.set_string('writing-languagetool-variants', value);
    });
    group.add(variants);

    group.add(stepsRow(_('How to set it up'), [
        [_('Nothing to install, and no account. Switch it on above.')],
        [_('Fix grammar sends the text to LanguageTool’s free public service (api.languagetool.org). It is limited to 20 requests a minute and 20 KB per request, with no guarantees. Froonty sends only when you click, and at most 10 times a minute.')],
        [_('The variants above tell LanguageTool which English, German, Portuguese… to assume when it detects the language.')],
    ]));
    const privacy = new Adw.ActionRow({
        title: _('Privacy'),
        subtitle: _('How LanguageTool handles the text it checks'),
    });
    privacy.add_suffix(new Gtk.LinkButton({
        uri: 'https://languagetool.org/legal/privacy',
        label: 'languagetool.org/legal/privacy',
        valign: Gtk.Align.CENTER,
    }));
    group.add(privacy);
    group.add(noteRow(_('Remove'), _('Nothing to remove: Froonty installs and keeps nothing for LanguageTool.')));

    const refresh = () => {
        const online = Gio.NetworkMonitor.get_default().connectivity === Gio.NetworkConnectivity.FULL;
        status.subtitle = online ? _('Ready (online service, no account)')
            : _('Offline: LanguageTool cannot be reached');
    };
    return {group, refresh};
}

function ollamaGroup(ctx) {
    const {settings, paths, window, operation} = ctx;
    const group = new Adw.PreferencesGroup({
        title: _('Ollama'),
        description: _('A model running on this computer: the text never leaves it. Ollama listens only on this computer (127.0.0.1).'),
    });
    const enabled = new Adw.SwitchRow({title: _('Offer Ollama in the Writing tab')});
    settings.bind('writing-ollama-enabled', enabled, 'active', Gio.SettingsBindFlags.DEFAULT);
    group.add(enabled);

    const status = new Adw.ActionRow({title: _('Status'), subtitle_selectable: true});
    group.add(status);

    const modelList = new Gtk.StringList();
    let modelNames = [];
    let syncingModels = false;
    const model = new Adw.ComboRow({title: _('Model'), model: modelList});
    model.connect('notify::selected', () => {
        const name = modelNames[model.selected];
        if (!syncingModels && name && name !== settings.get_string('writing-ollama-model'))
            settings.set_string('writing-ollama-model', name);
    });
    group.add(model);

    const actions = new Adw.ActionRow({title: _('Ollama on this computer')});
    const buttons = {
        setup: button(_('Set up…'), ['suggested-action']),
        start: button(_('Start')),
        stop: button(_('Stop')),
        download: button(_('Download model…')),
        remove: button(_('Remove…'), ['destructive-action']),
    };
    const box = new Gtk.Box({spacing: 6, valign: Gtk.Align.CENTER});
    for (const b of Object.values(buttons))
        box.append(b);
    actions.add_suffix(box);
    group.add(actions);

    const progressRow = new Adw.ActionRow({title: _('Working…'), visible: false});
    const bar = new Gtk.ProgressBar({valign: Gtk.Align.CENTER, hexpand: true, width_request: 160});
    const cancel = button(_('Cancel'));
    cancel.connect('clicked', () => operation.cancel());
    progressRow.add_suffix(bar);
    progressRow.add_suffix(cancel);
    group.add(progressRow);

    group.add(stepsRow(_('How to set it up'), [
        [_('A. Set up… (Froonty) downloads Ollama’s official Linux archive from GitHub (about 1.4 GB), checks it against Ollama’s published SHA-256, unpacks it into ~/.local/share/froonty/writing/ollama, and adds a user service, froonty-ollama.service. The service listens only on this computer, has Ollama’s cloud features off, and starts only when the Writing tab needs it. No administrator password. Remove… deletes all of it.')],
        [_('B. System-wide, by yourself, with Ollama’s official instructions. Its install script runs as administrator: it installs under /usr/local or /usr, creates an ollama system user, adds a system service that starts at boot, and with an NVIDIA card but no driver it may add NVIDIA’s package source and install drivers:'),
            'curl -fsSL https://ollama.com/install.sh | sh'],
        [_('Or follow the manual archive steps at docs.ollama.com/linux; uninstalling is described at docs.ollama.com/linux#uninstall. Froonty then uses that Ollama and never removes it. The ollama snap is not one of Ollama’s documented methods; Froonty does not use it.')],
        [_('Then download a model (Download model…, or in a terminal), and choose it above. A 3B model needs roughly 4 GB of free memory; without a supported graphics card it runs on the processor, more slowly.'),
            'ollama pull llama3.2:3b'],
    ]));

    const session = newSession(30);
    let url = null;
    try {
        url = baseUrl();
    } catch (e) {
        url = null;
    }
    let facts = null;

    const syncButtons = () => {
        const busy = operation.busy;
        progressRow.visible = busy;
        progressRow.title = operation.text || _('Working…');
        if (operation.fraction === null)
            bar.pulse();
        else
            bar.fraction = operation.fraction;
        for (const b of Object.values(buttons))
            b.sensitive = !busy;
        if (!facts)
            return;
        const own = facts.own && facts.step === 'done';
        buttons.setup.visible = !facts.own && !facts.running && !facts.systemBin;
        buttons.start.visible = own && !facts.running;
        buttons.stop.visible = own && facts.running;
        buttons.download.visible = facts.running || own;
        buttons.remove.visible = facts.own || facts.recordedModels > 0 || facts.unfinished ||
            facts.leftovers;
        actions.visible = Object.values(buttons).some(b => b.visible);
    };

    // setup/ollamaModels.js modelRows: with none chosen, "Choose a model"
    // is shown, so picking one (even the only one) saves it.
    const syncModels = () => {
        const chosen = settings.get_string('writing-ollama-model');
        const {rows, selected} = modelRows(facts?.models ?? [], chosen);
        const labels = rows.map(r => {
            if (r.kind === 'choose')
                return _('Choose a model');
            if (r.kind === 'missing')
                return _('%s (not downloaded)').format(r.name);
            return r.size ? `${r.name} (${GLib.format_size(r.size)})` : r.name;
        });
        syncingModels = true;
        modelNames = rows.map(r => r.name);
        modelList.splice(0, modelList.get_n_items(), labels);
        model.selected = selected < 0 ? Gtk.INVALID_LIST_POSITION : selected;
        model.sensitive = rows.length > 0;
        if (!rows.length)
            model.subtitle = _('No model yet: Download model…');
        else if (!chosen)
            model.subtitle = _('None chosen yet: pick one. Only models on this computer are listed');
        else
            model.subtitle = _('Only models on this computer; Ollama’s cloud models are never used');
        syncingModels = false;
    };

    const refresh = async () => {
        status.subtitle = _('Checking…');
        const state = await readState(paths);
        const running = url ? await probe({url, cache: new Map([['ollama-probe', session]])}) : {running: false, models: []};
        const system = await systemOllama().catch(() => ({binary: null, unit: null}));
        const own = Boolean(state.ollama?.installedByFroonty);
        facts = {
            own,
            step: state.ollama?.step ?? null,
            release: state.ollama?.release ?? null,
            running: running.running,
            version: running.version ?? null,
            models: running.models ?? [],
            systemBin: system.binary,
            systemUnit: system.unit,
            zstd: await exists('/usr/bin/zstd'),
            recordedModels: state.ollama?.models.length ?? 0,
            unfinished: Boolean(state.ollama && ((own && state.ollama.step !== 'done') ||
                state.ollama.models.some(m => m.step !== 'done'))),
            leftovers: await exists(paths.stagingDir) || await exists(paths.cacheDir) ||
                await exists(paths.ollamaPrefix),
        };
        syncStatus();
        syncModels();
        syncButtons();
    };

    // From the last facts and the model chosen now.
    const syncStatus = () => {
        if (!facts)
            return;
        const {own, systemBin} = facts;
        const chosen = settings.get_string('writing-ollama-model');
        const ready = facts.models.find(m => m.name === chosen);
        let text;
        if (facts.unfinished && own && facts.step !== 'done')
            text = _('An earlier set-up did not finish: Remove… cleans it up.');
        else if (own)
            text = _('Froonty’s Ollama %s · %s').format(facts.release ?? '', facts.running ? _('running') : _('stopped, starts when used'));
        else if (facts.running)
            text = _('Your Ollama %s · running').format(facts.version ?? '');
        else if (systemBin && facts.systemUnit)
            text = _('Your Ollama (%s) · not running: sudo systemctl start ollama').format(systemBin);
        else if (systemBin)
            text = _('Your Ollama (%s) · not running: start it with ollama serve').format(systemBin);
        else if (!facts.zstd)
            text = _('Not installed. Set up… needs zstd: sudo apt install zstd');
        else
            text = _('Not installed: see How to set it up');
        if (ready)
            text += `\n${_('Ready: %s (%s)').format(ready.name, GLib.format_size(ready.size ?? 0))}`;
        else if (facts.running && chosen)
            text += `\n${_('%s is not downloaded').format(chosen)}`;
        else if (!chosen && facts.models.length)
            text += `\n${_('No model chosen: choose one under Model.')}`;
        if (facts.unfinished && !(own && facts.step !== 'done'))
            text += `\n${_('A model download did not finish: Remove… forgets it.')}`;
        status.subtitle = text;
    };

    ctx.onOperation.push(syncButtons);
    settings.connect('changed::writing-ollama-model', () => {
        syncStatus();
        syncModels();
    });

    const deps = () => ({paths, session, url});

    buttons.setup.connect('clicked', () => operation.run(_('Could not set up Ollama'), async cancellable => {
        operation.progress(_('Checking this computer and Ollama’s latest release…'));
        const plan = await prepare(deps());
        const details = [
            _('Ollama %s for %s, from GitHub: %s, %s.').format(plan.version, plan.arch, plan.asset,
                GLib.format_size(plan.size)),
            _('SHA-256, the same in GitHub’s release and Ollama’s sha256sum.txt:'),
            plan.sha256,
            '',
            _('Creates:'),
            `  ${short(plan.prefix)}  (${_('Ollama, and later its models')})`,
            `  ${short(paths.cacheDir)}  (${_('the download, deleted once unpacked')})`,
            `  ${short(plan.unitFile)}:`,
            '',
            plan.unitText,
            _('Runs:'),
            ...plan.commands.map(argv => `  ${['systemctl', ...argv.slice(1)].join(' ')}`),
            '',
            _('No administrator password · nothing starts at login · listens on 127.0.0.1 only · cloud features off · a graphics card needs NVIDIA’s driver (untested) · Remove… deletes all of it.'),
        ].join('\n');
        const answer = await ask(window, {
            heading: _('Set up Ollama?'),
            body: _('Froonty downloads %s and installs Ollama for you only.').format(GLib.format_size(plan.size)),
            details,
            responses: [['cancel', _('Cancel')], ['setup', _('Download and set up'), Adw.ResponseAppearance.SUGGESTED]],
        });
        if (answer !== 'setup')
            return;
        await install(plan, deps(), {
            cancellable,
            onProgress: (stage, done, total) => {
                const text = {
                    downloading: _('Downloading Ollama: %s of %s').format(GLib.format_size(done), GLib.format_size(total)),
                    verifying: _('Checking the archive…'),
                    extracting: _('Unpacking…'),
                    unit: _('Adding the user service…'),
                    starting: _('Starting Ollama…'),
                }[stage] ?? stage;
                operation.progress(text, total ? done / total : null);
            },
        });
        await refresh();
        if (!facts.models.length)
            await downloadModel(cancellable);
    }).then(refresh));

    const downloadModel = async cancellable => {
        const names = [...MODEL_CHOICES.map(m => `${m.name} · ${m.size}${m.note ? ` · ${m.note}` : ''}`),
            _('Other name…')];
        const choice = new Adw.ComboRow({
            title: _('Model'),
            subtitle: _('Sizes as listed on ollama.com on %s; they may change').format(SIZES_DATE),
            model: Gtk.StringList.new(names),
        });
        const other = new Adw.EntryRow({title: _('Model name, such as mistral:7b'), visible: false});
        choice.connect('notify::selected', () => {
            other.visible = choice.selected === MODEL_CHOICES.length;
        });
        const list = new Gtk.ListBox({css_classes: ['boxed-list'], selection_mode: Gtk.SelectionMode.NONE});
        list.append(choice);
        list.append(other);
        const dialog = new Adw.AlertDialog({
            heading: _('Download a model'),
            body: _('Ollama downloads it from ollama.com. A model you already have is not downloaded again.'),
            extra_child: list,
        });
        dialog.add_response('cancel', _('Cancel'));
        dialog.add_response('download', _('Download'));
        dialog.set_response_appearance('download', Adw.ResponseAppearance.SUGGESTED);
        dialog.default_response = 'download';
        dialog.close_response = 'cancel';
        if (await dialog.choose(window, null) !== 'download')
            return;
        const name = choice.selected < MODEL_CHOICES.length ? MODEL_CHOICES[choice.selected].name
            : other.text.trim();
        if (!isModelName(name)) {
            await tell(window, _('Not a model name'), _('“%s” is not an Ollama model name.').format(name));
            return;
        }
        if (!facts?.running && facts?.own) {
            operation.progress(_('Starting Ollama…'));
            await startService(deps(), cancellable);
        }
        operation.progress(_('Downloading %s…').format(name));
        const result = await pullModel({
            ...deps(),
            name,
            cancellable,
            onProgress: (text, done, total) => operation.progress(total
                ? _('Downloading %s: %s of %s').format(name, GLib.format_size(done), GLib.format_size(total))
                : `${name}: ${text}`, total ? done / total : null),
        });
        settings.set_string('writing-ollama-model', result.name);
        if (!result.downloaded)
            await tell(window, _('Already there'), _('%s is already in Ollama; it was chosen, not downloaded again.').format(result.name));
    };

    buttons.download.connect('clicked', () =>
        operation.run(_('Could not download the model'), downloadModel).then(refresh));
    buttons.start.connect('clicked', () => operation.run(_('Could not start Ollama'), async cancellable => {
        operation.progress(_('Starting Ollama…'));
        await startService(deps(), cancellable);
    }).then(refresh));
    buttons.stop.connect('clicked', () => operation.run(_('Could not stop Ollama'), async cancellable => {
        operation.progress(_('Stopping Ollama…'));
        await stopService(deps(), cancellable);
    }).then(refresh));
    buttons.remove.connect('clicked', () => operation.run(_('Could not remove'), async () => {
        const state = await readState(paths);
        const found = await gatherFacts({...deps(), systemctl: ctx.systemctl, run: runProcess});
        const plan = ollamaRemovalPlan(state, found);
        const yours = plan.find(i => i.id === 'prefix')?.yourModels ?? [];
        const lines = plan.map(i => `• ${i.label}`);
        if (yours.length)
            lines.push('', _('Also deleted with Froonty’s Ollama, downloaded by you: %s').format(yours.join(', ')));
        if (plan.some(i => i.id === 'model') && !found.running)
            lines.push('', _('Ollama is not running: start it first, or the models stay.'));
        const answer = await ask(window, {
            heading: _('Remove what Froonty set up for Ollama?'),
            body: _('Only what Froonty installed or downloaded. An Ollama of your own, and models you downloaded yourself, stay.'),
            details: lines.join('\n'),
            responses: [['cancel', _('Cancel')], ['remove', _('Remove'), Adw.ResponseAppearance.DESTRUCTIVE]],
        });
        if (answer !== 'remove')
            return;
        operation.progress(_('Removing…'));
        const report = await execute(plan, {...deps(), run: runProcess, settings});
        await showReport(window, report);
    }).then(refresh));

    return {group, refresh};
}

async function showReport(window, {done, failed}) {
    const lines = [];
    if (done.length)
        lines.push(_('Removed:'), ...done.map(i => `• ${i.label}`));
    if (failed.length) {
        lines.push('', _('Could not remove:'),
            ...failed.map(({item, reason}) => `• ${item.label} (${reason})`));
    }
    lines.push('', _('Not removed:'), ...NOT_REMOVED.map(t => `• ${_(t)}`));
    await tell(window, failed.length ? _('Partly removed') : _('Removed'), '', lines.join('\n'));
}

function removeEverythingGroup(ctx, refreshAll) {
    const {settings, paths, window, operation} = ctx;
    const group = new Adw.PreferencesGroup({
        title: _('Remove everything'),
        description: _('Undoes all of Froonty’s Writing set-up: an Ollama Froonty installed and its service, the models Froonty downloaded, Claude Code’s records of Froonty’s working folder, Froonty’s Writing folders, and every Writing setting. You see the list first.'),
    });
    const row = new Adw.ActionRow({title: _('Remove everything Froonty set up for Writing')});
    const remove = button(_('Remove everything…'), ['destructive-action']);
    row.add_suffix(remove);
    group.add(row);
    ctx.onOperation.push(() => {
        remove.sensitive = !operation.busy;
    });
    remove.connect('clicked', () => operation.run(_('Could not remove everything'), async () => {
        operation.progress(_('Looking at what Froonty set up…'));
        const session = newSession(10);
        let url = null;
        try {
            url = baseUrl();
        } catch (e) {
            url = 'http://127.0.0.1:1';
        }
        const claudeBin = await locate().catch(() => null);
        const writingKeys = settings.settings_schema.list_keys().filter(k => k.startsWith('writing-')).sort();
        const state = await readState(paths);
        const facts = await gatherFacts({paths, session, url, systemctl: ctx.systemctl,
            run: runProcess, claudeBin, writingKeys});
        const plan = everythingRemovalPlan(state, facts);
        const lines = plan.map(i => `• ${i.label}`);
        if (facts.claude.hasRecords && facts.claude.dryRun)
            lines.push('', _('Claude Code’s records:'), facts.claude.dryRun);
        lines.push('', _('Not removed:'), ...NOT_REMOVED.map(t => `• ${_(t)}`));
        const answer = await ask(window, {
            heading: _('Remove everything Froonty set up for Writing?'),
            body: _('This cannot be undone.'),
            details: lines.join('\n'),
            responses: [['cancel', _('Cancel')], ['remove', _('Remove everything'), Adw.ResponseAppearance.DESTRUCTIVE]],
        });
        if (answer !== 'remove')
            return;
        operation.progress(_('Removing…'));
        const report = await execute(plan, {paths, run: runProcess, session, url, settings});
        await showReport(window, report);
    }).then(refreshAll));
    return group;
}

// Island size while the Writing tab is shown; applies live. As Clipboard's.
function sizeGroup(settings) {
    const reset = new Gtk.Button({
        label: _('Default size'),
        valign: Gtk.Align.CENTER,
        css_classes: ['flat'],
    });
    const group = new Adw.PreferencesGroup({
        title: _('Size'),
        description: _('Of the island while the Writing tab is shown, in logical pixels.'),
        header_suffix: reset,
    });
    for (const [key, title] of [['writing-width', _('Width')], ['writing-height', _('Height')]]) {
        const [, [lower, upper]] = settings.settings_schema.get_key(key)
            .get_range().recursiveUnpack();
        const row = Adw.SpinRow.new_with_range(lower, upper, 1);
        row.title = title;
        settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(row);
    }
    const sync = () => {
        reset.tooltip_text = SIZE_KEYS.map(key => settings.get_default_value(key).unpack()).join(' × ');
        reset.sensitive = SIZE_KEYS.some(key => settings.get_user_value(key) !== null);
    };
    sync();
    for (const key of SIZE_KEYS)
        settings.connect(`changed::${key}`, sync);
    reset.connect('clicked', () => SIZE_KEYS.forEach(key => settings.reset(key)));
    return group;
}

export function writingPage(settings, window) {
    const page = new Adw.PreferencesPage({
        name: 'writing',
        title: _('Writing'),
        icon_name: 'tools-check-spelling-symbolic',
    });
    let systemctl = '/usr/bin/systemctl';
    try {
        systemctl = override('FROONTY_SYSTEMCTL') ?? systemctl;
    } catch (e) {
        systemctl = '/bin/false';
    }
    const ctx = {settings, window, paths: defaultPaths(), systemctl, onOperation: []};
    ctx.operation = new Operation(window, () => ctx.onOperation.forEach(f => f()));

    page.add(tabGroup(settings));
    const claude = claudeGroup(ctx);
    page.add(claude.group);
    const languageTool = languageToolGroup(ctx);
    page.add(languageTool.group);
    const ollama = ollamaGroup(ctx);
    page.add(ollama.group);
    const refreshAll = () => {
        claude.refresh();
        languageTool.refresh();
        ollama.refresh().catch(e => console.warn(`Froonty: Writing settings: ${e.message}`));
    };
    page.add(removeEverythingGroup(ctx, refreshAll));
    page.add(sizeGroup(settings));
    // Statuses are read when the page comes on screen, not before.
    page.connect('map', refreshAll);
    return page;
}
