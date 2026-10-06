// SPDX-License-Identifier: GPL-3.0-or-later
// The LanguageTool engine, against a local fake server only.
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

import {applyMatches, ATTRIBUTION, formFields, RateLimiter, run, VARIANTS} from
    '../../froonty@catalin/features/writing/engines/languageTool.js';
import {done, eq, ok, test} from './test.js';
import {FakeNetwork, FakeServer, makeSettings, rejectsWith} from './writing-helpers.js';

const match = (offset, length, value, context = null, message = 'Possible spelling mistake found.') => ({
    offset, length, message,
    replacements: value === null ? [] : [{value}],
    ...context ? {context} : {},
});

test('form fields: the text, auto language, valid variants only', () => {
    eq(formFields('Hi', 'en-US,de-DE'), {text: 'Hi', language: 'auto', preferredVariants: 'en-US,de-DE'});
    eq(formFields('Hi', 'english'), {text: 'Hi', language: 'auto'});
    ok(VARIANTS.test('pt-BR') && VARIANTS.test('en-GB,de-AT') && !VARIANTS.test('en-us') &&
        !VARIANTS.test('en-US,') && !VARIANTS.test(''));
});

test('applyMatches: one, two, overlapping, no replacement, wrong context', () => {
    eq(applyMatches('teh cat', [match(0, 3, 'the')]).text, 'the cat');
    const two = applyMatches('teh cat sat on teh mat', [match(15, 3, 'the'), match(0, 3, 'The')]);
    eq(two.text, 'The cat sat on the mat');
    eq(two.changes, [
        {from: 'teh', to: 'The', message: 'Possible spelling mistake found.'},
        {from: 'teh', to: 'the', message: 'Possible spelling mistake found.'},
    ]);
    eq(applyMatches('abcdef', [match(0, 4, 'X'), match(2, 3, 'Y')]).text, 'Xef', 'the overlap is skipped');
    const note = applyMatches('This are wrong', [match(5, 3, null, null, 'Agreement?')]);
    eq(note.text, 'This are wrong');
    eq(note.notes, [{message: 'Agreement?', excerpt: 'are'}]);
    eq(applyMatches('teh cat', [match(0, 3, 'the', {text: 'xyz cat', offset: 0, length: 3})]).text,
        'teh cat', 'a context that does not fit is skipped');
    eq(applyMatches('teh cat', [match(0, 3, 'the', {text: '…teh cat', offset: 1, length: 3})]).text,
        'the cat');
});

test('applyMatches: UTF-16 offsets after emoji and CJK', () => {
    const text = '😀 日本 teh end';
    const offset = text.indexOf('teh');
    eq(offset, 6, 'an emoji is two UTF-16 units');
    eq(applyMatches(text, [match(offset, 3, 'the')]).text, '😀 日本 the end');
    eq(applyMatches('a teh b teh c teh', [match(2, 3, 'the'), match(8, 3, 'the'), match(14, 3, 'the')]).text,
        'a the b the c the', 'applied from the end');
});

test('rate limiter: 10 texts or 60 KB a minute', () => {
    let now = 0;
    const limiter = new RateLimiter({now: () => now});
    for (let i = 0; i < 10; i++) {
        eq(limiter.wait(100), 0);
        limiter.record(100);
        now += 1000;
    }
    eq(limiter.wait(100), 50, 'at 10 s, the first one leaves the window at 60 s');
    now = 61000;
    eq(limiter.wait(100), 0);
    const bytes = new RateLimiter({now: () => now});
    bytes.record(50000);
    eq(bytes.wait(20000) > 0, true, 'over 60 KB in a minute');
    eq(bytes.wait(10000), 0);
});

test('rate limiter: its message names the limit that holds the text back', () => {
    const now = 0;
    const limiter = new RateLimiter({now: () => now});
    for (let i = 0; i < 3; i++)
        limiter.record(20000);
    const bytes = limiter.check(20000);
    eq(bytes.limit, 'bytes', 'three 20 KB texts: the 60 KB limit, not the 10 texts');
    eq(limiter.describe(bytes.limit), 'Froonty sends LanguageTool at most 60 KB of text a minute.');
    const texts = new RateLimiter({now: () => now});
    for (let i = 0; i < 10; i++)
        texts.record(10);
    eq(texts.check(10).limit, 'texts');
    eq(texts.describe('texts'), 'Froonty sends LanguageTool at most 10 texts a minute.');
    eq(texts.check(10).seconds, 60);
});

function lt(server, settings = makeSettings(), extra = {}) {
    settings.set_string('writing-languagetool-variants', 'en-GB,de-DE');
    return run({action: 'grammar', text: 'teh cat', settings, network: new FakeNetwork(),
        deps: {url: `${server.url}/v2/check`, limiter: new RateLimiter()}, ...extra});
}

test('a check: one POST of form fields, the corrected text and the attribution', async () => {
    const server = new FakeServer({
        'POST /v2/check': () => ({body: JSON.stringify({matches: [match(0, 3, 'the',
            {text: 'teh cat', offset: 0, length: 3})]})}),
    });
    try {
        const result = await lt(server);
        eq(result.text, 'the cat');
        eq(result.changes.length, 1);
        eq(result.attribution, ATTRIBUTION);
        eq(server.requests.length, 1);
        const form = Soup.form_decode(server.requests[0].body);
        eq([form.text, form.language, form.preferredVariants], ['teh cat', 'auto', 'en-GB,de-DE']);
        eq(server.requests[0].headers.get_one('Content-Type'), 'application/x-www-form-urlencoded');
    } finally {
        server.close();
    }
});

test('LanguageTool\'s errors: 413, 429, 400, 503', async () => {
    const answers = {413: 'too-long', 429: 'rate-limited', 400: 'failed', 503: 'unavailable'};
    for (const [status, code] of Object.entries(answers)) {
        const server = new FakeServer({
            'POST /v2/check': () => ({status: Number(status), type: 'text/plain',
                body: 'Error: Invalid request'}),
        });
        try {
            // eslint-disable-next-line no-await-in-loop
            const error = await rejectsWith(lt(server), code);
            if (status === '400')
                ok(error.message.startsWith('Error: Invalid request'), error.message);
        } finally {
            server.close();
        }
    }
});

test('nothing listening: offline; offline network: nothing sent; cancel', async () => {
    await rejectsWith(run({action: 'grammar', text: 'teh', settings: makeSettings(),
        network: new FakeNetwork(), deps: {url: 'http://127.0.0.1:1/v2/check',
            limiter: new RateLimiter()}}), 'offline');
    const server = new FakeServer({'POST /v2/check': () => 'hang'});
    try {
        await rejectsWith(run({action: 'grammar', text: 'teh', settings: makeSettings(),
            network: new FakeNetwork(Gio.NetworkConnectivity.PORTAL),
            deps: {url: `${server.url}/v2/check`, limiter: new RateLimiter()}}), 'offline');
        eq(server.requests.length, 0);
        const cancellable = new Gio.Cancellable();
        const running = lt(server, makeSettings(), {cancellable});
        cancellable.cancel();
        await rejectsWith(running, 'cancelled');
        await rejectsWith(run({action: 'formal', text: 'x', settings: makeSettings(),
            network: new FakeNetwork(), deps: {url: `${server.url}/v2/check`}}), 'failed');
    } finally {
        server.close();
    }
});

test('Froonty\'s own limit answers before anything is sent', async () => {
    const server = new FakeServer({'POST /v2/check': () => ({body: '{"matches":[]}'})});
    try {
        const limiter = new RateLimiter({maxRequests: 1});
        const deps = {url: `${server.url}/v2/check`, limiter};
        const request = () => run({action: 'grammar', text: 'Fine.', settings: makeSettings(),
            network: new FakeNetwork(), deps});
        eq((await request()).changes, []);
        const error = await rejectsWith(request(), 'rate-limited');
        ok(/^Wait \d+ s: Froonty sends LanguageTool at most 1 texts a minute\.$/.test(error.message),
            error.message);
        eq(server.requests.length, 1);
        // Three texts of 20 KB: the fourth waits for the 60 KB limit.
        const big = 'a'.repeat(20000);
        const byBytes = {url: `${server.url}/v2/check`, limiter: new RateLimiter()};
        for (let i = 0; i < 3; i++) {
            // eslint-disable-next-line no-await-in-loop
            await run({action: 'grammar', text: big, settings: makeSettings(), network: new FakeNetwork(),
                deps: byBytes});
        }
        const fourth = await rejectsWith(run({action: 'grammar', text: big, settings: makeSettings(),
            network: new FakeNetwork(), deps: byBytes}), 'rate-limited');
        ok(fourth.message.endsWith('at most 60 KB of text a minute.'), fourth.message);
        eq(server.requests.length, 4);
    } finally {
        server.close();
    }
});

await done();
