// SPDX-License-Identifier: GPL-3.0-or-later
// Settings → Writing's set-up and removal, against a fake release server,
// fake Ollama, fake systemctl and tiny archives made here. Nothing is
// downloaded from the internet, installed, started or removed for real.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {newSession} from '../../froonty@catalin/features/writing/http.js';
import {deleteTree, isInside} from '../../froonty@catalin/features/writing/setup/fs.js';
import {checkListing, download, install, linkInside, pickAsset, prepare, sumsMatch, UNIT_MARKER,
    unitText} from '../../froonty@catalin/features/writing/setup/ollamaInstall.js';
import {everythingRemovalPlan, execute, gatherFacts, ollamaRemovalPlan} from
    '../../froonty@catalin/features/writing/setup/remove.js';
import {emptyState, readState, validateState, writeState} from
    '../../froonty@catalin/features/writing/setup/state.js';
import {done, eq, ok, test} from './test.js';
import {exists, FakeServer, fakePaths, fileMode, makeSettings, readFile, rejectsWith, sleep, tempDir,
    writeFile, writeScript} from './writing-helpers.js';

const DIGEST = 'b'.repeat(64);
const ASSET = 'ollama-linux-amd64.tar.zst';

function sh(argv) {
    const proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
    const [, stdout, stderr] = proc.communicate_utf8(null, null);
    if (!proc.get_successful())
        throw new Error(`${argv.join(' ')}: ${stderr}`);
    return stdout;
}

function bytesOf(path) {
    return GLib.file_get_contents(path)[1];
}

const sha256 = bytes => GLib.compute_checksum_for_data(GLib.ChecksumType.SHA256, bytes);

/** A tiny archive laid out like Ollama's. */
function goodArchive() {
    const root = tempDir();
    writeScript(`${root}/tree/bin/ollama`, 'echo fake ollama');
    writeFile(`${root}/tree/lib/ollama/libggml.so.1`, 'lib');
    Gio.File.new_for_path(`${root}/tree/lib/ollama/libggml.so`).make_symbolic_link('libggml.so.1', null);
    GLib.mkdir_with_parents(`${root}/tree/lib/ollama/cuda_v12`, 0o755);
    sh(['/usr/bin/tar', '--zstd', '-C', `${root}/tree`, '-cf', `${root}/${ASSET}`, '.']);
    return `${root}/${ASSET}`;
}

/** An archive with one hostile member, made with Python's tarfile. */
function badArchive(kind) {
    const root = tempDir();
    const script = `
import io, sys, tarfile
t = tarfile.open(sys.argv[1], "w")
def add(name, data=b"x", mode=0o755):
    info = tarfile.TarInfo(name); info.size = len(data); info.mode = mode
    t.addfile(info, io.BytesIO(data))
def link(name, target):
    info = tarfile.TarInfo(name); info.type = tarfile.SYMTYPE; info.linkname = target
    t.addfile(info)
add("bin/ollama")
kind = sys.argv[2]
if kind == "dotdot": add("../evil")
if kind == "absolute": add("/abs")
if kind == "other": add("bin/other")
if kind == "etc": link("lib/ollama/etc", "/etc")
if kind == "outside": link("lib/ollama/up", "../../bin/ollama")
t.close()
`;
    writeFile(`${root}/make.py`, script);
    sh(['/usr/bin/python3', `${root}/make.py`, `${root}/a.tar`, kind]);
    sh(['/usr/bin/zstd', '-q', '-f', `${root}/a.tar`, '-o', `${root}/${ASSET}`]);
    return `${root}/${ASSET}`;
}

function releaseServer(archive, {digest = null, sums = null, url = null, size = null} = {}) {
    const bytes = bytesOf(archive);
    const hash = sha256(bytes);
    const server = new FakeServer();
    const base = `${server.url}/ollama/ollama/releases/download/v0.35.1`;
    server.routes = {
        'GET /repos/ollama/ollama/releases/latest': () => ({body: JSON.stringify({
            tag_name: 'v0.35.1',
            assets: [
                {name: ASSET, size: size ?? bytes.length, digest: `sha256:${digest ?? hash}`,
                    browser_download_url: url ?? `${base}/${ASSET}`},
                {name: 'sha256sum.txt', size: 100, browser_download_url: `${base}/sha256sum.txt`},
            ],
        })}),
        [`GET /ollama/ollama/releases/download/v0.35.1/${ASSET}`]: () =>
            ({type: 'application/octet-stream', bytes}),
        'GET /ollama/ollama/releases/download/v0.35.1/sha256sum.txt': () =>
            ({type: 'text/plain', body: sums ?? `${hash}  ./${ASSET}\n${'c'.repeat(64)}  ./other\n`}),
    };
    server.api = `${server.url}/repos/ollama/ollama/releases/latest`;
    return server;
}

// A fake Ollama that answers once the fake systemctl has started it.
function fakeOllama(log) {
    return new FakeServer({
        'GET /api/version': () => (/start/.test(readFile(log) ?? '') ? {body: '{"version":"0.35.1"}'}
            : {status: 503}),
        'GET /api/tags': () => ({body: '{"models":[]}'}),
    });
}

function setupDeps(release, ollama, paths, log) {
    return {
        paths,
        session: newSession(5),
        url: ollama.url,
        api: release.api,
        systemctl: writeScript(`${GLib.path_get_dirname(log)}/systemctl`, `echo "$@" >>"${log}"`),
        machine: async () => 'x86_64',
        systemBinaries: [],
        freeBytes: async () => 1e12,
        startWaitMs: 3000,
    };
}

// ---------------------------------------------------------------- state

test('state: missing, damaged, tampered or odd files read as nothing recorded', async () => {
    const paths = fakePaths();
    eq(await readState(paths), emptyState());
    writeFile(paths.stateFile, '{not json');
    eq(await readState(paths), emptyState());
    const good = {version: 1, ollama: {installedByFroonty: true, prefix: paths.ollamaPrefix,
        unit: paths.unitName, release: 'v0.35.1', asset: ASSET, sha256: DIGEST, step: 'done',
        models: [{name: 'llama3.2:3b', digest: DIGEST, pulledAt: 'x', step: 'done'}]}};
    eq(validateState(good, paths).ollama.models.length, 1);
    eq(validateState({...good, ollama: {...good.ollama, prefix: '/home'}}, paths), emptyState());
    eq(validateState({...good, ollama: {...good.ollama, unit: 'evil.service'}}, paths), emptyState());
    eq(validateState({...good, ollama: {...good.ollama, models: [{name: '../x', step: 'done'}]}}, paths),
        emptyState());
    eq(validateState({...good, ollama: {...good.ollama, models: [{name: 'a', digest: 'zz', step: 'done'}]}},
        paths), emptyState());
    eq(validateState({...good, version: 2}, paths), emptyState());
    await writeState(paths, good);
    eq(fileMode(paths.stateFile), 0o600);
    eq(fileMode(paths.dataDir), 0o700);
    eq((await readState(paths)).ollama.release, 'v0.35.1');
});

// ---------------------------------------------------------------- checks

test('the release asset: exact name, GitHub address, size cap, digest; sums must agree', () => {
    const release = {tag_name: 'v0.35.1', assets: [
        {name: ASSET, size: 1439658961, digest: `sha256:${DIGEST}`,
            browser_download_url: `https://github.com/ollama/ollama/releases/download/v0.35.1/${ASSET}`},
        {name: 'sha256sum.txt', browser_download_url: 'https://github.com/ollama/ollama/releases/download/v0.35.1/sha256sum.txt'},
    ]};
    eq(pickAsset(release, 'amd64').sha256, DIGEST);
    const code = fn => {
        try {
            fn();
            return 'none';
        } catch (e) {
            return e.code;
        }
    };
    eq(code(() => pickAsset(release, 'arm64')), 'failed', 'no such asset');
    const moved = JSON.parse(JSON.stringify(release));
    moved.assets[0].browser_download_url = 'https://evil.example/ollama.tar.zst';
    eq(code(() => pickAsset(moved, 'amd64')), 'failed', 'another host');
    const huge = JSON.parse(JSON.stringify(release));
    huge.assets[0].size = 4000000001;
    eq(code(() => pickAsset(huge, 'amd64')), 'failed', 'over 4 GB');
    const unsigned = JSON.parse(JSON.stringify(release));
    delete unsigned.assets[0].digest;
    eq(code(() => pickAsset(unsigned, 'amd64')), 'failed', 'no digest');
    ok(sumsMatch(`${DIGEST}  ./${ASSET}\n`, ASSET, DIGEST));
    ok(!sumsMatch(`${'c'.repeat(64)}  ./${ASSET}\n`, ASSET, DIGEST));
    ok(!sumsMatch(`${DIGEST}  ./other\n`, ASSET, DIGEST));
});

test('the listing: only bin/ollama and lib/ollama, links that stay inside', () => {
    const line = (type, name, target = null) =>
        `${type}rwxr-xr-x root/root 10 2026-09-29 12:34 ${name}${target ? ` -> ${target}` : ''}`;
    const good = [line('d', './'), line('d', './bin/'), line('-', './bin/ollama'), line('d', './lib/'),
        line('d', './lib/ollama/'), line('-', './lib/ollama/libggml.so.1'),
        line('l', './lib/ollama/libggml.so', 'libggml.so.1')].join('\n');
    eq(checkListing(good).entries, 7);
    for (const bad of [line('-', '../evil'), line('-', '/abs'), line('-', 'bin/other'),
        line('l', 'lib/ollama/etc', '/etc'), line('l', 'lib/ollama/up', '../../bin/ollama'),
        line('-', 'lib/ollama/a b'), 'hrw-r--r-- root/root 0 2026-09-29 12:34 lib/ollama/x link to y']) {
        let threw = false;
        try {
            checkListing(`${good}\n${bad}`);
        } catch (e) {
            threw = true;
        }
        ok(threw, bad);
    }
    let noBinary = false;
    try {
        checkListing(line('d', './lib/'));
    } catch (e) {
        noBinary = true;
    }
    ok(noBinary, 'bin/ollama is required');
    ok(linkInside('lib/ollama/cuda/libx.so', '../libggml.so.1'));
    ok(!linkInside('lib/ollama/libx.so', '../../etc/passwd'));
});

// ---------------------------------------------------------------- install

test('Set up: download, verify, unpack, unit, start; recorded step by step', async () => {
    const archive = goodArchive();
    const release = releaseServer(archive);
    const dir = tempDir();
    const log = `${dir}/systemctl.log`;
    const ollama = fakeOllama(log);
    try {
        const paths = fakePaths();
        const deps = setupDeps(release, ollama, paths, log);
        const plan = await prepare(deps);
        eq([plan.version, plan.asset, plan.arch], ['v0.35.1', ASSET, 'amd64']);
        eq(plan.unitText, unitText(paths.ollamaPrefix));
        const stages = [];
        await install(plan, deps, {onProgress: stage => {
            if (stages[stages.length - 1] !== stage)
                stages.push(stage);
        }});
        eq(stages, ['downloading', 'verifying', 'extracting', 'unit', 'starting']);
        ok(exists(`${paths.ollamaPrefix}/bin/ollama`) && exists(`${paths.ollamaPrefix}/lib/ollama/libggml.so`));
        eq(readFile(paths.unitFile), [
            UNIT_MARKER,
            '[Unit]',
            'Description=Ollama for Froonty\'s Writing tab',
            '[Service]',
            `ExecStart=${paths.ollamaPrefix}/bin/ollama serve`,
            `Environment=HOME=${paths.ollamaPrefix}/home`,
            `Environment=OLLAMA_MODELS=${paths.ollamaPrefix}/models`,
            'Environment=OLLAMA_HOST=127.0.0.1:11434',
            'Environment=OLLAMA_NO_CLOUD=1',
            'Restart=on-failure',
            'RestartSec=3',
            ''].join('\n'));
        eq(fileMode(paths.unitFile), 0o644);
        ok(!readFile(paths.unitFile).includes('[Install]'), 'never starts at login');
        eq(readFile(log), '--user daemon-reload\n--user start froonty-ollama.service\n');
        const state = await readState(paths);
        eq([state.ollama.installedByFroonty, state.ollama.step, state.ollama.sha256],
            [true, 'done', sha256(bytesOf(archive))]);
        ok(!exists(plan.part) && !exists(paths.stagingDir), 'no download or staging left');
    } finally {
        release.close();
        ollama.close();
    }
});

test('Set up refuses: digests that disagree, a wrong hash, hostile archives', async () => {
    const dir = tempDir();
    const log = `${dir}/systemctl.log`;
    const ollama = fakeOllama(log);
    try {
        const archive = goodArchive();
        const disagree = releaseServer(archive, {sums: `${'c'.repeat(64)}  ./${ASSET}\n`});
        try {
            await rejectsWith(prepare(setupDeps(disagree, ollama, fakePaths(), log)), 'failed');
            eq(disagree.requests.filter(r => r.path.endsWith(ASSET)).length, 0, 'nothing downloaded');
        } finally {
            disagree.close();
        }

        const wrongHash = releaseServer(archive, {digest: DIGEST, sums: `${DIGEST}  ./${ASSET}\n`});
        try {
            const paths = fakePaths();
            const deps = setupDeps(wrongHash, ollama, paths, log);
            const plan = await prepare(deps);
            const error = await rejectsWith(install(plan, deps), 'failed');
            ok(error.message.includes('SHA-256'), error.message);
            ok(!exists(plan.part) && !exists(paths.ollamaPrefix), 'the .part is deleted, nothing unpacked');
        } finally {
            wrongHash.close();
        }

        for (const kind of ['dotdot', 'absolute', 'other', 'etc', 'outside']) {
            const hostile = releaseServer(badArchive(kind));
            try {
                const paths = fakePaths();
                const deps = setupDeps(hostile, ollama, paths, log);
                // eslint-disable-next-line no-await-in-loop
                const plan = await prepare(deps);
                // eslint-disable-next-line no-await-in-loop
                await rejectsWith(install(plan, deps), 'failed');
                ok(!exists(paths.ollamaPrefix) && !exists(paths.stagingDir) && !exists(plan.part), kind);
            } finally {
                hostile.close();
            }
        }
        eq(readFile(log), null, 'systemctl never ran');
    } finally {
        ollama.close();
    }
});

test('Set up refuses: another address, too large, a unit not Froonty\'s, Ollama already there', async () => {
    const dir = tempDir();
    const log = `${dir}/systemctl.log`;
    const ollama = fakeOllama(log);
    const archive = goodArchive();
    try {
        const elsewhere = releaseServer(archive, {url: 'https://example.com/ollama.tar.zst'});
        await rejectsWith(prepare(setupDeps(elsewhere, ollama, fakePaths(), log)), 'failed');
        elsewhere.close();
        const huge = releaseServer(archive, {size: 4000000001});
        await rejectsWith(prepare(setupDeps(huge, ollama, fakePaths(), log)), 'failed');
        huge.close();

        const release = releaseServer(archive);
        try {
            const paths = fakePaths();
            writeFile(paths.unitFile, '[Service]\nExecStart=/usr/bin/something-of-yours\n');
            const deps = setupDeps(release, ollama, paths, log);
            await rejectsWith(install(await prepare(deps), deps), 'failed');
            eq(readFile(paths.unitFile), '[Service]\nExecStart=/usr/bin/something-of-yours\n', 'left alone');

            const binaries = setupDeps(release, ollama, fakePaths(), log);
            binaries.systemBinaries = [writeScript(`${dir}/ollama`, 'true')];
            const error = await rejectsWith(prepare(binaries), 'failed');
            ok(error.message.includes('already installed'), error.message);

            writeFile(log, 'start\n');
            const running = await rejectsWith(prepare(setupDeps(release, ollama, fakePaths(), log)), 'failed');
            ok(running.message.includes('already running'), running.message);
        } finally {
            release.close();
        }
    } finally {
        ollama.close();
    }
});

test('cancelling a download leaves no .part', async () => {
    const server = new FakeServer({'GET /big': () => 'hang'});
    try {
        const part = `${tempDir()}/x.part`;
        const cancellable = new Gio.Cancellable();
        const running = download({session: newSession(5), url: `${server.url}/big`, partPath: part,
            size: 100, sha256: DIGEST, cancellable});
        await sleep(100);
        cancellable.cancel();
        await rejectsWith(running, 'cancelled');
        ok(!exists(part));
    } finally {
        server.close();
    }
});

// ---------------------------------------------------------------- remove

function systemFacts(paths, models, extra = {}) {
    return {paths, systemctl: '/fake/systemctl', running: models !== null, models,
        unitHasMarker: false, prefixExists: false, stagingExists: false, cacheExists: false,
        runtimeExists: false, dataExists: false, writingKeys: [], claude: {bin: null}, ...extra};
}

test('Remove with an Ollama of yours: only unchanged models Froonty downloaded', async () => {
    const paths = fakePaths();
    const other = 'd'.repeat(64);
    const state = validateState({version: 1, ollama: {installedByFroonty: false, models: [
        {name: 'gemma3:1b', digest: DIGEST, step: 'done'},
        {name: 'llama3.2:3b', digest: `sha256:${DIGEST}`, step: 'done'},
        {name: 'qwen3:4b', digest: null, step: 'pulling'}]}}, paths);
    const plan = ollamaRemovalPlan(state, systemFacts(paths, [
        {name: 'gemma3:1b', digest: DIGEST}, {name: 'llama3.2:3b', digest: other},
        {name: 'mistral:7b', digest: DIGEST}]));
    eq(plan.map(i => [i.id, i.name ?? '']), [['model', 'gemma3:1b'], ['model-changed', 'llama3.2:3b'],
        ['model-unfinished', 'qwen3:4b'], ['state', ''], ['keys', '']]);

    const server = new FakeServer({'DELETE /api/delete': () => ({body: ''})});
    try {
        await writeState(paths, state);
        const settings = makeSettings();
        settings.set_boolean('writing-ollama-enabled', true);
        const report = await execute(plan, {paths, run: null, session: newSession(5), url: server.url,
            settings});
        eq(report.failed, []);
        eq(server.requests.map(r => JSON.parse(r.body).model), ['gemma3:1b'], 'yours stay');
        eq((await readState(paths)).ollama, null);
        eq(settings.get_boolean('writing-ollama-enabled'), false);
    } finally {
        server.close();
    }
    // Not running: the model stays recorded, to remove later.
    await writeState(paths, state);
    const offline = ollamaRemovalPlan(state, systemFacts(paths, null));
    const report = await execute(offline, {paths, run: null, session: newSession(5),
        url: 'http://127.0.0.1:1', settings: makeSettings()});
    // Their digests cannot be checked: both stay recorded; the unfinished one is forgotten.
    eq(report.failed.map(f => f.item.name), ['gemma3:1b', 'llama3.2:3b']);
    eq((await readState(paths)).ollama.models.map(m => m.name), ['gemma3:1b', 'llama3.2:3b']);
});

test('Remove with Froonty\'s Ollama: service, unit, reload, folder; your models named', async () => {
    const paths = fakePaths();
    const dir = tempDir();
    const log = `${dir}/systemctl.log`;
    const systemctl = writeScript(`${dir}/systemctl`, `echo "$@" >>"${log}"`);
    writeScript(`${paths.ollamaPrefix}/bin/ollama`, 'true');
    writeFile(`${paths.ollamaPrefix}/models/blobs/x`, 'model');
    writeFile(paths.unitFile, unitText(paths.ollamaPrefix));
    await writeState(paths, {version: 1, ollama: {installedByFroonty: true, prefix: paths.ollamaPrefix,
        unit: paths.unitName, release: 'v0.35.1', asset: ASSET, sha256: DIGEST, step: 'done',
        models: [{name: 'llama3.2:3b', digest: DIGEST, step: 'done'}]}});
    const ollama = new FakeServer({'GET /api/tags': () => ({body: JSON.stringify({models: [
        {name: 'llama3.2:3b', digest: DIGEST}, {name: 'mistral:7b', digest: DIGEST}]})})});
    try {
        const {runProcess} = await import('../../froonty@catalin/features/writing/process.js');
        const facts = await gatherFacts({paths, session: newSession(5), url: ollama.url, systemctl,
            run: runProcess});
        const plan = ollamaRemovalPlan(await readState(paths), facts);
        eq(plan.map(i => i.id), ['service-stop', 'unit-file', 'daemon-reload', 'reset-failed', 'prefix',
            'state', 'keys']);
        eq(plan.find(i => i.id === 'prefix').yourModels, ['mistral:7b']);
        const report = await execute(plan, {paths, run: runProcess, session: newSession(5),
            url: ollama.url, settings: makeSettings()});
        eq(report.failed, []);
        eq(readFile(log), '--user stop froonty-ollama.service\n--user daemon-reload\n' +
            '--user reset-failed froonty-ollama.service\n');
        ok(!exists(paths.unitFile) && !exists(paths.ollamaPrefix));
    } finally {
        ollama.close();
    }

    // A unit file that is not Froonty's is kept, even if listed.
    writeFile(paths.unitFile, '[Service]\nExecStart=/usr/bin/yours\n');
    const kept = await execute([{id: 'unit-file', label: 'unit', path: paths.unitFile}],
        {paths, settings: makeSettings()});
    eq(kept.failed.length, 1);
    ok(exists(paths.unitFile));
    // A plan item for another folder is refused.
    const tampered = await execute([{id: 'prefix', label: 'x', path: '/home'}], {paths});
    eq(tampered.failed[0].reason, 'unexpected folder');
});

test('Remove everything: order, past failures, Claude Code\'s records, every writing-* key', async () => {
    const paths = fakePaths();
    GLib.mkdir_with_parents(paths.runtimeDir, 0o700);
    writeFile(`${paths.cacheDir}/x.part`, 'partial');
    writeFile(`${paths.dataDir}/setup.json`, '{}');
    const dir = tempDir();
    const claudeLog = `${dir}/claude.log`;
    const claude = writeScript(`${dir}/claude`,
        `echo "$@" >>"${claudeLog}"; [ -f "${dir}/records" ] && { echo "1 transcript"; exit 0; }; echo "No Claude Code project state found"; exit 1`);
    const {runProcess} = await import('../../froonty@catalin/features/writing/process.js');
    const settings = makeSettings();
    const writingKeys = settings.settings_schema.list_keys().filter(k => k.startsWith('writing-'));
    for (const key of ['writing-enabled', 'writing-claude-code-enabled', 'writing-languagetool-enabled'])
        settings.set_boolean(key, true);
    settings.set_string('writing-ollama-model', 'gemma3:1b');
    settings.set_boolean('clipboard-enabled', true);
    settings.set_boolean('claude-enabled', false);

    GLib.file_set_contents(`${dir}/records`, '');
    const facts = await gatherFacts({paths, session: newSession(5), url: 'http://127.0.0.1:1',
        systemctl: '/fake/systemctl', run: runProcess, claudeBin: claude, writingKeys});
    const plan = everythingRemovalPlan(emptyState(), facts);
    eq(plan.map(i => i.id), ['cache', 'claude-purge', 'runtime', 'data', 'keys']);
    // A failing step does not stop the rest.
    const report = await execute([{id: 'service-stop', label: 'stop', argv: ['/nonexistent/systemctl']},
        ...plan], {paths, run: runProcess, session: newSession(5), url: 'http://127.0.0.1:1', settings});
    eq(report.failed.map(f => f.item.id), ['service-stop']);
    eq(readFile(claudeLog).trim().split('\n'),
        [`project purge ${paths.runtimeDir} --dry-run`, `project purge ${paths.runtimeDir} --yes`]);
    ok(!exists(paths.cacheDir) && !exists(paths.runtimeDir) && !exists(paths.dataDir));
    for (const key of writingKeys)
        eq(settings.get_user_value(key), null, key);
    eq([settings.get_boolean('clipboard-enabled'), settings.get_boolean('claude-enabled')], [true, false],
        'other settings untouched');

    // No records: no purge.
    GLib.unlink(`${dir}/records`);
    const none = await gatherFacts({paths, session: newSession(5), url: 'http://127.0.0.1:1',
        systemctl: '/fake/systemctl', run: runProcess, claudeBin: claude, writingKeys});
    ok(!everythingRemovalPlan(emptyState(), none).some(i => i.id === 'claude-purge'));
});

test('deleteTree: never its root, nothing outside, no "..", never through a link', async () => {
    const root = tempDir();
    const outside = tempDir();
    writeFile(`${outside}/precious`, 'keep');
    writeFile(`${root}/inner/a`, 'a');
    Gio.File.new_for_path(`${root}/inner/link`).make_symbolic_link(outside, null);
    for (const path of [root, outside, `${root}/../x`, `${root}/inner/../..`, 'relative'])
        ok(!isInside(path, root), path);
    await rejectsWith(deleteTree(root, root).catch(e => {
        throw Object.assign(e, {code: 'refused'});
    }), 'refused');
    await rejectsWith(deleteTree(`${root}/../${GLib.path_get_basename(outside)}`, root).catch(e => {
        throw Object.assign(e, {code: 'refused'});
    }), 'refused');
    eq(await deleteTree(`${root}/inner`, root), true);
    ok(!exists(`${root}/inner`) && exists(`${outside}/precious`), 'the link went, not its target');
    eq(await deleteTree(`${root}/missing`, root), false);
});

await done();
