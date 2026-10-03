// SPDX-License-Identifier: GPL-3.0-or-later
// Where the Writing tab's files live, and the test guard on everything
// that could reach a real service (docs/features/writing.md §8).
// No St or Gtk: loads in the Shell, in the settings window and in plain
// gjs tests.

import GLib from 'gi://GLib';

export const UNIT_NAME = 'froonty-ollama.service';

// Where an Ollama of the user's own is installed system-wide (Ollama's
// install script and its manual steps use /usr/local or /usr), and its
// system service, if it has one.
export const SYSTEM_OLLAMA = ['/usr/local/bin/ollama', '/usr/bin/ollama', '/bin/ollama',
    '/snap/bin/ollama'];
export const SYSTEM_OLLAMA_UNITS = ['/etc/systemd/system/ollama.service',
    '/usr/lib/systemd/system/ollama.service', '/lib/systemd/system/ollama.service'];

const underTest = () => Boolean(GLib.getenv('FROONTY_UNIT_ISOLATED') ||
    GLib.getenv('FROONTY_HEADLESS_TEST'));

/**
 * The value of a test override (FROONTY_LANGUAGETOOL_URL,
 * FROONTY_OLLAMA_URL, FROONTY_OLLAMA_RELEASE_API, FROONTY_SYSTEMCTL,
 * FROONTY_CLAUDE_CODE), or null for the built-in default.
 *
 * Only the unit and headless tests (FROONTY_UNIT_ISOLATED,
 * FROONTY_HEADLESS_TEST) are ever pointed elsewhere: there a missing one
 * throws, so a test can never reach the real LanguageTool, Ollama, GitHub,
 * systemd or Claude Code. Anywhere else these variables are ignored, so a
 * stale one in the session's environment can never send text to another
 * host while the tab names LanguageTool or "this computer"
 * (docs/features/writing.md §8).
 *
 * @param {string} name
 * @returns {?string}
 */
export function override(name) {
    if (!underTest())
        return null;
    const value = GLib.getenv(name);
    if (value)
        return value;
    throw new Error(`${name} must be set in tests`);
}

/**
 * Froonty's own Writing folders and files. Tests pass their own (GLib
 * caches the XDG folders on first use).
 */
export function defaultPaths() {
    const dataDir = GLib.build_filenamev([GLib.get_user_data_dir(), 'froonty', 'writing']);
    const cacheDir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'froonty', 'writing']);
    return {
        dataDir,
        stateFile: GLib.build_filenamev([dataDir, 'setup.json']),
        ollamaPrefix: GLib.build_filenamev([dataDir, 'ollama']),
        cacheDir,
        // Next to the prefix, so moving it into place is a rename.
        stagingDir: GLib.build_filenamev([dataDir, 'ollama.new']),
        runtimeDir: GLib.build_filenamev([GLib.get_user_runtime_dir(), 'froonty-writing']),
        unitFile: GLib.build_filenamev([GLib.get_user_config_dir(), 'systemd', 'user', UNIT_NAME]),
        unitName: UNIT_NAME,
    };
}
