// SPDX-License-Identifier: GPL-3.0-or-later
// Settings → Writing → Ollama → "Set up…" (docs/features/writing.md §5.2):
// Ollama's official Linux archive, installed for this user only, with no
// administrator password:
//
//   1. preflight: a supported processor, tar and zstd, no Ollama already
//   2. the latest release from GitHub's API; its SHA-256 must match
//      Ollama's own sha256sum.txt
//   3. (the settings window asks, showing all of this)
//   4. download to ~/.cache/froonty/writing/<asset>.part, hashing as it goes
//   5. list the archive: only bin/ollama and lib/ollama/…, no links out
//   6. extract into a staging folder, check it again, move it into place
//   7. a user service, froonty-ollama.service, with no [Install] section
//   8. start it and wait until it answers
//
// setup.json records each step before it runs, so Remove can undo a set-up
// that did not finish. Dependencies are passed in, so the tests run it
// against a fake release server, fake systemctl and tiny archives. No Gtk.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {WritingError} from '../errors.js';
import {networkFailure, newSession, parseJson, request, sleep} from '../http.js';
import {defaultPaths, override, SYSTEM_OLLAMA, UNIT_NAME} from '../paths.js';
import {runProcess} from '../process.js';
import {deleteFile, deleteTree, ensurePrivateDir, exists, fileType, readText,
    writeAtomic} from './fs.js';
import {readState, writeState} from './state.js';

Gio._promisify(Gio.File.prototype, 'replace_async');
Gio._promisify(Gio.File.prototype, 'query_filesystem_info_async');
Gio._promisify(Gio.File.prototype, 'move_async', 'move_finish');
Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.File.prototype, 'query_info_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'close_async');
Gio._promisify(Gio.OutputStream.prototype, 'write_bytes_async');
Gio._promisify(Gio.OutputStream.prototype, 'close_async');
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async');
Gio._promisify(Gio.InputStream.prototype, 'close_async');

export const RELEASE_API = 'https://api.github.com/repos/ollama/ollama/releases/latest';
export const DOWNLOAD_PREFIX = 'https://github.com/ollama/ollama/releases/download/';
export const MAX_ARCHIVE = 4000000000;
export const UNIT_MARKER = '# Created by Froonty (Settings → Writing → Ollama); Froonty\'s Remove deletes it.';
const TAR = '/usr/bin/tar';
const ZSTD = '/usr/bin/zstd';
const CHUNK = 1024 * 1024;
const PROGRESS_EVERY_US = 250 * 1000;
const START_WAIT_MS = 15 * 1000;

const ARCHES = {x86_64: 'amd64', aarch64: 'arm64'};

/** Ollama's name for the processor: amd64, arm64, or null (unsupported). */
export function ollamaArch(machine) {
    return ARCHES[String(machine ?? '').trim()] ?? null;
}

export function releaseApi() {
    return override('FROONTY_OLLAMA_RELEASE_API') ?? RELEASE_API;
}

/**
 * Where downloads may come from: GitHub's release downloads, or (tests)
 * the origin of the overridden release API.
 */
export function downloadPrefix(api = releaseApi()) {
    if (api === RELEASE_API)
        return DOWNLOAD_PREFIX;
    const match = /^(https?:\/\/[^/]+\/)/.exec(api);
    return match ? match[1] : DOWNLOAD_PREFIX;
}

/** The user service's text. No [Install]: it never starts at login. */
export function unitText(prefix) {
    return [
        UNIT_MARKER,
        '[Unit]',
        'Description=Ollama for Froonty\'s Writing tab',
        '[Service]',
        `ExecStart=${prefix}/bin/ollama serve`,
        `Environment=HOME=${prefix}/home`,
        `Environment=OLLAMA_MODELS=${prefix}/models`,
        'Environment=OLLAMA_HOST=127.0.0.1:11434',
        'Environment=OLLAMA_NO_CLOUD=1',
        'Restart=on-failure',
        'RestartSec=3',
        '',
    ].join('\n');
}

/** Whether the unit file's text is Froonty's (its first line). */
export function hasMarker(text) {
    return typeof text === 'string' && text.split('\n')[0] === UNIT_MARKER;
}

/**
 * The release's asset for `arch`, checked: an exact name, a GitHub
 * download address, a size under 4 GB and a SHA-256 digest.
 *
 * @returns {{version, asset, url, size, sha256, sumsUrl}}
 */
export function pickAsset(release, arch, prefix = DOWNLOAD_PREFIX) {
    const name = `ollama-linux-${arch}.tar.zst`;
    const assets = Array.isArray(release?.assets) ? release.assets : [];
    const asset = assets.find(a => a?.name === name);
    const sums = assets.find(a => a?.name === 'sha256sum.txt');
    if (!asset || !sums)
        throw new WritingError('failed', `The latest Ollama release has no ${name}.`);
    for (const url of [asset.browser_download_url, sums.browser_download_url]) {
        if (typeof url !== 'string' || !url.startsWith(prefix))
            throw new WritingError('failed', `Unexpected download address: ${url}`);
    }
    if (!Number.isInteger(asset.size) || asset.size <= 0 || asset.size > MAX_ARCHIVE)
        throw new WritingError('failed', `Unexpected size of ${name}: ${asset.size}`);
    const digest = /^sha256:([0-9a-f]{64})$/.exec(String(asset.digest ?? ''));
    if (!digest)
        throw new WritingError('failed', `GitHub lists no SHA-256 for ${name}.`);
    const version = String(release.tag_name ?? '');
    if (!/^v?\d+\.\d+\.\d+[\w.-]*$/.test(version))
        throw new WritingError('failed', `Unexpected release name: ${version}`);
    return {
        version,
        asset: name,
        url: asset.browser_download_url,
        size: asset.size,
        sha256: digest[1],
        sumsUrl: sums.browser_download_url,
    };
}

/** Whether Ollama's sha256sum.txt lists `sha256` for `asset`. */
export function sumsMatch(text, asset, sha256) {
    for (const line of String(text ?? '').split('\n')) {
        const match = /^([0-9a-f]{64}) [ *]?(?:\.\/)?(\S+)$/.exec(line.trim());
        if (match && match[2] === asset)
            return match[1] === sha256;
    }
    return false;
}

const ENTRY = /^([-dl])[rwxsStT-]{9} \S+ +(\d+) \d{4}-\d{2}-\d{2} \d{2}:\d{2} (\S+?)( -> (\S+))?$/;
const NAME_CHARS = /^[A-Za-z0-9._+/-]*$/;

function normalName(name) {
    return name.replace(/^\.\//, '').replace(/^\.$/, '');
}

/** Whether `name` (no leading ./) may be in Ollama's archive. */
export function allowedName(name, type) {
    if (!NAME_CHARS.test(name) || name.startsWith('/') ||
        name.split('/').some(s => s === '..' || s === '.'))
        return false;
    const bare = name.replace(/\/$/, '');
    if (type === 'd')
        return ['', 'bin', 'lib', 'lib/ollama'].includes(bare) || bare.startsWith('lib/ollama/');
    if (bare === 'bin/ollama')
        return type === '-';
    return bare.startsWith('lib/ollama/');
}

/** Whether a link at `name` pointing to `target` stays inside lib/ollama/. */
export function linkInside(name, target) {
    if (!target || target.startsWith('/') || !NAME_CHARS.test(target))
        return false;
    const parts = name.replace(/\/$/, '').split('/').slice(0, -1);
    for (const part of target.split('/')) {
        if (part === '..')
            parts.pop();
        else if (part && part !== '.')
            parts.push(part);
    }
    const resolved = parts.join('/');
    return resolved.startsWith('lib/ollama/') && !resolved.split('/').includes('..');
}

/**
 * Checks `tar -tv` output line by line.
 *
 * @returns {{size: number, entries: number}}
 * @throws {WritingError} on anything unexpected
 */
export function checkListing(text) {
    let size = 0;
    let entries = 0;
    let binary = false;
    for (const line of text.split('\n')) {
        if (!line.trim())
            continue;
        const match = ENTRY.exec(line);
        if (!match)
            throw new WritingError('failed', `Unexpected entry in Ollama's archive: ${line.slice(0, 120)}`);
        const [, type, bytes, rawName, , target] = match;
        const name = normalName(rawName);
        if (!allowedName(name, type) || (type === 'l') !== Boolean(target) ||
            (type === 'l' && !linkInside(name, target)))
            throw new WritingError('failed', `Unexpected entry in Ollama's archive: ${rawName}`);
        if (name === 'bin/ollama')
            binary = true;
        size += Number(bytes);
        entries++;
    }
    if (!binary)
        throw new WritingError('failed', 'Ollama\'s archive has no bin/ollama.');
    return {size, entries};
}

async function readMachine() {
    const text = await readText('/proc/sys/kernel/arch');
    return text?.trim() ?? GLib.getenv('HOSTTYPE') ?? '';
}

async function freeBytes(path) {
    let file = Gio.File.new_for_path(path);
    while (file && !await exists(file.get_path()))
        file = file.get_parent();
    if (!file)
        return Infinity;
    const info = await file.query_filesystem_info_async('filesystem::free',
        GLib.PRIORITY_DEFAULT, null);
    return Number(info.get_attribute_uint64('filesystem::free'));
}

/** Default dependencies; tests replace any of them. */
export function defaultDeps() {
    return {
        paths: defaultPaths(),
        run: runProcess,
        session: null,
        url: null,
        api: null,
        systemctl: null,
        machine: readMachine,
        tar: TAR,
        zstd: ZSTD,
        systemBinaries: SYSTEM_OLLAMA,
        freeBytes,
        startWaitMs: START_WAIT_MS,
    };
}

function resolve(deps) {
    const all = {...defaultDeps(), ...deps};
    all.url ??= override('FROONTY_OLLAMA_URL') ?? 'http://127.0.0.1:11434';
    all.api ??= releaseApi();
    all.systemctl ??= override('FROONTY_SYSTEMCTL') ?? '/usr/bin/systemctl';
    all.session ??= newSession(30);
    return all;
}

async function answers(session, url) {
    try {
        const answer = await request(session, 'GET', `${url}/api/version`);
        return answer.status === 200;
    } catch (e) {
        return false;
    }
}

/**
 * Checks this computer, then asks GitHub for the latest release.
 *
 * @returns {Promise<object>} the plan the confirmation shows
 * @throws {WritingError} with the reason it cannot be set up
 */
export async function prepare(deps = {}) {
    const d = resolve(deps);
    const arch = ollamaArch(await d.machine());
    if (!arch)
        throw new WritingError('failed', 'Ollama\'s archive is for x86-64 and ARM64 processors only.');
    for (const tool of [d.tar, d.zstd]) {
        if (await fileType(tool) === null)
            throw new WritingError('failed', `${tool} is missing. Install it with: sudo apt install ${GLib.path_get_basename(tool)}`);
    }
    if (await answers(d.session, d.url))
        throw new WritingError('failed', 'Ollama is already running; Froonty uses it.');
    for (const path of d.systemBinaries) {
        if (await fileType(path) !== null)
            throw new WritingError('failed', `Ollama is already installed (${path}); Froonty uses it.`);
    }
    if (!/^[A-Za-z0-9._/-]+$/.test(d.paths.ollamaPrefix))
        throw new WritingError('failed', `Froonty cannot install into ${d.paths.ollamaPrefix}.`);

    let release;
    try {
        const answer = await request(d.session, 'GET', d.api);
        if (answer.status !== 200)
            throw new Error(`GitHub answered ${answer.status}`);
        release = parseJson(answer.body);
    } catch (e) {
        throw new WritingError('offline', `Cannot ask GitHub for Ollama's latest release: ${e.message}`);
    }
    const picked = pickAsset(release, arch, downloadPrefix(d.api));
    const sums = await request(d.session, 'GET', picked.sumsUrl, {maxBytes: 64 * 1024});
    if (sums.status !== 200 || !sumsMatch(sums.body, picked.asset, picked.sha256)) {
        throw new WritingError('failed',
            'GitHub\'s SHA-256 for Ollama\'s archive does not match Ollama\'s sha256sum.txt; nothing was downloaded.');
    }
    return {
        ...picked,
        arch,
        prefix: d.paths.ollamaPrefix,
        part: GLib.build_filenamev([d.paths.cacheDir, `${picked.asset}.part`]),
        staging: d.paths.stagingDir,
        unitFile: d.paths.unitFile,
        unitText: unitText(d.paths.ollamaPrefix),
        commands: [
            [d.systemctl, '--user', 'daemon-reload'],
            [d.systemctl, '--user', 'start', UNIT_NAME],
        ],
    };
}

async function recordStep(paths, plan, step) {
    const state = await readState(paths);
    state.ollama = {
        installedByFroonty: true,
        prefix: paths.ollamaPrefix,
        unit: UNIT_NAME,
        release: plan.version,
        asset: plan.asset,
        sha256: plan.sha256,
        step,
        models: state.ollama?.models ?? [],
    };
    await writeState(paths, state);
}

/**
 * Downloads `url` to `partPath` (0600), hashing as it goes.
 *
 * @throws {WritingError} 'cancelled', or 'failed' on a wrong size or hash;
 *   the .part file is deleted either way
 */
export async function download({session, url, partPath, size, sha256, cancellable = null,
    onProgress = () => {}}) {
    const part = Gio.File.new_for_path(partPath);
    const checksum = new GLib.Checksum(GLib.ChecksumType.SHA256);
    let received = 0;
    let lastReport = 0;
    let output = null;
    try {
        const message = Soup.Message.new('GET', url);
        if (!message)
            throw new WritingError('failed', `Not a valid address: ${url}`);
        const input = await session.send_async(message, GLib.PRIORITY_DEFAULT, cancellable);
        if (message.status_code !== 200)
            throw new WritingError('failed', `The download answered ${message.status_code}.`);
        output = await part.replace_async(null, false,
            Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION,
            GLib.PRIORITY_DEFAULT, cancellable);
        try {
            for (;;) {
                // eslint-disable-next-line no-await-in-loop
                const bytes = await input.read_bytes_async(CHUNK, GLib.PRIORITY_DEFAULT, cancellable);
                const length = bytes.get_size();
                if (!length)
                    break;
                received += length;
                if (received > size)
                    throw new WritingError('failed', 'The download is larger than GitHub said.');
                checksum.update(bytes.toArray());
                // eslint-disable-next-line no-await-in-loop
                await output.write_bytes_async(bytes, GLib.PRIORITY_DEFAULT, cancellable);
                const now = GLib.get_monotonic_time();
                if (now - lastReport >= PROGRESS_EVERY_US) {
                    lastReport = now;
                    onProgress(received, size);
                }
            }
        } finally {
            input.close_async(GLib.PRIORITY_DEFAULT, null).catch(() => {});
        }
        await output.close_async(GLib.PRIORITY_DEFAULT, null);
        output = null;
        onProgress(received, size);
        if (received !== size)
            throw new WritingError('failed', `The download stopped at ${received} of ${size} bytes.`);
        if (checksum.get_string() !== sha256)
            throw new WritingError('failed', 'The download\'s SHA-256 does not match; it was deleted.');
    } catch (e) {
        if (output)
            await output.close_async(GLib.PRIORITY_DEFAULT, null).catch(() => {});
        await deleteFile(partPath).catch(() => {});
        if (e instanceof WritingError)
            throw e;
        if (networkFailure(e) === 'cancelled')
            throw new WritingError('cancelled', 'Cancelled.');
        throw new WritingError('failed', `The download failed: ${e.message}`);
    }
}

const TAR_ENV = {unset: [], set: {LC_ALL: 'C'}};

/** `tar -tv` of the archive, checked (checkListing). */
export async function listArchive({run, tar, part, cancellable = null}) {
    const result = await run({argv: [tar, '--zstd', '-tvf', part], ...TAR_ENV, cancellable,
        timeoutMs: 120000, label: 'tar (Writing)'});
    if (!result.exitOk)
        throw new WritingError('failed', `Cannot read Ollama's archive: ${result.stderr.trim().slice(0, 200)}`);
    return checkListing(result.stdout);
}

/** Walks an extracted tree (no links followed) with the archive's rules. */
export async function checkTree(root, relative = '') {
    const dir = Gio.File.new_for_path(relative ? GLib.build_filenamev([root, relative]) : root);
    const enumerator = await dir.enumerate_children_async(
        'standard::name,standard::type,standard::symlink-target',
        Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, GLib.PRIORITY_DEFAULT, null);
    try {
        for (;;) {
            // eslint-disable-next-line no-await-in-loop
            const infos = await enumerator.next_files_async(64, GLib.PRIORITY_DEFAULT, null);
            if (!infos.length)
                break;
            for (const info of infos) {
                const name = relative ? `${relative}/${info.get_name()}` : info.get_name();
                const kind = info.get_file_type();
                const type = kind === Gio.FileType.DIRECTORY ? 'd'
                    : kind === Gio.FileType.SYMBOLIC_LINK ? 'l'
                        : kind === Gio.FileType.REGULAR ? '-' : '?';
                const target = type === 'l' ? info.get_symlink_target() : null;
                if (!allowedName(name, type) || (type === 'l' && !linkInside(name, target)))
                    throw new WritingError('failed', `Unexpected file after extracting: ${name}`);
                if (type === 'd')
                    // eslint-disable-next-line no-await-in-loop
                    await checkTree(root, name);
            }
        }
    } finally {
        await enumerator.close_async(GLib.PRIORITY_DEFAULT, null).catch(() => {});
    }
}

/**
 * Extracts into an empty staging folder next to the prefix (one file
 * system, so the move into place is a rename), checks the result, and
 * moves it into place.
 */
export async function extract({run, tar, part, staging, prefix, root, cancellable = null}) {
    await deleteTree(staging, root);
    await ensurePrivateDir(staging);
    const result = await run({argv: [tar, '--zstd', '-xf', part, '-C', staging,
        '--no-same-owner', '--no-same-permissions', '--delay-directory-restore'], ...TAR_ENV,
    cancellable, timeoutMs: 600000, label: 'tar (Writing)'});
    try {
        if (!result.exitOk)
            throw new WritingError('failed', `Cannot unpack Ollama's archive: ${result.stderr.trim().slice(0, 200)}`);
        await checkTree(staging);
        if (await fileType(GLib.build_filenamev([staging, 'bin', 'ollama'])) !== Gio.FileType.REGULAR)
            throw new WritingError('failed', 'Ollama\'s archive has no bin/ollama.');
        await deleteTree(prefix, root);
        await Gio.File.new_for_path(staging).move_async(Gio.File.new_for_path(prefix),
            Gio.FileCopyFlags.NOFOLLOW_SYMLINKS, GLib.PRIORITY_DEFAULT, cancellable, null);
    } catch (e) {
        await deleteTree(staging, root).catch(() => {});
        throw e instanceof WritingError ? e : new WritingError('failed', e.message);
    }
}

/** Writes the unit, unless a file there is not Froonty's. */
export async function writeUnit(paths) {
    const current = await readText(paths.unitFile);
    if (current !== null && !hasMarker(current)) {
        throw new WritingError('failed',
            `${paths.unitFile} exists and is not Froonty's; it was left alone.`);
    }
    if (await fileType(paths.unitFile) === Gio.FileType.SYMBOLIC_LINK)
        throw new WritingError('failed', `${paths.unitFile} is a link; it was left alone.`);
    await writeAtomic(paths.unitFile, unitText(paths.ollamaPrefix), 0o644);
}

async function systemctl(d, args, cancellable) {
    const result = await d.run({argv: [d.systemctl, '--user', ...args], cancellable,
        timeoutMs: 30000, label: 'systemctl (Writing)'});
    if (!result.exitOk) {
        throw new WritingError('failed',
            `systemctl --user ${args.join(' ')} failed: ${result.stderr.trim().slice(0, 200)}`);
    }
}

/** Starts the user service and waits until Ollama answers. */
export async function startService(deps = {}, cancellable = null) {
    const d = resolve(deps);
    await systemctl(d, ['start', UNIT_NAME], cancellable);
    for (let waited = 0; waited <= d.startWaitMs; waited += 500) {
        // eslint-disable-next-line no-await-in-loop
        if (await answers(d.session, d.url))
            return;
        // eslint-disable-next-line no-await-in-loop
        await sleep(500, cancellable);
    }
    throw new WritingError('timeout', 'Ollama did not answer within 15 s of starting.');
}

export async function stopService(deps = {}, cancellable = null) {
    const d = resolve(deps);
    await systemctl(d, ['stop', UNIT_NAME], cancellable);
}

/**
 * Runs a prepared set-up (steps 4-8).
 *
 * @param {object} plan prepare()'s
 * @param {object} deps see defaultDeps()
 * @param {object} [options]
 * @param {?Gio.Cancellable} [options.cancellable]
 * @param {Function} [options.onProgress] (stage, done, total)
 */
export async function install(plan, deps = {}, {cancellable = null, onProgress = () => {}} = {}) {
    const d = resolve(deps);
    const {paths} = d;
    const root = GLib.path_get_dirname(paths.ollamaPrefix);
    for (const [path, need] of [[paths.cacheDir, plan.size], [paths.dataDir, plan.size * 2]]) {
        if (await d.freeBytes(path) < need * 1.5) {
            throw new WritingError('failed',
                `Not enough free space for Ollama: it needs about ${Math.ceil(plan.size * 3 / 1e9)} GB.`);
        }
    }
    await ensurePrivateDir(paths.dataDir);
    await ensurePrivateDir(paths.cacheDir);

    await recordStep(paths, plan, 'downloading');
    await download({session: d.session, url: plan.url, partPath: plan.part, size: plan.size,
        sha256: plan.sha256, cancellable,
        onProgress: (done, total) => onProgress('downloading', done, total)});

    await recordStep(paths, plan, 'verifying');
    onProgress('verifying', 0, 0);
    const listing = await listArchive({run: d.run, tar: d.tar, part: plan.part, cancellable})
        .catch(async e => {
            await deleteFile(plan.part).catch(() => {});
            throw e;
        });
    if (await d.freeBytes(paths.dataDir) < listing.size * 1.2) {
        await deleteFile(plan.part).catch(() => {});
        throw new WritingError('failed',
            `Not enough free space to unpack Ollama (${Math.ceil(listing.size / 1e9)} GB).`);
    }

    await recordStep(paths, plan, 'extracting');
    onProgress('extracting', 0, 0);
    try {
        await extract({run: d.run, tar: d.tar, part: plan.part, staging: paths.stagingDir,
            prefix: paths.ollamaPrefix, root, cancellable});
    } finally {
        await deleteFile(plan.part).catch(() => {});
    }

    await recordStep(paths, plan, 'unit');
    onProgress('unit', 0, 0);
    await writeUnit(paths);
    await systemctl(d, ['daemon-reload'], cancellable);

    await recordStep(paths, plan, 'starting');
    onProgress('starting', 0, 0);
    await startService(d, cancellable);
    await recordStep(paths, plan, 'done');
}
