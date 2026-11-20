// SPDX-License-Identifier: GPL-3.0-or-later
import {aiFor, cliJson, LOCAL_BASE_URL, starterConfig, withAi} from '../../froonty@catalin/features/widgets/news/horizonAi.js';
import {parseHorizonMarkdown} from '../../froonty@catalin/features/widgets/news/parser.js';
import {done, eq, test} from './test.js';

test('parses Markdown headline links and summaries', () => {
    eq(parseHorizonMarkdown([
        '# Daily briefing',
        '',
        '- [GNOME 50 released](https://example.com/gnome) — A new Shell release.',
        '- [Another story](https://example.com/story)',
    ].join('\n')), [
        {title: 'GNOME 50 released', url: 'https://example.com/gnome', summary: 'A new Shell release.'},
        {title: 'Another story', url: 'https://example.com/story', summary: ''},
    ]);
});

test('parses Horizon\'s own briefing: linked headings, the paragraph\'s first sentence', () => {
    eq(parseHorizonMarkdown([
        '# Horizon Daily - 2026-11-14',
        '**Technology News**',
        '1. [Terminal Borders](#item-tech-news-1) ⭐️ 8.0/10',
        '## Technology News',
        '<a id="item-tech-news-1"></a>',
        '### [Terminal Borders](https://www.joshka.net/cell-borders/) ⭐️ 8.0/10',
        '',
        'Borders drawn without consuming cells. Available in Ratatui 0.20.',
        '',
        'hackernews · vinhnx · Nov 13, 23:06 · [Discussion](https://news.ycombinator.com/item?id=1)',
        '### [No paragraph](https://example.com/b) ⭐️ 5.0/10',
        '**Tags**: `#x`',
    ].join('\n')), [
        {title: 'Terminal Borders', url: 'https://www.joshka.net/cell-borders/',
            summary: 'Borders drawn without consuming cells.'},
        {title: 'No paragraph', url: 'https://example.com/b', summary: ''},
    ]);
});

test('ignores Markdown without a usable linked headline', () => {
    eq(parseHorizonMarkdown('# Briefing\n\nNo links here.'), []);
});

test('Horizon AI: Writing\'s model on this computer, no key', () => {
    eq(aiFor({source: 'local', writingModel: 'qwen3:4b'}), {
        ai: {provider: 'ollama', model: 'qwen3:4b', base_url: LOCAL_BASE_URL, api_key_env: ''},
        keyEnv: null, error: null,
    });
    eq(aiFor({source: 'local', writingModel: ''}).error, 'no-local-model');
});

test('Horizon AI: an API key provider, its default model, the variable for the key', () => {
    eq(aiFor({source: 'api', provider: 'anthropic', model: ' '}).ai,
        {provider: 'anthropic', model: 'claude-sonnet-5-5', api_key_env: 'ANTHROPIC_API_KEY'});
    eq(aiFor({source: 'api', provider: 'openai', model: 'gpt-5'}).keyEnv, 'OPENAI_API_KEY');
    eq(aiFor({source: 'api', provider: 'nonsense'}).error, 'no-provider');
});

test('Horizon AI: a ChatGPT plan needs a model; config leaves Horizon\'s own', () => {
    eq(aiFor({source: 'chatgpt', chatgptModel: 'gpt-5', chatgptAccount: 'abc'}).ai,
        {provider: 'openai-chatgpt', model: 'gpt-5', api_key_env: '', chatgpt_account: 'abc'});
    eq(aiFor({source: 'chatgpt'}).error, 'no-chatgpt-model');
    eq(aiFor({source: 'config'}), {ai: null, keyEnv: null, error: null});
});

test('Horizon config: a starter one, or the user\'s kept with only the AI replaced', () => {
    const ai = aiFor({source: 'local', writingModel: 'm'}).ai;
    const fresh = withAi(null, ai);
    eq(fresh, starterConfig(ai));
    eq([fresh.ai.provider, fresh.ai.languages, fresh.sources.hackernews.enabled], ['ollama', ['en'], true]);

    const mine = JSON.stringify({
        ai: {provider: 'openai', provider_chain: 'openai,anthropic', model: 'gpt-4',
            api_key_env: 'OPENAI_API_KEY', temperature: 0.1, languages: ['en', 'ro']},
        sources: {rss: [{name: 'LWN', url: 'https://lwn.net/headlines/rss'}]},
    });
    const merged = withAi(mine, ai);
    eq(merged.sources, JSON.parse(mine).sources);
    eq(merged.ai, {temperature: 0.1, max_tokens: 4096, languages: ['en', 'ro'], ...ai});
    let thrown = null;
    try {
        withAi('[1, 2]', ai);
    } catch (e) {
        thrown = e;
    }
    eq(thrown instanceof SyntaxError, true);
});

test('horizon-chatgpt output: the JSON before its trailing lines', () => {
    eq(cliJson('{\n  "connected": true\n}\nManage usage: https://chatgpt.com/settings/usage\n'), {connected: true});
    eq(cliJson('[{"slug": "gpt-5"}]\n'), [{slug: 'gpt-5'}]);
    eq(cliJson('ChatGPT: not signed in'), null);
});

done();
