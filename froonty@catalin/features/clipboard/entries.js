// SPDX-License-Identifier: GPL-3.0-or-later
// Clipboard history logic (docs/features/clipboard.md): what a copy is,
// whether to keep it, and the history list itself. Pure functions, no GI,
// so they load in plain gjs tests.

// Password managers mark a secret copy with one of these formats
// (KDE's hint, used by KeePassXC and others; the macOS convention some
// cross-platform apps also set on Linux). Such a copy is a password: it is
// never saved, only shown hidden for a while (recorder.js).
export const SECRET_HINTS = ['x-kde-passwordManagerHint', 'org.nspasteboard.ConcealedType'];

// Files (GNOME Files, and most GTK file managers): "copy" or "cut", then
// one file:// URI per line.
export const COPIED_FILES = 'x-special/gnome-copied-files';
const URI_LIST = 'text/uri-list';
const TEXT_TYPES = ['text/plain;charset=utf-8', 'text/plain', 'UTF8_STRING', 'STRING', 'TEXT'];

// Larger copies are not kept: the history lives on disk and in memory.
export const MAX_TEXT_LENGTH = 1024 * 1024;
export const MAX_IMAGE_BYTES = 16 * 1024 * 1024;

// Formats a copy of formatted text offers next to its plain text (web
// pages, office suites, Qt apps). Their plain text alone pastes without
// formatting ("Paste as plain text").
const FORMATTED = [/^text\/html\b/, /^text\/rtf$/, /^application\/rtf$/, /^text\/richtext$/,
    /^application\/x-qt-richtext$/, /^application\/vnd\.oasis\.opendocument\./,
    /^application\/x-openoffice/];

/** Whether a copy carries formatting besides its plain text. */
export function isFormatted(mimetypes) {
    return mimetypes.some(type => FORMATTED.some(pattern => pattern.test(type)));
}

/**
 * Whether the app that copied is one whose copies are never kept: its
 * app id, window class or sandboxed app id contains one of `ignored`
 * (case-insensitive), e.g. "keepass" for org.keepassxc.KeePassXC.
 *
 * @param {string[]} names what the focused window says it is
 * @param {string[]} ignored the clipboard-ignored-apps setting
 */
export function isIgnoredApp(names, ignored) {
    const patterns = ignored.map(p => p.trim().toLowerCase()).filter(Boolean);
    return names.filter(Boolean).some(name =>
        patterns.some(pattern => name.toLowerCase().includes(pattern)));
}

/**
 * What to do with a copy, from the formats it offers and the app that made
 * it. A password manager's copy is a password (or, without text, not kept
 * at all). Text wins over an image (office suites offer both for the same
 * selection); files win over both.
 *
 * @param {string[]} mimetypes
 * @param {object} [from]
 * @param {string[]} [from.names] the focused window's app id and classes
 * @param {string[]} [from.ignored] the clipboard-ignored-apps setting
 * @returns {{action: 'skip', reason: string} | {action: 'password', reason: string}
 *   | {action: 'files', mime: string} | {action: 'text'} | {action: 'image', mime: string}}
 */
export function classify(mimetypes, {names = [], ignored = []} = {}) {
    if (!mimetypes?.length)
        return {action: 'skip', reason: 'empty'};
    const hasText = mimetypes.some(type => TEXT_TYPES.includes(type));
    for (const [secret, reason] of [
        [mimetypes.some(type => SECRET_HINTS.includes(type)), 'secret'],
        [isIgnoredApp(names, ignored), 'ignored-app'],
    ]) {
        if (secret)
            return hasText ? {action: 'password', reason} : {action: 'skip', reason};
    }
    if (mimetypes.includes(COPIED_FILES))
        return {action: 'files', mime: COPIED_FILES};
    if (mimetypes.includes(URI_LIST) && !mimetypes.some(type => TEXT_TYPES.includes(type)))
        return {action: 'files', mime: URI_LIST};
    if (mimetypes.some(type => TEXT_TYPES.includes(type)))
        return {action: 'text'};
    const image = mimetypes.includes('image/png') ? 'image/png'
        : mimetypes.find(type => type.startsWith('image/') && type !== 'image/svg+xml');
    if (image)
        return {action: 'image', mime: image};
    return {action: 'skip', reason: 'unsupported'};
}

/**
 * Whether copied text looks like a password: browsers' own password
 * managers (Firefox, Chrome) do not mark their copies, so the text itself
 * is judged. One word of 8-64 characters mixing at least three of lower
 * case, upper case, digits and symbols, and not something else that
 * often looks like that: a link, an address, a path, a number or date,
 * a hexadecimal hash or id, a dotted name (org.gnome.Shell), a code
 * identifier (camelCase, snake_case, CONSTANT_CASE) or a call. API keys and tokens count as passwords, as they should.
 */
export function looksLikePassword(text) {
    const word = text.replace(/\r?\n$/, '');
    if (word.length < 8 || word.length > 64 || /\s/.test(word))
        return false;
    const elsewhere = [
        /^[a-z][a-z0-9+.-]*:\/\//i, // a link
        /^www\./i,
        /^[^@]+@[^@]+\.[a-z]{2,}$/i, // an e-mail address
        /^[~.]?\//, // a path
        /^[\w.~-]+(\/[\w.~-]+)+\/?$/, // a relative path
        /^[\d.,:+/()-]+$/, // a number, phone number, date or time
        /^[0-9a-f-]+$/i, // a hash or UUID
        /^[a-z_][\w-]*(\.[a-z_][\w-]*)+$/i, // a dotted name
        /^[A-Za-z][a-z]+([A-Z][a-z]+)+\d*$/, // camelCase, PascalCase
        /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/, // snake_case
        /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/, // CONSTANT_CASE
        /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/, // a date and time
        /^[A-Za-z_$][\w$.]*\(.*\)/, // a call: code
    ];
    if (elsewhere.some(pattern => pattern.test(word)))
        return false;
    const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z\d]/].filter(c => c.test(word)).length;
    return classes >= 3;
}

/**
 * Files from x-special/gnome-copied-files or text/uri-list text.
 *
 * @returns {?{operation: 'copy'|'cut', uris: string[]}} null if none
 */
export function parseFiles(text, mime = COPIED_FILES) {
    const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    let operation = 'copy';
    if (mime === COPIED_FILES) {
        const first = lines.shift();
        if (first !== 'copy' && first !== 'cut')
            return null;
        operation = first;
    }
    const uris = lines.filter(line => !line.startsWith('#') && /^[a-z][a-z0-9+.-]*:/i.test(line));
    return uris.length ? {operation, uris} : null;
}

/** The x-special/gnome-copied-files text that puts `entry`'s files back. */
export function copiedFilesText(entry) {
    return [entry.operation === 'cut' ? 'cut' : 'copy', ...entry.uris].join('\n');
}

/**
 * Adds `entry` on top. A copy of something already in the history (same
 * hash) moves that entry to the top instead, keeping its id and files.
 * Past `limit`, the oldest entries are dropped.
 *
 * @returns {{entries: object[], top: object, dropped: object[]}}
 */
export function addEntry(entries, entry, limit) {
    const existing = entries.find(e => e.hash === entry.hash);
    const top = existing ? {...existing, time: entry.time} : entry;
    const rest = entries.filter(e => e.hash !== entry.hash);
    const all = [top, ...rest];
    return {entries: all.slice(0, limit), top, dropped: all.slice(limit)};
}

/** Drops past `limit`. @returns {{entries: object[], dropped: object[]}} */
export function trim(entries, limit) {
    return {entries: entries.slice(0, limit), dropped: entries.slice(limit)};
}

/**
 * Entries read back from disk: only well-formed ones, so a damaged or
 * hand-edited file never breaks the tab.
 */
export function validEntries(data) {
    if (!Array.isArray(data?.entries))
        return [];
    return data.entries.filter(e =>
        e && typeof e.id === 'string' && /^[a-z0-9-]+$/.test(e.id) &&
        typeof e.hash === 'string' && typeof e.time === 'number' && (
            (e.kind === 'text' && typeof e.text === 'string') ||
            (e.kind === 'image' && typeof e.mime === 'string' && typeof e.file === 'string' &&
                /^[a-z0-9-]+\.[a-z0-9]+$/.test(e.file)) ||
            (e.kind === 'files' && Array.isArray(e.uris) && e.uris.every(u => typeof u === 'string') &&
                (e.operation === 'copy' || e.operation === 'cut'))));
}

/** A file name extension for an image type ("image/png" -> "png"). */
export function imageExtension(mime) {
    const sub = mime.split('/')[1]?.split(/[;+]/)[0].toLowerCase() ?? '';
    return /^[a-z0-9]{1,8}$/.test(sub) ? sub : 'img';
}

/** Up to `lines` lines of `text`, each up to `width` characters. */
export function excerpt(text, lines, width) {
    const all = text.replace(/\t/g, '    ').split(/\r?\n/);
    // Leading blank lines would show an empty preview.
    const from = all.slice(Math.max(0, all.findIndex(line => line.trim())));
    const shown = from.slice(0, lines).map(line =>
        line.length > width ? `${line.slice(0, width - 1)}…` : line);
    return from.length > lines ? `${shown.join('\n')}\n…` : shown.join('\n');
}

/** A file URI's name ("file:///home/a/My%20Doc.pdf" -> "My Doc.pdf"). */
export function uriName(uri) {
    const path = uri.replace(/^[a-z]+:\/\/[^/]*/i, '').replace(/\/+$/, '');
    const name = path.split('/').pop() || uri;
    try {
        return decodeURIComponent(name);
    } catch (e) {
        return name;
    }
}

/** A file URI as a path for display, or the URI itself when not local. */
export function uriPath(uri) {
    if (!uri.startsWith('file://'))
        return uri;
    const path = uri.replace(/^file:\/\/[^/]*/, '');
    try {
        return decodeURIComponent(path);
    } catch (e) {
        return path;
    }
}
