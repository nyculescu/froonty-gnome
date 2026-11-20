// SPDX-License-Identifier: GPL-3.0-or-later
// Which AI Horizon uses, chosen in Settings → Widgets instead of Horizon's
// wizard (docs/features/widgets.md): this computer's model (Writing's
// Ollama), a ChatGPT plan, or an API key. Froonty writes the `ai` part of
// Horizon's config.json before each refresh and keeps the rest; without a
// config.json it writes a starter one (Hacker News, as the wizard does when
// no source is chosen). Gio and GLib only for paths, so Settings and the
// unit tests load it too.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const SOURCES = ['local', 'chatgpt', 'api', 'config'];

// Froonty's Ollama (Writing), on this computer only.
export const LOCAL_BASE_URL = 'http://127.0.0.1:11434/v1';

// Horizon's providers that take an API key, with the variable Horizon reads
// it from and Horizon's default model (src/models.py AI_PROVIDER_DEFAULTS).
export const PROVIDERS = [
    {id: 'anthropic', name: 'Anthropic (Claude API)', keyEnv: 'ANTHROPIC_API_KEY', model: 'claude-sonnet-5-5'},
    {id: 'openai', name: 'OpenAI API', keyEnv: 'OPENAI_API_KEY', model: 'gpt-4'},
    {id: 'gemini', name: 'Google Gemini', keyEnv: 'GOOGLE_API_KEY', model: 'gemini-1.5-flash'},
    {id: 'deepseek', name: 'DeepSeek', keyEnv: 'DEEPSEEK_API_KEY', model: 'deepseek-chat'},
    {id: 'ali', name: 'Alibaba Qwen (DashScope)', keyEnv: 'DASHSCOPE_API_KEY', model: 'qwen-plus'},
    {id: 'minimax', name: 'MiniMax', keyEnv: 'MINIMAX_API_KEY', model: 'MiniMax-M3.1-Flash'},
    {id: 'doubao', name: 'Doubao', keyEnv: 'DOUBAO_API_KEY', model: 'doubao-pro-32k'},
];

export const providerById = id => PROVIDERS.find(p => p.id === id) ?? null;

// Fields of an existing `ai` block the user may have tuned; the rest
// (provider, model, provider_chain, keys, Azure fields) is Froonty's.
const KEPT = ['temperature', 'max_tokens', 'throttle_sec', 'analysis_concurrency',
    'enrichment_concurrency', 'languages'];

/**
 * Horizon's `ai` block for the chosen source.
 *
 * @param {object} choice
 * @param {string} choice.source one of SOURCES
 * @param {string} [choice.writingModel] writing-ollama-model
 * @param {string} [choice.provider] horizon-ai-provider
 * @param {string} [choice.model] horizon-ai-model (empty: the provider's default)
 * @param {string} [choice.chatgptModel] horizon-chatgpt-model
 * @param {string} [choice.chatgptAccount] horizon-chatgpt-account
 * @returns {{ai: ?object, keyEnv: ?string, error: ?string}} ai null for
 *   'config' (Horizon's own config.json is used as it is); error says what
 *   is missing
 */
export function aiFor({source, writingModel = '', provider = '', model = '',
    chatgptModel = '', chatgptAccount = ''}) {
    switch (source) {
    case 'local':
        if (!writingModel)
            return {ai: null, keyEnv: null, error: 'no-local-model'};
        return {
            ai: {provider: 'ollama', model: writingModel, base_url: LOCAL_BASE_URL, api_key_env: ''},
            keyEnv: null, error: null,
        };
    case 'chatgpt':
        if (!chatgptModel)
            return {ai: null, keyEnv: null, error: 'no-chatgpt-model'};
        return {
            ai: {provider: 'openai-chatgpt', model: chatgptModel, api_key_env: '',
                chatgpt_account: chatgptAccount || null},
            keyEnv: null, error: null,
        };
    case 'api': {
        const p = providerById(provider);
        if (!p)
            return {ai: null, keyEnv: null, error: 'no-provider'};
        return {
            ai: {provider: p.id, model: model.trim() || p.model, api_key_env: p.keyEnv},
            keyEnv: p.keyEnv, error: null,
        };
    }
    default:
        return {ai: null, keyEnv: null, error: null};
    }
}

/**
 * The starter config.json, as Horizon's wizard builds it when no source
 * is chosen: Hacker News, the last day, its three profiles.
 */
export function starterConfig(ai) {
    return {
        ai: {temperature: 0.3, max_tokens: 4096, languages: ['en'], ...ai},
        sources: {hackernews: {enabled: true, fetch_top_stories: 30, min_score: 100}},
        collection: {time_window_hours: 24},
        digest: {profile_order: ['tech-news', 'tech-blog', 'finance-news']},
        processing: {
            profile_settings: {
                'tech-news': {threshold: 7.0},
                'tech-blog': {threshold: 4.0, topic_dedup: false},
                'finance-news': {threshold: 7.0},
            },
        },
    };
}

/**
 * config.json with Froonty's `ai` block: the existing file's other parts
 * and tuning kept, or the starter config when there is none.
 *
 * @param {?string} existing the current config.json, or null
 * @param {object} ai aiFor()'s block
 * @returns {object}
 * @throws {SyntaxError} when the existing file is not a JSON object
 */
export function withAi(existing, ai) {
    if (existing === null)
        return starterConfig(ai);
    const config = JSON.parse(existing);
    if (!config || typeof config !== 'object' || Array.isArray(config))
        throw new SyntaxError('config.json is not a JSON object');
    const kept = {};
    for (const key of KEPT) {
        if (config.ai?.[key] !== undefined)
            kept[key] = config.ai[key];
    }
    return {...config, ai: {temperature: 0.3, max_tokens: 4096, languages: ['en'], ...kept, ...ai}};
}

/** The first JSON value horizon-chatgpt prints (it adds lines after it). */
export function cliJson(text) {
    const start = text.search(/[[{]/);
    if (start < 0)
        return null;
    const close = text[start] === '{' ? '}' : ']';
    for (let end = text.lastIndexOf(close); end > start; end = text.lastIndexOf(close, end - 1)) {
        try {
            return JSON.parse(text.slice(start, end + 1));
        } catch {}
    }
    return null;
}

/** The Horizon submodule next to the extension's source folder, or ''. */
export function defaultHorizonRepoPath() {
    const file = Gio.File.new_for_uri(import.meta.url)
        .get_parent().get_parent().get_parent().get_parent().get_parent()
        .get_child('third_party').get_child('Horizon');
    return file.query_exists(null) ? file.get_path() : '';
}

// Where make horizon-setup puts Horizon's environment: the user's cache
// (~/.cache/horizon-venv), the same from the devkit, whose own cache folder
// differs, and the devkit's cache, where it went before 2026-11-13.
export function horizonVenvDirs() {
    const home = GLib.get_home_dir();
    const dirs = [
        GLib.build_filenamev([GLib.get_user_cache_dir(), 'horizon-venv']),
        GLib.build_filenamev([home, '.cache', 'horizon-venv']),
        GLib.build_filenamev([home, '.cache', 'froonty-devkit', 'cache', 'horizon-venv']),
    ];
    return [...new Set(dirs)];
}

/** A program in Horizon's environment, from the first that has it (the first if none does). */
export function horizonBin(name) {
    const paths = horizonVenvDirs().map(dir => GLib.build_filenamev([dir, 'bin', name]));
    return paths.find(path => GLib.file_test(path, GLib.FileTest.IS_EXECUTABLE)) ?? paths[0];
}
