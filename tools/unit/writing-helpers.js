// SPDX-License-Identifier: GPL-3.0-or-later
// Shared fakes for the Writing tab's unit tests (writing-*.test.js): the
// real schema on an in-memory backend, private folders, a fake network
// monitor, fake scripts, and a local Soup.Server standing in for
// LanguageTool, Ollama and GitHub. Nothing here reaches a real service.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Soup from 'gi://Soup?version=3.0';

export const EXTENSION_DIR = GLib.build_filenamev([
    GLib.path_get_dirname(GLib.path_get_dirname(GLib.path_get_dirname(
        Gio.File.new_for_uri(import.meta.url).get_path()))),
    'froonty@catalin']);

export const sleep = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms,
    () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));

/** Froonty's real schema, with an in-memory backend: nothing touches dconf. */
export function makeSettings() {
    const source = Gio.SettingsSchemaSource.new_from_directory(
        GLib.build_filenamev([EXTENSION_DIR, 'schemas']), null, false);
    const settings = new Gio.Settings({
        settings_schema: source.lookup('org.gnome.shell.extensions.froonty', false),
        backend: Gio.memory_settings_backend_new(),
    });
    if (GObject.type_name(settings.backend.constructor.$gtype) !== 'GMemorySettingsBackend')
        throw new Error('test settings must be in memory');
    return settings;
}

export function tempDir(prefix = 'froonty-writing-XXXXXX') {
    return GLib.dir_make_tmp(prefix);
}

/** Writing paths under a private temporary root. */
export function fakePaths(root = tempDir()) {
    const dataDir = `${root}/data/froonty/writing`;
    const cacheDir = `${root}/cache/froonty/writing`;
    GLib.mkdir_with_parents(`${root}/runtime`, 0o700);
    return {
        root,
        dataDir,
        stateFile: `${dataDir}/setup.json`,
        ollamaPrefix: `${dataDir}/ollama`,
        cacheDir,
        stagingDir: `${dataDir}/ollama.new`,
        runtimeDir: `${root}/runtime/froonty-writing`,
        unitFile: `${root}/config/systemd/user/froonty-ollama.service`,
        unitName: 'froonty-ollama.service',
    };
}

export function writeFile(path, text, mode = 0o644) {
    GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o700);
    GLib.file_set_contents(path, text);
    GLib.chmod(path, mode);
}

export function readFile(path) {
    try {
        const [, bytes] = GLib.file_get_contents(path);
        return new TextDecoder().decode(bytes);
    } catch (e) {
        return null;
    }
}

export function fileMode(path) {
    const info = Gio.File.new_for_path(path).query_info('unix::mode',
        Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
    return info.get_attribute_uint32('unix::mode') & 0o7777;
}

export function exists(path) {
    return Gio.File.new_for_path(path).query_file_type(Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
        null) !== Gio.FileType.UNKNOWN;
}

/** A shell script at `path`, executable. */
export function writeScript(path, body) {
    writeFile(path, `#!/bin/sh\n${body}\n`, 0o755);
    return path;
}

/** Like Gio.NetworkMonitor: connectivity, with signal handlers. */
export class FakeNetwork {
    constructor(connectivity = Gio.NetworkConnectivity.FULL) {
        this.network_available = true;
        this.connectivity = connectivity;
        this.handlers = new Map();
        this._next = 1;
    }

    connect(signal, handler) {
        this.handlers.set(this._next, {signal, handler});
        return this._next++;
    }

    disconnect(id) {
        this.handlers.delete(id);
    }

    // Like GNetworkMonitorNM: NetworkManager's connectivity check arrives
    // as a property notification only.
    set(connectivity) {
        this.connectivity = connectivity;
        for (const {signal, handler} of [...this.handlers.values()]) {
            if (signal === 'notify::connectivity')
                handler(this);
        }
    }
}

/**
 * A local HTTP server. `routes` maps "METHOD /path" to a handler
 * (request) → {status, body, type} | 'hang' (never answers) |
 * {chunksThenHang: [text…]} (streams those, then nothing); unknown routes
 * answer 404. Every request is logged.
 */
export class FakeServer {
    constructor(routes = {}) {
        this.routes = routes;
        this.requests = [];
        this.held = [];
        this.server = new Soup.Server({});
        this.server.add_handler(null, (_server, message, path) => this._handle(message, path));
        this.server.listen_local(0, Soup.ServerListenOptions.IPV4_ONLY);
        this.url = this.server.get_uris()[0].to_string().replace(/\/$/, '');
    }

    _handle(message, path) {
        const method = message.get_method();
        const bytes = message.get_request_body().flatten().get_data() ?? new Uint8Array();
        const body = new TextDecoder().decode(bytes);
        const request = {method, path, body, headers: message.get_request_headers()};
        this.requests.push(request);
        const handler = this.routes[`${method} ${path}`];
        const answer = handler ? handler(request) : {status: 404, body: '{"error":"not found"}'};
        if (answer === 'hang') {
            message.pause();
            this.held.push(message);
            return;
        }
        // Some chunks of a streamed answer, then nothing more (a stream
        // that stalls, or a model still writing).
        if (answer?.chunksThenHang) {
            message.set_status(200, null);
            message.get_response_headers().set_encoding(Soup.Encoding.CHUNKED);
            message.get_response_headers().set_content_type(answer.type ?? 'application/x-ndjson', null);
            for (const chunk of answer.chunksThenHang)
                message.get_response_body().append_bytes(new GLib.Bytes(new TextEncoder().encode(chunk)));
            this.held.push(message);
            return;
        }
        message.set_status(answer.status ?? 200, null);
        const data = answer.bytes ?? new TextEncoder().encode(answer.body ?? '');
        message.set_response(answer.type ?? 'application/json', Soup.MemoryUse.COPY, data);
    }

    close() {
        for (const message of this.held) {
            if (message.get_status() === 200) {
                message.get_response_body().complete();
            } else {
                message.set_status(503, null);
                message.unpause();
            }
        }
        this.held = [];
        this.server.disconnect();
    }
}

/** Expects `promise` to reject with a WritingError of `code`. */
export async function rejectsWith(promise, code) {
    try {
        await promise;
    } catch (e) {
        if (e.code === code)
            return e;
        throw new Error(`expected ${code}, got ${e.code}: ${e.message}`);
    }
    throw new Error(`expected ${code}, but it resolved`);
}
