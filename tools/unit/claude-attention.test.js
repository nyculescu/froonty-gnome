// SPDX-License-Identifier: GPL-3.0-or-later
// "When Claude needs you" (docs/features/claude-attention.md): the shared
// logic, the hook script as Claude Code runs it, the settings.json set-up,
// and the Shell-free service with fakes for the Shell side.
//
// Isolation: every file is under a temporary folder; every hook script or
// `sh` run gets a private XDG_RUNTIME_DIR, and Claude Code's own variables
// are unset or set explicitly (these tests may run inside a Claude Code
// session). The real ~/.claude is never read or written.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {test, eq, ok, done} from './test.js';
import * as A from '../../froonty@catalin/features/claude/attention.js';
import * as Setup from '../../froonty@catalin/features/claude/attentionSetup.js';
import * as StatusLine from '../../froonty@catalin/features/claude/statusLineSetup.js';

const GJS = GLib.getenv('GJS') || '/usr/bin/gjs';
const HOOK = Setup.hookScriptPath();
const CLAUDE_VARS = ['CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_PID', 'CLAUDE_CODE_SESSION_ID',
    'CLAUDE_PROJECT_DIR', 'CHROME_DESKTOP', 'XDG_RUNTIME_DIR', 'XDG_CACHE_HOME'];

const decode = bytes => new TextDecoder().decode(bytes);
const readText = file => decode(file.load_contents(null)[1]);
const tempPath = (name = 'froonty-attention-XXXXXX') => GLib.dir_make_tmp(name);
const exists = path => GLib.file_test(path, GLib.FileTest.EXISTS);
const modeOf = path => Gio.File.new_for_path(path).query_info('unix::mode',
    Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null).get_attribute_uint32('unix::mode') & 0o777;

function selfStart() {
    return A.parseProcStat(decode(GLib.file_get_contents('/proc/self/stat')[1])).start;
}

// ---- attention.js

test('actionFor: Notification types to a kind, a clear or nothing', () => {
    const n = type => A.actionFor('notification', {notification_type: type});
    eq(n('permission_prompt'), {kind: 'permission'});
    eq(n('worker_permission_prompt'), {kind: 'permission'});
    eq(n('elicitation_dialog'), {kind: 'input'});
    eq(n('elicitation_url_dialog'), {kind: 'input'});
    eq(n('agent_needs_input'), {kind: 'input'});
    eq(n('idle_prompt'), {kind: 'waiting'});
    eq(n('quota_auto_resume_stale'), {kind: 'waiting'});
    eq(n('elicitation_complete'), {clear: true});
    eq(n('elicitation_response'), {clear: true});
    for (const type of ['auth_success', 'agent_completed', 'quota_auto_resume_fired', 'something_new',
        'constructor', '__proto__', undefined, 7])
        eq(n(type), null, String(type));
    eq(A.actionFor('notification', {}), null);
});

test('actionFor: Stop is finished unless paused for background work; StopFailure is an error', () => {
    eq(A.actionFor('stop', {}), {kind: 'finished'});
    eq(A.actionFor('stop', {background_tasks: [], session_crons: []}), {kind: 'finished'});
    eq(A.actionFor('stop', {background_tasks: [{id: 't'}]}), {clear: true});
    eq(A.actionFor('stop', {session_crons: [{id: 'c'}]}), {clear: true});
    eq(A.actionFor('stop', {background_tasks: 'yes'}), {kind: 'finished'});
    eq(A.actionFor('stop-failure', {error: 'rate_limit'}), {kind: 'error'});
    eq(A.actionFor('pre-tool-use', {}), null);
    eq(A.actionFor(undefined, {}), null);
});

const EXAMPLE = '{"v":1,"kind":"permission","at":1790819528707,"session":"0b9f2c1e-aa","entrypoint":"claude-vscode",' +
    '"project":"Froonty","pids":[[1234567,98765432],[1234500,98765000],[618287,9000000]],' +
    '"desktop":"com.microsoft.VSCode.desktop"}';

test('parseEntry: the documented example, frozen; extra fields ignored', () => {
    const e = A.parseEntry(EXAMPLE, '0b9f2c1e-aa');
    ok(e, 'parsed');
    eq([e.kind, e.at, e.session, e.entrypoint, e.project, e.desktop],
        ['permission', 1790819528707, '0b9f2c1e-aa', 'claude-vscode', 'Froonty', 'com.microsoft.VSCode.desktop']);
    eq(e.pids, [[1234567, 98765432], [1234500, 98765000], [618287, 9000000]]);
    ok(Object.isFrozen(e) && Object.isFrozen(e.pids) && Object.isFrozen(e.pids[0]));
    const extra = JSON.parse(EXAMPLE);
    extra.later = {anything: true};
    ok(A.parseEntry(JSON.stringify(extra), '0b9f2c1e-aa'), 'extra field');
    const noDesktop = JSON.parse(EXAMPLE);
    delete noDesktop.desktop;
    eq(A.parseEntry(JSON.stringify(noDesktop), '0b9f2c1e-aa').desktop, null);
    ok(A.parseEntry(new TextEncoder().encode(EXAMPLE), '0b9f2c1e-aa'), 'bytes');
});

test('parseEntry: rejects every malformed field', () => {
    const base = JSON.parse(EXAMPLE);
    const bad = changes => JSON.stringify({...base, ...changes});
    const cases = {
        'wrong v': bad({v: 2}),
        'unknown kind': bad({kind: 'urgent'}),
        'session not the file name': bad({session: 'other'}),
        'unknown entrypoint': bad({entrypoint: 'sdk-cli'}),
        'more than 16 pids': bad({pids: Array.from({length: 17}, (_, i) => [i + 2, 1])}),
        'no pids': bad({pids: []}),
        'a non-integer pid': bad({pids: [[12.5, 3]]}),
        'a pid of 1': bad({pids: [[1, 3]]}),
        'a negative start': bad({pids: [[1234, -1]]}),
        'a project of 129 characters': bad({project: 'x'.repeat(129)}),
        'a project with a newline': bad({project: 'a\nb'}),
        'a bad desktop id': bad({desktop: '../evil.desktop'}),
        'a desktop id of null': bad({desktop: null}),
        'at not a number': bad({at: '1790819528707'}),
        'more than 4096 bytes': bad({padding: 'x'.repeat(4096)}),
        'a JSON array': '[1, 2]',
        'not JSON': '{"v": 1,',
    };
    for (const [name, text] of Object.entries(cases))
        eq(A.parseEntry(text, '0b9f2c1e-aa'), null, name);
    ok(A.parseEntry(bad({project: 'é'.repeat(128)}), '0b9f2c1e-aa'), '128 code points are fine');
});

test('parseProcStat: a command name with spaces and parentheses', () => {
    const fields = Array.from({length: 50}, (_, i) => String(i + 3));
    fields[1] = '4242';
    fields[19] = '987654';
    eq(A.parseProcStat(`1234 (my (odd) name) ${fields.join(' ')}\n`), {ppid: 4242, start: 987654});
    eq(A.parseProcStat('1234 (x) S'), null);
    eq(A.parseProcStat('garbage'), null);
    ok(A.parseProcStat(decode(GLib.file_get_contents('/proc/self/stat')[1])).start > 0);
});

test('projectName: the project folder wins over cwd; only a cleaned basename', () => {
    eq(A.projectName('/home/u/src/Froonty', '/tmp/elsewhere'), 'Froonty');
    eq(A.projectName(null, '/home/u/src/Beta'), 'Beta');
    eq(A.projectName('', '/home/u/src/Beta/'), 'Beta');
    eq(A.projectName('/', '/home/u'), '');
    eq(A.projectName(null, '.'), '');
    eq(A.projectName(null, null), '');
    eq(A.projectName('/x/a\u0007b\nc', null), 'abc');
    eq([...A.projectName(`/x/${'ü'.repeat(200)}`, null)].length, 128);
});

test('compareEntries: kind first, then newest, then id', () => {
    const e = (id, kind, at) => ({id, kind, at});
    const sorted = [e('a', 'finished', 300), e('b', 'permission', 100), e('c', 'permission', 200),
        e('d', 'waiting', 50), e('e', 'permission', 200)].sort(A.compareEntries).map(x => x.id);
    eq(sorted, ['c', 'e', 'b', 'd', 'a']);
});

test('appNotificationKind and mentionsClaudeAi', () => {
    eq(A.appNotificationKind('Allow Claude to run git push?'), 'permission');
    eq(A.appNotificationKind('Claude is waiting for your input'), 'waiting');
    eq(A.appNotificationKind('Claude finished a task'), 'finished');
    eq(A.appNotificationKind('Something else happened'), 'attention');
    eq(A.appNotificationKind(null), 'attention');
    ok(A.mentionsClaudeAi('Claude responded', 'Reply ready · claude.ai'));
    ok(A.mentionsClaudeAi('CLAUDE.AI', ''));
    ok(!A.mentionsClaudeAi('Claude Dupont: lunch?', 'See you at noon'));
    ok(!A.mentionsClaudeAi(null, undefined));
});

test('placeText: project and app, or what the session runs in', () => {
    eq(A.placeText({origin: 'hook', project: 'Alpha', appName: 'Visual Studio Code', entrypoint: 'claude-vscode'}),
        'Alpha · Visual Studio Code');
    eq(A.placeText({origin: 'hook', project: 'Alpha', appName: null, entrypoint: 'claude-vscode'}), 'Alpha · VS Code');
    eq(A.placeText({origin: 'hook', project: '', appName: null, entrypoint: 'claude-desktop'}), 'Claude');
    eq(A.placeText({origin: 'hook', project: 'Alpha', appName: null, entrypoint: ''}), 'Alpha · Claude Code');
    eq(A.placeText({origin: 'app', title: 'Froonty'}), 'Froonty · Claude');
    eq(A.placeText({origin: 'app', title: null}), 'Claude');
    eq(A.placeText({origin: 'browser', appName: 'Brave Web Browser'}), 'Brave Web Browser');
});

test('pickWindow: one window is for sure; of several, only one title naming the project is', () => {
    const vscode = ['a.js - Alpha - Visual Studio Code', 'b.js - Beta - Visual Studio Code'];
    eq(A.pickWindow([], 'Alpha'), null);
    eq(A.pickWindow(null, 'Alpha'), null);
    eq(A.pickWindow(['✳ Claude Code'], 'Alpha'), {index: 0, exact: true}, 'one window, whatever its title');
    eq(A.pickWindow(vscode, 'Alpha'), {index: 0, exact: true});
    eq(A.pickWindow(vscode, 'Beta'), {index: 1, exact: true});
    eq(A.pickWindow(['x — Alpha — Editor', 'y – Beta – Editor', 'Gamma'], 'Beta'), {index: 1, exact: true},
        'em and en dashes separate too');
    eq(A.pickWindow(['Gamma', 'Delta'], 'Gamma'), {index: 0, exact: true}, 'the whole title is a part');
    eq(A.pickWindow(['a - Alpha - Code', 'b - Alpha - Code', 'Beta'], 'Alpha'), {index: 0, exact: false},
        'two windows name it: the most recent, not for sure');
    eq(A.pickWindow(['✳ Claude Code', 'catalin@host: ~/src/Froonty'], 'Froonty'), {index: 1, exact: false},
        'a shell title containing the folder is a guess, not for sure');
    eq(A.pickWindow(['a - Alpha-Two - Code', 'Beta'], 'Alpha'), {index: 0, exact: false},
        'a part only containing it is a guess');
    eq(A.pickWindow(['one', 'two'], 'Alpha'), {index: 0, exact: false}, 'no match: the most recent');
    eq(A.pickWindow(['a - Alpha - Code', 'b - Beta - Code'], ''), {index: 0, exact: false}, 'no project');
    eq(A.pickWindow([null, 'b - Beta - Code'], 'Beta'), {index: 1, exact: true}, 'a window without a title');
    eq(A.pickWindow(['a-Alpha-Code', 'Beta'], 'Alpha'), {index: 0, exact: false}, 'a dash needs spaces');
});

test('quietWhileLooking: a reply\'s end anywhere; in a terminal nothing else', () => {
    const q = (kind, entrypoint) => A.quietWhileLooking({kind, entrypoint});
    for (const entrypoint of ['', 'cli', 'claude-vscode', 'claude-desktop']) {
        ok(q('finished', entrypoint), `finished ${entrypoint}`);
        ok(q('error', entrypoint), `error ${entrypoint}`);
    }
    for (const kind of ['permission', 'input', 'waiting']) {
        ok(!q(kind, 'cli'), `${kind} cli`);
        ok(!q(kind, ''), `${kind} unset`);
        ok(q(kind, 'claude-vscode'), `${kind} VS Code`);
        ok(q(kind, 'claude-desktop'), `${kind} Claude app`);
    }
});

test('clearedByAppFocus: only a permission or a question', () => {
    eq(A.KINDS.filter(A.clearedByAppFocus), ['permission', 'input']);
});

// A subprocess with a private runtime folder and none of Claude Code's own
// variables unless the test sets them.
function launcher(env = {}, flags = Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE |
    Gio.SubprocessFlags.STDERR_PIPE) {
    const l = new Gio.SubprocessLauncher({flags});
    for (const name of CLAUDE_VARS)
        l.unsetenv(name);
    for (const [name, value] of Object.entries(env)) {
        if (value === null)
            l.unsetenv(name);
        else
            l.setenv(name, String(value), true);
    }
    return l;
}

function run(argv, env, input = '') {
    const proc = launcher(env).spawnv(argv);
    const [, stdout, stderr] = proc.communicate_utf8(input, null);
    return {status: proc.get_if_exited() ? proc.get_exit_status() : -1, stdout, stderr};
}

test('stateDir: XDG_RUNTIME_DIR, else the cache folder, as the clear command', () => {
    const tmp = tempPath();
    const probe = Gio.File.new_for_path(`${tmp}/probe.js`);
    probe.replace_contents(`import {stateDir} from '${Gio.File.new_for_path(
        HOOK).get_parent().get_child('attention.js').get_uri()}';\nprint(stateDir().get_path());\n`,
    null, false, Gio.FileCreateFlags.NONE, null);
    const runtime = tempPath();
    eq(run([GJS, '-m', probe.get_path()], {XDG_RUNTIME_DIR: runtime}).stdout.trim(),
        `${runtime}/froonty/claude-attention`);
    const cache = tempPath();
    eq(run([GJS, '-m', probe.get_path()], {XDG_CACHE_HOME: cache}).stdout.trim(),
        `${cache}/froonty/claude-attention`);
});

// ---- the hook script, run as Claude Code runs it

function runtimeWithState() {
    const runtime = tempPath();
    const dir = `${runtime}/froonty/claude-attention`;
    GLib.mkdir_with_parents(dir, 0o700);
    return {runtime, dir};
}

function hook(event, input, env) {
    const text = typeof input === 'string' ? input : JSON.stringify(input);
    return run([GJS, '-m', HOOK, event], env, text);
}

const notification = (session, type, extra = {}) => ({session_id: session, transcript_path: '/home/u/.claude/projects/x/t.jsonl',
    cwd: '/tmp/Elsewhere', hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash',
    title: 'Permission needed', notification_type: type, ...extra});

test('hook: without the state folder (Froonty not listening) nothing is written', () => {
    const runtime = tempPath();
    const r = hook('notification', notification('s1', 'permission_prompt'),
        {XDG_RUNTIME_DIR: runtime, CLAUDE_CODE_ENTRYPOINT: 'claude-vscode', CLAUDE_PID: 0});
    eq([r.status, r.stdout], [0, '']);
    ok(!exists(`${runtime}/froonty`), 'folder never created');
});

test('hook: a permission prompt is recorded, without any of Claude\'s text', () => {
    const {runtime, dir} = runtimeWithState();
    const pid = new Gio.Credentials().get_unix_pid();
    const r = hook('notification', notification('s-1', 'permission_prompt'), {
        XDG_RUNTIME_DIR: runtime, CLAUDE_CODE_ENTRYPOINT: 'claude-vscode',
        CLAUDE_PID: pid, CLAUDE_PROJECT_DIR: '/tmp/Alpha',
    });
    eq([r.status, r.stdout, r.stderr], [0, '', '']);
    const path = `${dir}/s-1.json`;
    const text = readText(Gio.File.new_for_path(path));
    const e = A.parseEntry(text, 's-1');
    ok(e, text);
    eq([e.kind, e.project, e.entrypoint], ['permission', 'Alpha', 'claude-vscode']);
    eq(e.pids[0], [pid, selfStart()]);
    ok(e.pids.length >= 2 && e.pids.length <= 16, `${e.pids.length} pids`);
    ok(Math.abs(e.at - Date.now()) < 30000);
    eq(modeOf(path), 0o600);
    eq(modeOf(dir), 0o700);
    const parent = Gio.File.new_for_path(`${runtime}/froonty`);
    const names = [];
    const children = parent.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
    for (let info; (info = children.next_file(null));)
        names.push(info.get_name());
    eq(names, ['claude-attention'], 'no temporary file left');
    for (const secret of ['Claude needs your permission', 'transcript', '/tmp/Alpha', '/tmp/Elsewhere',
        'notification_type', 'permission_prompt', 'Permission needed'])
        ok(!text.includes(secret), `"${secret}" must not be in the file`);
});

test('hook: Stop is finished (never the reply); with background work it clears', () => {
    const {runtime, dir} = runtimeWithState();
    const env = {XDG_RUNTIME_DIR: runtime, CLAUDE_CODE_ENTRYPOINT: 'cli'};
    const r = hook('stop', {session_id: 's2', hook_event_name: 'Stop', last_assistant_message: 'SECRET-TEXT',
        background_tasks: [], session_crons: []}, env);
    eq([r.status, r.stdout], [0, '']);
    const text = readText(Gio.File.new_for_path(`${dir}/s2.json`));
    eq(A.parseEntry(text, 's2').kind, 'finished');
    ok(!text.includes('SECRET-TEXT'));
    hook('stop', {session_id: 's2', background_tasks: [{id: 'x', type: 'shell', command: 'tail -f log'}]}, env);
    ok(!exists(`${dir}/s2.json`), 'deleted while paused for background work');
});

test('hook: elicitation_complete clears; auth_success changes nothing; StopFailure is an error', () => {
    const {runtime, dir} = runtimeWithState();
    const env = {XDG_RUNTIME_DIR: runtime, CLAUDE_CODE_ENTRYPOINT: 'cli'};
    hook('notification', notification('s3', 'elicitation_dialog'), env);
    const before = readText(Gio.File.new_for_path(`${dir}/s3.json`));
    eq(A.parseEntry(before, 's3').kind, 'input');
    hook('notification', notification('s3', 'auth_success'), env);
    eq(readText(Gio.File.new_for_path(`${dir}/s3.json`)), before);
    hook('notification', notification('s3', 'elicitation_complete'), env);
    ok(!exists(`${dir}/s3.json`));
    hook('stop-failure', {session_id: 's3', error: 'rate_limit', last_assistant_message: 'API Error'}, env);
    eq(A.parseEntry(readText(Gio.File.new_for_path(`${dir}/s3.json`)), 's3').kind, 'error');
});

test('hook: -p runs, MCP servers and remote sessions are never recorded', () => {
    const {runtime, dir} = runtimeWithState();
    for (const entrypoint of ['sdk-cli', 'sdk-ts', 'mcp', 'remote', 'claude-code-github-action']) {
        const r = hook('notification', notification('s4', 'permission_prompt'),
            {XDG_RUNTIME_DIR: runtime, CLAUDE_CODE_ENTRYPOINT: entrypoint});
        eq([r.status, r.stdout], [0, ''], entrypoint);
        ok(!exists(`${dir}/s4.json`), entrypoint);
    }
});

test('hook: unreadable input falls back to CLAUDE_CODE_SESSION_ID for Stop only', () => {
    const {runtime, dir} = runtimeWithState();
    const env = {XDG_RUNTIME_DIR: runtime, CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_SESSION_ID: 'abc'};
    eq(hook('notification', 'not json', env).status, 0);
    ok(!exists(`${dir}/abc.json`), 'no notification type, nothing to say');
    eq(hook('stop', 'not json', env).status, 0);
    eq(A.parseEntry(readText(Gio.File.new_for_path(`${dir}/abc.json`)), 'abc').kind, 'finished');
});

test('hook: 2 MiB of input is read', () => {
    const {runtime, dir} = runtimeWithState();
    const input = notification('big', 'permission_prompt', {padding: 'x'.repeat(2 << 20)});
    const r = hook('notification', input, {XDG_RUNTIME_DIR: runtime, CLAUDE_CODE_ENTRYPOINT: 'cli'});
    eq([r.status, r.stdout], [0, '']);
    ok(exists(`${dir}/big.json`));
});

test('hook: a state "folder" that is a file, or a bad session id, writes nothing', () => {
    const runtime = tempPath();
    GLib.mkdir_with_parents(`${runtime}/froonty`, 0o700);
    GLib.file_set_contents(`${runtime}/froonty/claude-attention`, 'not a folder');
    const r = hook('notification', notification('s5', 'permission_prompt'),
        {XDG_RUNTIME_DIR: runtime, CLAUDE_CODE_ENTRYPOINT: 'cli'});
    eq([r.status, r.stdout], [0, '']);
    eq(readText(Gio.File.new_for_path(`${runtime}/froonty/claude-attention`)), 'not a folder');

    const {runtime: runtime2, dir} = runtimeWithState();
    for (const id of ['../x', '', 'a b', 'x'.repeat(129)]) {
        const r2 = hook('notification', notification(id, 'permission_prompt'),
            {XDG_RUNTIME_DIR: runtime2, CLAUDE_CODE_ENTRYPOINT: 'cli'});
        eq(r2.status, 0, id);
    }
    const listing = Gio.File.new_for_path(dir).enumerate_children('standard::name',
        Gio.FileQueryInfoFlags.NONE, null);
    eq(listing.next_file(null), null, 'nothing written');
    ok(!exists(`${runtime2}/froonty/x.json`));
});

test('hook: CHROME_DESKTOP is kept only when it is a desktop id', () => {
    const {runtime, dir} = runtimeWithState();
    const env = desktop => ({XDG_RUNTIME_DIR: runtime, CLAUDE_CODE_ENTRYPOINT: 'claude-vscode',
        CHROME_DESKTOP: desktop});
    hook('notification', notification('s6', 'permission_prompt'), env('com.microsoft.VSCode.desktop'));
    eq(A.parseEntry(readText(Gio.File.new_for_path(`${dir}/s6.json`)), 's6').desktop, 'com.microsoft.VSCode.desktop');
    hook('notification', notification('s6', 'permission_prompt'), env('../evil'));
    eq(A.parseEntry(readText(Gio.File.new_for_path(`${dir}/s6.json`)), 's6').desktop, null);
});

// ---- settings.json set-up

const SCRIPT = '/home/u/.local/share/gnome-shell/extensions/froonty@catalin/features/claude/attentionHook.js';
const OTHER_COPY = '/run/media/u/src/Froonty/froonty@catalin/features/claude/attentionHook.js';
const G = '/usr/bin/gjs';

function settingsFile(content) {
    const file = Gio.File.new_for_path(`${tempPath('froonty-claude-settings-XXXXXX')}/settings.json`);
    if (content !== undefined)
        file.replace_contents(typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`,
            null, false, Gio.FileCreateFlags.NONE, null);
    return file;
}

const readJson = file => JSON.parse(readText(file));
const gjsHook = (event, script = SCRIPT) =>
    ({type: 'command', command: G, args: ['-m', script, event], async: true});

// Exactly what the feature doc (section 7) says Set up adds.
const OURS = {
    Notification: [{matcher: 'permission_prompt|worker_permission_prompt|elicitation_dialog|elicitation_url_dialog|' +
        'elicitation_complete|elicitation_response|agent_needs_input|idle_prompt|quota_auto_resume_stale',
    hooks: [gjsHook('notification')]}],
    Stop: [{hooks: [gjsHook('stop')]}],
    StopFailure: [{hooks: [gjsHook('stop-failure')]}],
    UserPromptSubmit: [{hooks: [{type: 'command', command: Setup.CLEAR_COMMAND, async: true}]}],
    PostToolBatch: [{hooks: [{type: 'command', command: Setup.CLEAR_COMMAND, async: true}]}],
    SessionEnd: [{hooks: [{type: 'command', command: Setup.CLEAR_COMMAND}]}],
};

test('setup: the script is this copy\'s hook, which does nothing when imported', () => {
    // This test process imported it (through attentionSetup.js): had it
    // run, it would have read this process's stdin.
    ok(HOOK.endsWith('/froonty@catalin/features/claude/attentionHook.js'), HOOK);
    ok(GLib.file_test(HOOK, GLib.FileTest.EXISTS));
    ok(Setup.isOursHandler({type: 'command', command: Setup.gjsPath(), args: ['-m', HOOK, 'stop']}));
});

test('setup: the clear command is the documented one', () => {
    eq(Setup.CLEAR_COMMAND, 'case "$CLAUDE_CODE_SESSION_ID" in ""|*[!0-9A-Za-z-]*) ;; *) rm -f -- ' +
        '"${XDG_RUNTIME_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}}/froonty/claude-attention/$CLAUDE_CODE_SESSION_ID.json" ;; esac');
});

test('setup: install into no file, and into a file with other keys (kept, in order)', () => {
    const none = settingsFile();
    eq(Setup.installAttentionHooks(none, SCRIPT, G), null);
    eq(readJson(none), {hooks: OURS});
    eq(readText(none), `${JSON.stringify({hooks: OURS}, null, 2)}\n`);
    eq(Setup.attentionHooksState(readJson(none), G, SCRIPT), {state: 'ours', disableAllHooks: false});

    const other = {model: 'opus', permissions: {allow: ['Bash(ls)']}, theme: 'dark'};
    const file = settingsFile(other);
    eq(Setup.installAttentionHooks(file, SCRIPT, G), null);
    const after = readText(file);
    eq(after, `${JSON.stringify({...other, hooks: OURS}, null, 2)}\n`);
    eq(Setup.installAttentionHooks(file, SCRIPT, G), null);
    eq(readText(file), after, 'a second Set up is byte-identical');
});

const USER_HOOKS = {
    Notification: [{matcher: 'permission_prompt', hooks: [{type: 'command', command: 'notify-send Claude'}]}],
    PreToolUse: [{matcher: 'Bash', hooks: [{type: 'command', command: '~/bin/check.sh'}]}],
    Stop: [{hooks: [{type: 'command', command: 'paplay ~/done.oga', async: true}]}],
    PostToolBatch: [{hooks: [{type: 'command', command: '~/bin/batch.sh'}]}],
};

test('setup: the user\'s own hooks stay untouched; Froonty\'s go in groups of their own after them', () => {
    const original = {model: 'opus', hooks: USER_HOOKS, statusLine: {type: 'command', command: '~/line.sh'}};
    const file = settingsFile(original);
    eq(Setup.installAttentionHooks(file, SCRIPT, G), null);
    const after = readJson(file);
    eq(Object.keys(after), ['model', 'hooks', 'statusLine'], 'hooks keeps its place');
    eq(Object.keys(after.hooks), ['Notification', 'PreToolUse', 'Stop', 'PostToolBatch',
        'StopFailure', 'UserPromptSubmit', 'SessionEnd']);
    eq(after.hooks.Notification, [...USER_HOOKS.Notification, ...OURS.Notification]);
    eq(after.hooks.PreToolUse, USER_HOOKS.PreToolUse);
    eq(after.hooks.Stop, [...USER_HOOKS.Stop, ...OURS.Stop]);
    eq(after.hooks.PostToolBatch, [...USER_HOOKS.PostToolBatch, ...OURS.PostToolBatch]);
    for (const event of ['StopFailure', 'UserPromptSubmit', 'SessionEnd'])
        eq(after.hooks[event], OURS[event], event);
    eq(Setup.attentionHooksState(after, G, SCRIPT).state, 'ours');
    const text = readText(file);
    eq(Setup.installAttentionHooks(file, SCRIPT, G), null);
    eq(readText(file), text, 'byte-identical');

    eq(Setup.removeAttentionHooks(file), null);
    eq(readJson(file), original, 'Remove restores the original');
    eq(Setup.attentionHooksState(readJson(file), G, SCRIPT).state, 'none');
});

test('setup: Remove keeps a user\'s empty group and list; with nothing of ours it writes nothing', () => {
    const original = {hooks: {Stop: [{hooks: []}], PreToolUse: []}};
    const file = settingsFile(original);
    eq(Setup.installAttentionHooks(file, SCRIPT, G), null);
    eq(Setup.removeAttentionHooks(file), null);
    eq(readJson(file), original);

    const odd = '{"model":"opus",   "hooks": {"Stop": []}}';
    const untouched = settingsFile(odd);
    eq(Setup.removeAttentionHooks(untouched), null);
    eq(readText(untouched), odd, 'not rewritten');
    const noHooks = settingsFile('{"model": "opus"}');
    eq(Setup.removeAttentionHooks(noHooks), null);
    eq(readText(noHooks), '{"model": "opus"}');
    eq(Setup.removeAttentionHooks(settingsFile()), null, 'no file');
});

test('setup: errors leave the file byte-identical', () => {
    for (const content of ['{"hooks": ', '[1, 2]', '{"hooks": []}', '{"hooks": {"Stop": {}}}',
        '{"hooks": {"SessionEnd": "rm"}}']) {
        const file = settingsFile(content);
        const error = Setup.installAttentionHooks(file, SCRIPT, G);
        ok(typeof error === 'string' && error.length > 0, `${content}: ${error}`);
        eq(readText(file), content, content);
    }
    eq(Setup.installAttentionHooks(settingsFile('{"hooks": {"Stop": {}}}'), SCRIPT, G), 'hooks.Stop is not a list');
    const bad = settingsFile('{"hooks": ');
    ok(Setup.removeAttentionHooks(bad) !== null);
    eq(readText(bad), '{"hooks": ');
});

test('setup: which handlers are Froonty\'s', () => {
    for (const h of [gjsHook('stop'), gjsHook('notification', OTHER_COPY),
        {type: 'command', command: '/usr/bin/gjs-console', args: ['-m', SCRIPT, 'stop-failure']},
        {type: 'command', command: 'gjs', args: ['-m', '/home/o\'neil/my dir/froonty@catalin/features/claude/attentionHook.js', 'stop']},
        {type: 'command', command: Setup.CLEAR_COMMAND, async: true}])
        ok(Setup.isOursHandler(h), JSON.stringify(h));
    for (const h of [
        {type: 'command', command: `/usr/bin/gjs -m ${SCRIPT} stop`},
        {type: 'command', command: `sh -c '/usr/bin/gjs -m ${SCRIPT} stop; notify-send done'`},
        {type: 'command', command: G, args: ['-m', SCRIPT]},
        {type: 'command', command: G, args: ['-m', SCRIPT, 'stop', '--extra']},
        {type: 'command', command: G, args: ['-m', SCRIPT, 'pre-tool-use']},
        {type: 'command', command: G, args: ['-m', '/tmp/attentionHook.js', 'stop']},
        {type: 'command', command: '/usr/bin/node', args: ['-m', SCRIPT, 'stop']},
        {type: 'command', command: Setup.CLEAR_COMMAND.replace('rm -f', 'rm -rf')},
        {type: 'http', command: Setup.CLEAR_COMMAND},
        null,
    ])
        ok(!Setup.isOursHandler(h), JSON.stringify(h));
});

test('setup: another copy\'s hooks are outdated; Update makes them this copy\'s', () => {
    const file = settingsFile({hooks: USER_HOOKS});
    eq(Setup.installAttentionHooks(file, OTHER_COPY, G), null);
    eq(Setup.attentionHooksState(readJson(file), G, SCRIPT).state, 'outdated');
    eq(Setup.attentionHooksState(readJson(file), G, OTHER_COPY).state, 'ours');
    eq(Setup.installAttentionHooks(file, SCRIPT, G), null);
    const after = readJson(file);
    eq(Setup.attentionHooksState(after, G, SCRIPT).state, 'ours');
    ok(!JSON.stringify(after).includes(OTHER_COPY), 'the other copy is gone');

    // Partly removed by hand, or an extra copy: outdated too.
    const partial = JSON.parse(JSON.stringify(after));
    delete partial.hooks.SessionEnd;
    eq(Setup.attentionHooksState(partial, G, SCRIPT).state, 'outdated');
    const doubled = JSON.parse(JSON.stringify(after));
    doubled.hooks.Stop.push({hooks: [gjsHook('stop')]});
    eq(Setup.attentionHooksState(doubled, G, SCRIPT).state, 'outdated');
    const moved = JSON.parse(JSON.stringify(after));
    moved.hooks.Notification.at(-1).matcher = '';
    eq(Setup.attentionHooksState(moved, G, SCRIPT).state, 'outdated');
    eq(Setup.attentionHooksState({hooks: {Stop: 'x'}}, G, SCRIPT).state, 'none');
});

test('setup: disableAllHooks is reported', () => {
    eq(Setup.attentionHooksState({disableAllHooks: true}, G, SCRIPT), {state: 'none', disableAllHooks: true});
    eq(Setup.attentionHooksState(null, G, SCRIPT), {state: 'none', disableAllHooks: false});
});

test('setup: the status line and the hooks live side by side', () => {
    const file = settingsFile({model: 'opus'});
    const line = '/home/u/.local/share/gnome-shell/extensions/froonty@catalin/features/claude/statusline.py';
    eq(StatusLine.installStatusLine(file, line), null);
    eq(Setup.installAttentionHooks(file, SCRIPT, G), null);
    eq(StatusLine.removeStatusLine(file), null);
    eq(readJson(file), {model: 'opus', hooks: OURS});
    eq(StatusLine.installStatusLine(file, line), null);
    eq(Setup.removeAttentionHooks(file), null);
    eq(readJson(file), {model: 'opus', statusLine: StatusLine.statusLineEntry(line)});
});

const LINE = '/home/u/.local/share/gnome-shell/extensions/froonty@catalin/features/claude/statusline.py';
const fileType = file => file.query_file_type(Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
const inodeOf = file => file.query_info('unix::inode', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null)
    .get_attribute_uint64('unix::inode');
const namesOf = dir => {
    const names = [];
    const children = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
    for (let info; (info = children.next_file(null));)
        names.push(info.get_name());
    return names.sort();
};
const writeText = (file, text) => file.replace_contents(text, null, false, Gio.FileCreateFlags.NONE, null);

test('setup: a symbolic link (dotfiles) is followed: the file it names is replaced whole, the link stays', () => {
    const root = tempPath('froonty-claude-links-XXXXXX');
    const dotfiles = Gio.File.new_for_path(`${root}/dotfiles/claude`);
    dotfiles.make_directory_with_parents(null);
    const real = dotfiles.get_child('settings.json');
    writeText(real, `${JSON.stringify({model: 'opus'}, null, 2)}\n`);
    const claudeDir = Gio.File.new_for_path(`${root}/home/.claude`);
    claudeDir.make_directory_with_parents(null);
    const link = claudeDir.get_child('settings.json');
    link.make_symbolic_link('../../dotfiles/claude/settings.json', null);

    const before = inodeOf(real);
    eq(Setup.installAttentionHooks(link, SCRIPT, G), null);
    eq(fileType(link), Gio.FileType.SYMBOLIC_LINK, 'still a link');
    eq(readJson(real), {model: 'opus', hooks: OURS});
    ok(inodeOf(real) !== before, 'a new file renamed onto the old one, not the old one rewritten in place');
    eq(Setup.attentionHooksState(readJson(link), G, SCRIPT).state, 'ours');

    // A chain of links, the first one absolute.
    const chain = claudeDir.get_child('chain.json');
    chain.make_symbolic_link(link.get_path(), null);
    const middle = inodeOf(real);
    eq(StatusLine.installStatusLine(chain, LINE), null);
    ok(fileType(chain) === Gio.FileType.SYMBOLIC_LINK && fileType(link) === Gio.FileType.SYMBOLIC_LINK);
    ok(inodeOf(real) !== middle, 'replaced whole again');
    eq(readJson(real), {model: 'opus', hooks: OURS, statusLine: StatusLine.statusLineEntry(LINE)});
    eq(Setup.removeAttentionHooks(link), null);
    eq(StatusLine.removeStatusLine(chain), null);
    eq(readJson(real), {model: 'opus'}, 'Remove restores it, through the links');
    eq(fileType(link), Gio.FileType.SYMBOLIC_LINK);

    // A link to a file not made yet: it is made, and the link stays.
    const dangling = claudeDir.get_child('new.json');
    dangling.make_symbolic_link(`${root}/dotfiles/claude/new.json`, null);
    eq(Setup.installAttentionHooks(dangling, SCRIPT, G), null);
    eq(fileType(dangling), Gio.FileType.SYMBOLIC_LINK);
    eq(readJson(dotfiles.get_child('new.json')), {hooks: OURS});
    eq(namesOf(dotfiles), ['new.json', 'settings.json'], 'no temporary file left');

    // A link to itself: an error, nothing written.
    const loop = claudeDir.get_child('loop.json');
    loop.make_symbolic_link('loop.json', null);
    const error = Setup.installAttentionHooks(loop, SCRIPT, G);
    ok(typeof error === 'string' && error.length > 0, String(error));
    eq(fileType(loop), Gio.FileType.SYMBOLIC_LINK);
});

test('setup: a file with another hard link is left alone, and the row says why', () => {
    const file = settingsFile({model: 'opus'});
    const other = file.get_parent().get_child('backup.json');
    eq(run(['/bin/ln', file.get_path(), other.get_path()], {}).status, 0);
    const text = readText(file);
    for (const error of [Setup.installAttentionHooks(file, SCRIPT, G), StatusLine.installStatusLine(file, LINE)])
        ok(typeof error === 'string' && error.includes('more than one hard link'), String(error));
    eq([readText(file), readText(other)], [text, text], 'both names untouched');
    other.delete(null);
    eq(Setup.installAttentionHooks(file, SCRIPT, G), null, 'one link again: set up');
});

test('setup: a change made since the read (Claude Code saving) is never overwritten', () => {
    const theirs = `${JSON.stringify({model: 'sonnet'}, null, 2)}\n`;
    const file = settingsFile({model: 'opus'});
    const read = StatusLine.readClaudeSettings(file);
    ok(typeof read.etag === 'string' && read.etag.length > 0, String(read.etag));
    writeText(file, theirs);
    // Its time, which the etag holds, surely differs.
    const mtime = file.query_info('time::modified', Gio.FileQueryInfoFlags.NONE, null)
        .get_attribute_uint64('time::modified');
    file.set_attribute_uint64('time::modified', mtime + 10, Gio.FileQueryInfoFlags.NONE, null);
    let error = StatusLine.saveClaudeSettings(file, {...read.settings, hooks: OURS}, read.etag);
    ok(error?.includes('changed since Froonty read it'), String(error));
    eq(readText(file), theirs, 'theirs kept');
    eq(StatusLine.saveClaudeSettings(file, {model: 'haiku'}, StatusLine.readClaudeSettings(file).etag), null,
        'read again, it goes through');
    eq(readJson(file), {model: 'haiku'});

    // No file at the read, one made since: kept too.
    const none = settingsFile();
    const empty = StatusLine.readClaudeSettings(none);
    eq([empty.settings, empty.error], [null, null]);
    writeText(none, theirs);
    error = StatusLine.saveClaudeSettings(none, {hooks: OURS}, empty.etag);
    ok(error?.includes('changed since Froonty read it'), String(error));
    eq(readText(none), theirs);
    // Still no file: made, private.
    const fresh = settingsFile();
    eq(StatusLine.saveClaudeSettings(fresh, {model: 'opus'}, StatusLine.readClaudeSettings(fresh).etag), null);
    eq([readJson(fresh), modeOf(fresh.get_path())], [{model: 'opus'}, 0o600]);
});

test('clear command: deletes only that session\'s file, quietly, with exit 0', () => {
    const sh = (env, session) => run(['/bin/sh', '-c', Setup.CLEAR_COMMAND],
        {...env, CLAUDE_CODE_SESSION_ID: session});
    const {runtime, dir} = runtimeWithState();
    for (const name of ['abc.json', 'other.json'])
        GLib.file_set_contents(`${dir}/${name}`, '{}');
    let r = sh({XDG_RUNTIME_DIR: runtime}, 'abc');
    eq([r.status, r.stdout, r.stderr], [0, '', '']);
    ok(!exists(`${dir}/abc.json`) && exists(`${dir}/other.json`));
    r = sh({XDG_RUNTIME_DIR: runtime}, 'abc');
    eq([r.status, r.stdout, r.stderr], [0, '', ''], 'already gone');

    const cache = tempPath();
    GLib.mkdir_with_parents(`${cache}/froonty/claude-attention`, 0o700);
    GLib.file_set_contents(`${cache}/froonty/claude-attention/c1.json`, '{}');
    r = sh({XDG_CACHE_HOME: cache}, 'c1');
    eq(r.status, 0);
    ok(!exists(`${cache}/froonty/claude-attention/c1.json`), 'falls back to XDG_CACHE_HOME');

    GLib.file_set_contents(`${runtime}/froonty/x.json`, '{}');
    for (const session of ['../x', '', null, 'a b', '*']) {
        r = sh({XDG_RUNTIME_DIR: runtime}, session);
        eq([r.status, r.stdout, r.stderr], [0, '', ''], String(session));
    }
    ok(exists(`${runtime}/froonty/x.json`) && exists(`${dir}/other.json`), 'nothing else deleted');
    r = sh({XDG_RUNTIME_DIR: tempPath()}, 'abc');
    eq([r.status, r.stdout, r.stderr], [0, '', ''], 'no folder at all');
});

// ---- the service, with fakes for the Shell side

const EXTENSION_DIR = Gio.File.new_for_path(HOOK).get_parent().get_parent().get_parent();

// Froonty's real schema, with an in-memory backend: nothing touches dconf.
function makeSettings() {
    const source = Gio.SettingsSchemaSource.new_from_directory(
        EXTENSION_DIR.get_child('schemas').get_path(), null, false);
    return new Gio.Settings({
        settings_schema: source.lookup('org.gnome.shell.extensions.froonty', false),
        backend: Gio.memory_settings_backend_new(),
    });
}

const sleep = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    resolve();
    return GLib.SOURCE_REMOVE;
}));

async function waitFor(predicate, timeoutMs = 3000) {
    for (let waited = 0; waited < timeoutMs; waited += 20) {
        if (predicate())
            return true;
        await sleep(20);
    }
    return predicate();
}

const {Emitter} = await import('../../froonty@catalin/core/emitter.js');
const {AttentionService} = await import('../../froonty@catalin/features/claude/attentionService.js');

// What the service uses of shell/claudeAttention.js's ClaudeDesktop.
class FakeDesktop extends Emitter {
    constructor() {
        super();
        this.apps = new Map(); // session → {appId, appName}
        this.looking = new Map(); // session → 'exact' | 'app'
        this.log = [];
        this.focusWatched = false;
        this.filters = [];
    }

    resolve(target) {
        const app = this.apps.get(target.session);
        return app ? {...app, window: null, exact: this.looking.get(target.session) !== 'app'} : null;
    }

    isLookingAt(target, {exactOnly = false} = {}) {
        const how = this.looking.get(target.session);
        return exactOnly ? how === 'exact' : how !== undefined;
    }

    raise(target) {
        this.log.push(`raise ${target.session}`);
    }

    raiseApp(appId) {
        this.log.push(`raiseApp ${appId}`);
    }

    watchFocus(on) {
        this.focusWatched = on;
        this.log.push(`watchFocus ${on}`);
    }

    notificationFilter(options) {
        this.filters.push(options);
        return () => true;
    }

    connect(signal, handler) {
        this._count = (this._count ?? 0) + 1;
        return super.connect(signal, handler);
    }

    disconnect(id) {
        this._count--;
        return super.disconnect(id);
    }

    get handlers() {
        return this._count ?? 0;
    }
}

// A notification store as the service uses the Notifications tab's
// (shell/notificationStore.js, with its `filter`). Every store sees the
// same notifications, as every store sees GNOME's one tray.
class FakeStore extends Emitter {
    constructor(filter, tray) {
        super();
        this.filter = filter;
        this.tray = tray;
        this.watching = false;
        this.log = [];
    }

    get list() {
        return this.tray.list;
    }

    watch() {
        this.watching = true;
    }

    unwatch() {
        this.watching = false;
    }

    get notifications() {
        return this.watching ? this.list : [];
    }

    describe(n) {
        return this.list.includes(n) ? {...n} : null;
    }

    activate(n) {
        this.log.push(`activate ${n.title}`);
        this.remove(n);
    }

    dismiss(n) {
        this.log.push(`dismiss ${n.title}`);
        this.remove(n);
    }

    add(n) {
        return this.tray.add(n);
    }

    remove(n) {
        this.tray.remove(n);
    }
}

class FakeNotifications {
    constructor() {
        this.stores = [];
        this.list = [];
    }

    add(n) {
        this.list.push(n);
        this.live.forEach(store => store.emit('changed'));
        return n;
    }

    remove(n) {
        this.list = this.list.filter(x => x !== n);
        this.live.forEach(store => store.emit('changed'));
    }

    createStore({filter}) {
        const store = new FakeStore(filter, this);
        this.stores.push(store);
        return store;
    }

    plainText(text) {
        return text ?? '';
    }

    get live() {
        return this.stores.filter(s => s.watching);
    }
}

// A real process to stand for Claude Code: liveness is read from /proc.
function spawnSleep() {
    const proc = Gio.Subprocess.new(['/usr/bin/sleep', '600'], Gio.SubprocessFlags.NONE);
    const pid = Number(proc.get_identifier());
    const start = A.parseProcStat(decode(GLib.file_get_contents(`/proc/${pid}/stat`)[1])).start;
    return {proc, pid, start};
}

const sleeper = spawnSleep();
const alivePids = () => [[sleeper.pid, sleeper.start]];

function setupService({finished = true, app = true, browsers = false, notifications = null, create = true} = {}) {
    const runtime = tempPath();
    const dir = Gio.File.new_for_path(`${runtime}/froonty/claude-attention`);
    if (create)
        GLib.mkdir_with_parents(dir.get_path(), 0o700);
    const settings = makeSettings();
    settings.set_boolean('claude-attention-finished', finished);
    settings.set_boolean('claude-attention-app', app);
    settings.set_boolean('claude-attention-browsers', browsers);
    const desktop = new FakeDesktop();
    const service = new AttentionService({settings, desktop, notifications, dir});
    let reads = 0;
    const load = service._load.bind(service);
    service._load = (...args) => {
        reads++;
        return load(...args);
    };
    let changes = 0;
    service.connect('changed', () => changes++);
    return {runtime, dir, settings, desktop, service, reads: () => reads, changes: () => changes};
}

// As the hook script writes it: a new file renamed into the folder.
function writeState(dir, session, {kind = 'permission', at = Date.now(), entrypoint = 'claude-vscode',
    project = 'Alpha', pids = alivePids()} = {}) {
    const temp = dir.get_parent().get_child(`.claude-attention-${session}.test.tmp`);
    temp.replace_contents(A.serializeEntry({kind, at, session, entrypoint, project, pids}),
        null, false, Gio.FileCreateFlags.PRIVATE, null);
    temp.move(dir.get_child(`${session}.json`), Gio.FileCopyFlags.OVERWRITE, null, null);
}

const fileThere = (dir, session) => dir.get_child(`${session}.json`).query_exists(null);
const ids = service => service.entries.map(e => e.id);
const kinds = service => service.entries.map(e => `${e.id}=${e.kind}`);

test('service: nothing before start(); start() makes the folder (0700) and lists what is there', async () => {
    const t = setupService({create: false});
    ok(!t.dir.query_exists(null), 'no folder before start()');
    eq(t.reads(), 0);
    t.service.start();
    ok(t.dir.query_exists(null));
    eq(modeOf(t.dir.get_path()), 0o700);
    t.service.stop();

    const u = setupService();
    writeState(u.dir, 'one', {kind: 'finished', at: 100});
    writeState(u.dir, 'two', {kind: 'permission', at: 50});
    const junk = {
        'notes.txt': 'x',
        '.hidden.json': A.serializeEntry({kind: 'permission', at: 1, session: 'hidden', entrypoint: '', project: '', pids: alivePids()}),
        'big.json': A.serializeEntry({kind: 'permission', at: 1, session: 'big', entrypoint: '', project: 'x'.repeat(100), pids: alivePids()}).replace('}', `,"pad":"${'x'.repeat(5000)}"}`),
        'bad.json': '{"v": 1}',
    };
    for (const [name, text] of Object.entries(junk))
        GLib.file_set_contents(`${u.dir.get_path()}/${name}`, text);
    u.service.start();
    ok(await waitFor(() => u.service.entries.length === 2), kinds(u.service).join(' '));
    await sleep(100);
    eq(kinds(u.service), ['hook:two=permission', 'hook:one=finished']);
    const e = u.service.entries[0];
    eq([e.origin, e.project, e.entrypoint, e.at], ['hook', 'Alpha', 'claude-vscode', 50]);
    for (const name of Object.keys(junk))
        ok(u.dir.get_child(name).query_exists(null), `${name} kept`);
    u.service.stop();
});

test('service: files arriving, replaced and deleted are followed; a burst costs at most two reads', async () => {
    const t = setupService();
    t.service.start();
    await sleep(100);
    writeState(t.dir, 's1', {kind: 'finished'});
    ok(await waitFor(() => t.service.entries.length === 1));
    writeState(t.dir, 's2', {kind: 'waiting', at: Date.now() + 10});
    ok(await waitFor(() => t.service.entries.length === 2));
    eq(kinds(t.service), ['hook:s2=waiting', 'hook:s1=finished']);
    writeState(t.dir, 's1', {kind: 'permission'});
    ok(await waitFor(() => t.service.entries[0]?.id === 'hook:s1'), kinds(t.service).join(' '));
    eq(kinds(t.service), ['hook:s1=permission', 'hook:s2=waiting']);
    t.dir.get_child('s2.json').delete(null);
    ok(await waitFor(() => t.service.entries.length === 1));

    await sleep(100);
    const before = t.reads();
    for (let i = 0; i < 10; i++)
        writeState(t.dir, 's1', {kind: i % 2 ? 'permission' : 'input', at: Date.now() + i});
    await waitFor(() => t.service.entries[0]?.kind === 'permission' && t.service.entries[0].at >= Date.now(), 1000);
    await sleep(300);
    ok(t.reads() - before <= 2, `${t.reads() - before} reads`);
    eq(kinds(t.service), ['hook:s1=permission']);
    t.service.stop();
});

test('service: a Claude Code that is gone (or a reused process id) drops the entry and its file', async () => {
    const t = setupService();
    t.service.start();
    const gone = spawnSleep();
    gone.proc.force_exit();
    gone.proc.wait(null);
    writeState(t.dir, 'dead', {pids: [[gone.pid, gone.start]]});
    writeState(t.dir, 'reused', {pids: [[sleeper.pid, sleeper.start + 1]]});
    ok(await waitFor(() => !fileThere(t.dir, 'dead') && !fileThere(t.dir, 'reused')));
    eq(t.service.entries.length, 0);

    // A crash after it was shown: found on the next revalidation.
    const later = spawnSleep();
    writeState(t.dir, 'later', {pids: [[later.pid, later.start]]});
    ok(await waitFor(() => t.service.entries.length === 1));
    later.proc.force_exit();
    later.proc.wait(null);
    await t.service.revalidate();
    ok(await waitFor(() => t.service.entries.length === 0 && !fileThere(t.dir, 'later')));
    t.service.stop();
});

test('service: on arrival, only its own window, known for sure and focused, keeps it off the bar', async () => {
    const t = setupService();
    t.service.start();
    const vscode = {appId: 'code.desktop', appName: 'Visual Studio Code'};
    const terminal = {appId: 'org.gnome.Ptyxis.desktop', appName: 'Ptyxis'};
    // session → [kind, entrypoint, app, how the user looks at it, kept?]
    const cases = {
        'vscode-exact': ['permission', 'claude-vscode', vscode, 'exact', false],
        // Another window of its app has the focus; its own is not known.
        'vscode-app': ['permission', 'claude-vscode', vscode, 'app', true],
        // A terminal: Claude Code asks after ~6 s / ~60 s without typing,
        // and the focused window may show another tab.
        'cli-permission': ['permission', 'cli', terminal, 'exact', true],
        'unset-input': ['input', '', terminal, 'exact', true],
        'cli-waiting': ['waiting', 'cli', terminal, 'exact', true],
        'cli-finished': ['finished', 'cli', terminal, 'exact', false],
        'cli-error': ['error', 'cli', terminal, 'exact', false],
        'cli-finished-app': ['finished', 'cli', terminal, 'app', true],
    };
    for (const [session, [kind, entrypoint, app, how]] of Object.entries(cases)) {
        t.desktop.apps.set(session, app);
        t.desktop.looking.set(session, how);
        writeState(t.dir, session, {kind, entrypoint});
    }
    const kept = Object.keys(cases).filter(s => cases[s][4]);
    const dropped = Object.keys(cases).filter(s => !cases[s][4]);
    ok(await waitFor(() => t.service.entries.length === kept.length && dropped.every(s => !fileThere(t.dir, s))),
        kinds(t.service).join(' '));
    await sleep(100);
    eq(ids(t.service).sort(), kept.map(s => `hook:${s}`).sort());
    ok(kept.every(s => fileThere(t.dir, s)), 'their files stay');
    t.service.stop();
});

test('service: focus on its own window clears it; on any window of its app, a permission or a question', async () => {
    const t = setupService();
    t.service.start();
    const app = {appId: 'org.gnome.Ptyxis.desktop', appName: 'Ptyxis'};
    // session → [kind, how the user looks at it after the focus change, cleared?]
    const cases = {
        'exact-permission': ['permission', 'exact', true],
        'exact-finished': ['finished', 'exact', true],
        'exact-waiting': ['waiting', 'exact', true],
        'app-permission': ['permission', 'app', true],
        'app-input': ['input', 'app', true],
        'app-waiting': ['waiting', 'app', false],
        'app-finished': ['finished', 'app', false],
        'app-error': ['error', 'app', false],
        'elsewhere-permission': ['permission', undefined, false],
    };
    for (const [session, [kind]] of Object.entries(cases)) {
        t.desktop.apps.set(session, app);
        writeState(t.dir, session, {kind, entrypoint: 'cli'});
    }
    ok(await waitFor(() => t.service.entries.length === Object.keys(cases).length), kinds(t.service).join(' '));
    eq(t.desktop.focusWatched, true);
    for (const [session, [, how]] of Object.entries(cases)) {
        if (how)
            t.desktop.looking.set(session, how);
    }
    t.desktop.emit('focus-changed');
    const cleared = Object.keys(cases).filter(s => cases[s][2]);
    const kept = Object.keys(cases).filter(s => !cases[s][2]);
    ok(await waitFor(() => cleared.every(s => !fileThere(t.dir, s))), kinds(t.service).join(' '));
    await sleep(100);
    eq(ids(t.service).sort(), kept.map(s => `hook:${s}`).sort());
    ok(kept.every(s => fileThere(t.dir, s)), 'their files stay');
    t.service.stop();
});

test('service: focus is watched only while a shown entry has an app', async () => {
    const t = setupService();
    t.service.start();
    writeState(t.dir, 'noapp');
    ok(await waitFor(() => t.service.entries.length === 1));
    eq(t.desktop.focusWatched, false);
    t.desktop.apps.set('withapp', {appId: 'term.desktop', appName: 'Terminal'});
    writeState(t.dir, 'withapp');
    ok(await waitFor(() => t.desktop.focusWatched));
    t.service.dismiss('hook:withapp');
    ok(await waitFor(() => !t.desktop.focusWatched));
    eq(t.desktop.log.filter(l => l.startsWith('watchFocus')), ['watchFocus true', 'watchFocus false']);
    t.service.stop();
});

test('service: "Also when Claude finishes" off deletes finished and error files, keeps the rest', async () => {
    const t = setupService();
    t.service.start();
    writeState(t.dir, 'f', {kind: 'finished'});
    writeState(t.dir, 'e', {kind: 'error'});
    writeState(t.dir, 'p', {kind: 'permission'});
    ok(await waitFor(() => t.service.entries.length === 3));
    t.settings.set_boolean('claude-attention-finished', false);
    ok(await waitFor(() => !fileThere(t.dir, 'f') && !fileThere(t.dir, 'e')));
    eq(ids(t.service), ['hook:p']);
    writeState(t.dir, 'f2', {kind: 'finished'});
    ok(await waitFor(() => !fileThere(t.dir, 'f2')), 'a new one too');
    eq(ids(t.service), ['hook:p']);
    t.service.stop();
});

test('service: sessions in the Claude app follow the app switch', async () => {
    const t = setupService();
    t.service.start();
    writeState(t.dir, 'desk', {entrypoint: 'claude-desktop'});
    writeState(t.dir, 'code', {entrypoint: 'claude-vscode'});
    ok(await waitFor(() => t.service.entries.length === 1));
    await sleep(100);
    eq(ids(t.service), ['hook:code']);
    ok(fileThere(t.dir, 'desk'), 'kept, not shown');
    t.settings.set_boolean('claude-attention-app', false);
    ok(await waitFor(() => t.service.entries.length === 2), kinds(t.service).join(' '));
    t.settings.set_boolean('claude-attention-app', true);
    ok(await waitFor(() => t.service.entries.length === 1));
    eq(ids(t.service), ['hook:code']);
    t.service.stop();
});

test('service: a click raises the window and drops it; × only drops it', async () => {
    const t = setupService();
    t.service.start();
    writeState(t.dir, 'a');
    writeState(t.dir, 'b', {at: Date.now() - 1000});
    ok(await waitFor(() => t.service.entries.length === 2));
    ok(t.service.activate('hook:a'));
    eq(ids(t.service), ['hook:b'], 'dropped at once');
    eq(t.desktop.log.filter(l => l.startsWith('raise')), ['raise a']);
    ok(await waitFor(() => !fileThere(t.dir, 'a')));
    ok(t.service.dismiss('hook:b'));
    eq(t.service.entries.length, 0);
    ok(await waitFor(() => !fileThere(t.dir, 'b')));
    eq(t.desktop.log.filter(l => l.startsWith('raise')), ['raise a'], 'no raise on ×');
    ok(!t.service.activate('hook:a') && !t.service.dismiss('nothing'), 'a stale id does nothing');
    t.service.stop();
});

test('service: stop() leaves no watch or handler and keeps the files; removeState() deletes them', async () => {
    const notifications = new FakeNotifications();
    const t = setupService({notifications});
    t.service.start();
    writeState(t.dir, 'kept');
    ok(await waitFor(() => t.service.entries.length === 1));
    ok(t.desktop.handlers > 0 && notifications.live.length === 1);
    t.service.stop();
    eq([t.desktop.handlers, notifications.live.length, t.service.entries.length], [0, 0, 0]);
    eq(t.service._monitor, null);
    ok(fileThere(t.dir, 'kept'));
    writeState(t.dir, 'after');
    await sleep(200);
    eq(t.service.entries.length, 0, 'not following any more');
    GLib.file_set_contents(`${t.dir.get_parent().get_path()}/.claude-attention-x.1.tmp`, 'x');
    await t.service.removeState();
    ok(!t.dir.query_exists(null), 'folder removed');
    ok(!t.dir.get_parent().get_child('.claude-attention-x.1.tmp').query_exists(null), 'temporary file removed');
    await t.service.removeState();
});

test('service: a folder removed while watched is made and watched again, once', async () => {
    const t = setupService();
    t.service.start();
    writeState(t.dir, 'x');
    ok(await waitFor(() => t.service.entries.length === 1));
    t.dir.get_child('x.json').delete(null);
    t.dir.delete(null);
    ok(await waitFor(() => t.dir.query_exists(null)), 're-created');
    eq(t.service.entries.length, 0);
    writeState(t.dir, 'y');
    ok(await waitFor(() => t.service.entries.length === 1), 'watched again');
    t.dir.get_child('y.json').delete(null);
    t.dir.delete(null);
    await sleep(300);
    ok(!t.dir.query_exists(null), 'only once per start');
    eq(t.service._monitor, null, 'and no monitor on a missing path');
    t.service.stop();
});

test('service: GNOME notifications from the Claude app and from browsers', async () => {
    const notifications = new FakeNotifications();
    const t = setupService({notifications, finished: true, app: true, browsers: false});
    t.service.start();
    eq(t.desktop.filters, [{app: true, browsers: false}]);
    const store = () => notifications.live[0];
    const appNote = (title, body, time = Date.now()) => ({appId: A.CLAUDE_APP_ID, appName: 'Claude',
        title, body, useMarkup: true, time});
    const allow = store().add(appNote('Froonty', 'Allow Claude to run git push?', 1000));
    ok(await waitFor(() => t.service.entries.length === 1));
    let e = t.service.entries[0];
    eq([e.origin, e.kind, e.title, e.appName, e.at], ['app', 'permission', 'Froonty', 'Claude', 1000]);
    store().add(appNote('Claude', 'Claude finished a task', 2000));
    ok(await waitFor(() => t.service.entries.length === 2));
    eq(t.service.entries[1].title, null, 'the app\'s own name is no title');
    t.settings.set_boolean('claude-attention-finished', false);
    ok(await waitFor(() => t.service.entries.length === 1));
    eq(store().list.length, 2, 'the notification itself is not touched');

    const browserNote = (title, body) => ({appId: 'brave-browser.desktop', appName: 'Brave Web Browser',
        title, body, useMarkup: false, time: 3000});
    store().add(browserNote('Claude', 'Claude responded · claude.ai'));
    await sleep(50);
    eq(t.service.entries.length, 1, 'browsers off');
    t.settings.set_boolean('claude-attention-browsers', true);
    eq(t.desktop.filters.at(-1), {app: true, browsers: true});
    eq(notifications.live.length, 1, 'one store, made again with the new filter');
    store().add(browserNote('Claude Dupont', 'lunch?'));
    ok(await waitFor(() => t.service.entries.length === 2), kinds(t.service).join(' '));
    e = t.service.entries.find(x => x.origin === 'browser');
    eq([e.kind, e.appName, e.title], ['attention', 'Brave Web Browser', null]);

    const appEntry = t.service.entries.find(x => x.origin === 'app');
    ok(t.service.activate(appEntry.id));
    eq(t.desktop.log.filter(l => l.startsWith('raiseApp')), [`raiseApp ${A.CLAUDE_APP_ID}`]);
    eq(store().log, ['activate Froonty']);
    ok(await waitFor(() => t.service.entries.length === 1));
    ok(t.service.dismiss(e.id));
    eq(store().log.at(-1), 'dismiss Claude');
    ok(await waitFor(() => t.service.entries.length === 0));

    t.settings.set_boolean('claude-attention-app', false);
    t.settings.set_boolean('claude-attention-browsers', false);
    eq(notifications.live.length, 0, 'both off: no store');
    eq(allow.title, 'Froonty');
    t.service.stop();
});

test('service: at most 64 entries, the newest', async () => {
    const t = setupService();
    t.service.start();
    for (let i = 0; i < 70; i++)
        writeState(t.dir, `s${i}`, {kind: 'waiting', at: 1000 + i});
    ok(await waitFor(() => t.service.entries.length === 64 && t.service._hooks.size === 70, 5000),
        `${t.service.entries.length}`);
    eq(t.service.entries[0].id, 'hook:s69');
    eq(t.service.entries.at(-1).id, 'hook:s6');
    t.service.stop();
});

test('service: the test\'s own processes are ended', () => {
    sleeper.proc.force_exit();
    sleeper.proc.wait(null);
});

await done();
