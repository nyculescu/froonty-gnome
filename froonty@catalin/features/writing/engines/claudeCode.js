// SPDX-License-Identifier: GPL-3.0-or-later
// Writing engine: the user's own Claude Code, headless (`claude -p`), on
// their Claude plan (docs/features/writing.md §4). Found as the Claude
// tab finds it. Every run:
//
// - has every tool, MCP server, skill, slash command, hook and settings
//   file turned off (claudeArgv), so text that contains instructions can
//   never make it run anything;
// - gets the text on stdin, between markers, never in argv;
// - runs in an empty private folder ($XDG_RUNTIME_DIR/froonty-writing), so
//   no project's CLAUDE.md or settings are read, with no session saved;
// - only on a Claude plan sign-in: `claude auth status` is checked first,
//   API billing is refused and its environment variables are removed.
//
// No St or Gtk: the pure parts are unit-tested with plain gjs.

import Gio from 'gi://Gio';

import {findClaudeCode} from '../../claude/refresher.js';
import {actionById, buildRequest, finishReply, stepsFor, systemPrompt, LIMITS, LONG_TEXT_CHARS} from '../actions.js';
import {WritingError} from '../errors.js';
import {defaultPaths, override} from '../paths.js';
import {runProcess} from '../process.js';
import {ensurePrivateDir, isPrivateDir} from '../setup/fs.js';

export const ID = 'claude-code';
export const CLAUDE_MODELS = ['haiku', 'sonnet'];
// --permission-prompts came in 2.1.259 (--safe-mode in 2.1.169).
export const MIN_VERSION = [2, 1, 259];
export const PLAN_TYPES = ['pro', 'max', 'team', 'enterprise'];
const AUTH_TIMEOUT_MS = 10 * 1000;
const MAX_STDOUT = 1024 * 1024;
const LABEL = 'Claude Code (Writing)';

/**
 * Fixed, in this order, in every run (docs/features/writing.md §4.2):
 * nothing of the user's configuration is loaded and nothing can be used
 * but the model's reply.
 */
export const SAFETY_FLAGS = [
    '--safe-mode',
    '--tools=',
    '--disallowedTools=mcp__*',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--setting-sources=',
    '--settings={"disableAllHooks":true}',
    '--permission-mode=dontAsk',
    '--permission-prompts=none',
    '--max-turns=1',
    '--no-session-persistence',
    '--output-format=json',
];

/**
 * How long one run may take: 90 s plus 8 ms (Haiku) or 15 ms (Sonnet) per
 * character, so about 4 and 6.5 min at the 20,000-character limit. A
 * rewrite answers about as much as it reads; these allowances are
 * estimates, not measured. A run stopped by the timeout has probably been
 * counted toward the plan's usage already, so the cap is generous.
 */
export function runTimeoutMs(chars, model = 'haiku') {
    return 90 * 1000 + (model === 'sonnet' ? 15 : 8) * Math.max(0, chars);
}

export function busyText(chars = 0) {
    return chars > LONG_TEXT_CHARS
        ? 'Rewriting with Claude Code (a long text can take a few minutes)…'
        : 'Rewriting with Claude Code…';
}

/**
 * The argv of one run, for an action (its first step) or a step's
 * request (actions.js buildRequest). The text is never in it (it goes on
 * stdin): a step's system prompt holds no text.
 */
export function claudeArgv(bin, actionOrRequest, model) {
    if (!CLAUDE_MODELS.includes(model))
        throw new WritingError('failed', `Unknown model ${model}`);
    let system = actionOrRequest?.system;
    if (typeof actionOrRequest === 'string') {
        if (!actionById(actionOrRequest))
            throw new WritingError('failed', `Unknown action ${actionOrRequest}`);
        system = systemPrompt(actionOrRequest);
    }
    if (typeof system !== 'string')
        throw new WritingError('failed', 'No system prompt');
    return [bin, '-p',
        ...SAFETY_FLAGS,
        `--model=${model}`,
        ...model === 'sonnet' ? ['--effort=low'] : [],
        `--system-prompt=${system}`];
}

// Paid billing and anything that would change the model or provider.
const UNSET = [
    'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
    'CLAUDE_CODE_USE_ANTHROPIC_AWS', 'CLAUDE_CODE_SIMPLE', 'CLAUDE_CODE_EFFORT_LEVEL',
];

/**
 * The run's environment changes. CLAUDE_CODE_OAUTH_TOKEN (a plan token)
 * and CLAUDE_CONFIG_DIR are kept.
 *
 * @returns {{unset: string[], set: object}}
 */
export function claudeEnv(model) {
    const set = {
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        DISABLE_AUTOUPDATER: '1',
        CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
        CLAUDE_CODE_SKIP_PROMPT_HISTORY: '1',
        // "@path" in the text is not read.
        CLAUDE_CODE_DISABLE_ATTACHMENTS: '1',
        CLAUDE_CODE_DISABLE_ARTIFACT: '1',
        ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
        CLAUDE_CODE_MAX_RETRIES: '2',
    };
    if (model === 'haiku')
        set.MAX_THINKING_TOKENS = '0';
    return {unset: [...UNSET], set};
}

const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * The reply of `--output-format=json`: its result text.
 *
 * @returns {string} the raw result
 * @throws {WritingError}
 */
export function parseResult(stdout, stderr, exitOk) {
    if (stdout.length > MAX_STDOUT)
        throw new WritingError('bad-output', 'Claude Code answered with too much output.');
    let result = null;
    for (const line of stdout.split('\n').reverse()) {
        if (!line.trim())
            continue;
        try {
            const data = JSON.parse(line);
            if (data?.type === 'result') {
                result = data;
                break;
            }
        } catch (e) {
            // Not this line.
        }
    }
    if (!result) {
        const first = stderr.split('\n').find(line => line.trim()) ?? '';
        if (/unknown option/.test(stderr)) {
            throw new WritingError('too-old', 'This Claude Code is too old for the Writing tab.',
                'Update Claude Code (2.1.259 or newer).');
        }
        throw new WritingError('failed', first
            ? `Claude Code failed: ${clip(first.trim(), 200)}`
            : 'Claude Code gave no answer.');
    }
    if (result.is_error === true || result.subtype !== 'success' || !exitOk) {
        const message = clip(String(result.result ?? result.subtype ?? 'Claude Code failed.'), 300);
        const status = result.api_error_status;
        if (status === 401 || status === 403) {
            throw new WritingError('not-signed-in', message,
                'Run `claude auth login` in a terminal.');
        }
        if (status === 429)
            throw new WritingError('limit', message, 'Your Claude plan\'s usage limit was reached.');
        if (result.subtype === 'error_max_turns')
            throw new WritingError('failed', 'Claude Code stopped after one turn.');
        throw new WritingError('failed', message);
    }
    if (typeof result.result !== 'string')
        throw new WritingError('bad-output', 'Claude Code answered with no text.');
    return result.result;
}

/**
 * `claude auth status` (JSON): only a Claude plan sign-in is accepted.
 *
 * @returns {{ok: true, plan: string} | {ok: false, code: string, message: string}}
 */
export function parseAuth(stdout, exitOk) {
    let data = null;
    try {
        data = JSON.parse(stdout.trim());
    } catch (e) {
        data = null;
    }
    if (!exitOk || data?.loggedIn === false || data?.authMethod === 'none')
        return {ok: false, code: 'not-signed-in', message: 'Claude Code is not signed in.'};
    if (!data)
        return {ok: false, code: 'failed', message: 'Claude Code\'s sign-in could not be read.'};
    const apiKey = {
        ok: false,
        code: 'api-key',
        message: 'Claude Code is set up for API billing or a cloud provider; Froonty\'s Writing only uses a Claude plan sign-in.',
    };
    if (data.apiProvider !== 'firstParty')
        return apiKey;
    if (data.authMethod === 'claude.ai') {
        if (PLAN_TYPES.includes(data.subscriptionType))
            return {ok: true, plan: data.subscriptionType};
        return {
            ok: false,
            code: 'not-a-plan',
            message: 'Claude Code is signed in without a Pro, Max, Team or Enterprise plan.',
        };
    }
    // `claude setup-token`: a long-lived token, which needs a plan.
    if (data.authMethod === 'oauth_token')
        return {ok: true, plan: 'token'};
    return apiKey;
}

/** `claude --version` → {ok, version} or {ok: false, code, version}. */
export function parseVersion(stdout) {
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(stdout.trim());
    if (!match)
        return {ok: false, code: 'failed', version: null};
    const parts = match.slice(1, 4).map(Number);
    const version = parts.join('.');
    for (let i = 0; i < 3; i++) {
        if (parts[i] !== MIN_VERSION[i]) {
            return parts[i] > MIN_VERSION[i] ? {ok: true, version}
                : {ok: false, code: 'too-old', version};
        }
    }
    return {ok: true, version};
}

/**
 * Claude Code's path, or null. Under the tests only FROONTY_CLAUDE_CODE
 * is ever used (paths.js override throws without it).
 */
export async function locate() {
    // Throws under the tests unless FROONTY_CLAUDE_CODE is set, which
    // findClaudeCode then uses instead of searching.
    override('FROONTY_CLAUDE_CODE');
    return await findClaudeCode();
}

/** The empty private working folder, created if needed and checked. */
export async function workingFolder(paths = defaultPaths()) {
    try {
        await ensurePrivateDir(paths.runtimeDir);
    } catch (e) {
        throw new WritingError('failed', `Froonty's working folder: ${e.message}`);
    }
    if (!await isPrivateDir(paths.runtimeDir))
        throw new WritingError('failed', `${paths.runtimeDir} is not a private folder of yours.`);
    return paths.runtimeDir;
}

/** `claude auth status`, with a run's environment and folder. */
export async function authCheck(bin, cwd, cancellable = null, run = runProcess) {
    const {unset, set} = claudeEnv('haiku');
    const result = await run({argv: [bin, 'auth', 'status'], cwd, unset, set,
        cancellable, timeoutMs: AUTH_TIMEOUT_MS, label: LABEL});
    return parseAuth(result.stdout, result.exitOk);
}

/** `claude --version` (Settings only). */
export async function version(bin, cwd, run = runProcess) {
    const result = await run({argv: [bin, '--version'], cwd, timeoutMs: AUTH_TIMEOUT_MS,
        label: LABEL});
    return parseVersion(result.stdout);
}

const isOnline = network => (network ?? Gio.NetworkMonitor.get_default()).connectivity ===
    Gio.NetworkConnectivity.FULL;

/**
 * One rewrite.
 *
 * @param {object} request
 * @param {string} request.action
 * @param {string} request.text
 * @param {Gio.Settings} request.settings
 * @param {?object} [request.request] the step (actions.js buildRequest); the
 *   action's first step when null
 * @param {?Gio.Cancellable} request.cancellable
 * @param {object} [request.network] a Gio.NetworkMonitor
 * @param {Map} [request.cache] the service's, cleared each time the tab is shown
 * @param {object} [request.deps] tests: {locate, run, paths, timeoutMs}
 * @returns {Promise<{text: string} | {idioms: object[]}>} (actions.js finishReply)
 */
export async function run({action, text, settings, request = null, cancellable = null,
    network = null, cache = new Map(), deps = {}}) {
    const {locate: find = locate, run: exec = runProcess, paths = defaultPaths(),
        timeoutMs = null} = deps;
    if (!isOnline(network)) {
        throw new WritingError('offline', 'No internet connection: Claude Code cannot reach Anthropic.');
    }
    const bin = await find();
    if (!bin) {
        throw new WritingError('not-installed', 'Claude Code was not found.',
            'Settings → Writing explains how to install it.');
    }
    const cwd = await workingFolder(paths);
    if (!cache.get('claude-code-auth')?.ok) {
        const auth = await authCheck(bin, cwd, cancellable, exec);
        if (!auth.ok) {
            throw new WritingError(auth.code, auth.message, auth.code === 'not-signed-in'
                ? 'Run `claude auth login` in a terminal, then try again.' : '');
        }
        cache.set('claude-code-auth', auth);
    }
    const chosen = settings.get_string('writing-claude-code-model');
    const model = CLAUDE_MODELS.includes(chosen) ? chosen : 'haiku';
    const wrapped = request ?? buildRequest(stepsFor(action)[0], text);
    const argv = claudeArgv(bin, wrapped, model);
    const {unset, set} = claudeEnv(model);
    const result = await exec({argv, cwd, unset, set, stdin: wrapped.message, cancellable,
        timeoutMs: timeoutMs ?? runTimeoutMs(text.length, model), label: LABEL});
    const raw = parseResult(result.stdout, result.stderr, result.exitOk);
    return finishReply(wrapped, raw, text.includes('```'), text);
}

export function modelLabel(model) {
    return model === 'sonnet' ? 'Sonnet' : 'Haiku';
}

export default {
    id: ID,
    title: 'Claude Code',
    cloud: true,
    prompted: true,
    actions: ['grammar', 'shorten', 'formal', 'humanize', 'translate'],
    limit: LIMITS[ID],
    busyText: ({chars = 0} = {}) => busyText(chars),
    destination: settings =>
        `Sends to Anthropic, through your Claude Code (${modelLabel(
            settings.get_string('writing-claude-code-model'))} · your plan's usage)`,
    /** Ready in the tab when it is found; sign-in problems come from the run. */
    async availability() {
        try {
            return await locate() ? {ready: true, reason: ''}
                : {ready: false, reason: 'not found'};
        } catch (e) {
            return {ready: false, reason: 'not found'};
        }
    },
    run,
};
