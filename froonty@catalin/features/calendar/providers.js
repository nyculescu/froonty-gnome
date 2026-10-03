// SPDX-License-Identifier: GPL-3.0-or-later
// Which web calendar an EDS calendar comes from, and the page that opens
// one of its days there (docs/features/calendar.md §B.5). Pure.
//
// Detected from what EDS knows of the calendar (eds.js info()): the
// backend of the account that made it (GNOME Online Accounts: google,
// microsoft365, ews, outlook, webdav) and the host of its CalDAV or ICS
// address. Hosts match exactly or as a '.'-suffix, never as a substring,
// so "evilgoogle.com" or "google.com.evil.org" is not Google.
//
// The web addresses are the providers' own day views as of 2026; none of
// them is a documented API, so they may change (see the doc's risks).

const LABELS = {
    google: 'Google',
    microsoft: 'Outlook',
    icloud: 'iCloud',
    nextcloud: 'Nextcloud',
    yahoo: 'Yahoo',
};

// Microsoft's consumer mail domains: their calendar is outlook.live.com,
// work and school accounts use outlook.office.com.
const CONSUMER_DOMAIN = /@(outlook|hotmail|live|msn|passport)\.[a-z.]+$/i;
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;
const PATH_PREFIX = /^[A-Za-z0-9._~%/-]*$/;
const EMAIL = /^[^\s@/?#&]+@[^\s@/?#&]+\.[^\s@/?#&]+$/;

/** host is `domain` or one of its subdomains. */
export function hostIs(host, domain) {
    if (typeof host !== 'string' || !host)
        return false;
    const h = host.toLowerCase().replace(/\.$/, '');
    return h === domain || h.endsWith(`.${domain}`);
}

const isInt = n => Number.isInteger(n);
const validDay = (y, m, d) => isInt(y) && isInt(m) && isInt(d) &&
    y >= 1 && y <= 9999 && m >= 1 && m <= 12 && d >= 1 && d <= 31;

/** The account's address, if one of the known fields holds one. */
function emailOf(info) {
    return [info.webdavEmail, info.authUser, info.collectionIdentity]
        .find(value => typeof value === 'string' && EMAIL.test(value)) ?? null;
}

function google(info) {
    const account = emailOf(info);
    const query = account ? `?authuser=${encodeURIComponent(account)}` : '';
    return {
        kind: 'google',
        account,
        homeUrl: `https://calendar.google.com/calendar/r${query}`,
        dayUrl: (y, m, d) => `https://calendar.google.com/calendar/r/day/${y}/${m}/${d}${query}`,
    };
}

function microsoft(info) {
    const account = emailOf(info);
    const consumer = info.collectionBackend === 'outlook' ||
        hostIs(info.webdav?.host, 'outlook.live.com') ||
        (account !== null && CONSUMER_DOMAIN.test(account));
    const base = consumer
        ? 'https://outlook.live.com/calendar/0'
        : 'https://outlook.office.com/calendar';
    return {
        kind: 'microsoft',
        account,
        homeUrl: `${base}/`,
        dayUrl: (y, m, d) => `${base}/view/day/${y}/${m}/${d}`,
    };
}

// "https://cloud.example.org/nc/remote.php/dav/calendars/…" → its web
// app at "https://cloud.example.org/nc/apps/calendar/".
function nextcloud(info) {
    const {scheme, host, port, path} = info.webdav;
    const prefix = path.slice(0, path.indexOf('/remote.php/'));
    if (!['http', 'https'].includes(scheme) || !HOST.test(host ?? '') || !PATH_PREFIX.test(prefix))
        return null;
    const defaultPort = scheme === 'https' ? 443 : 80;
    const portPart = isInt(port) && port > 0 && port <= 65535 && port !== defaultPort ? `:${port}` : '';
    return {
        kind: 'nextcloud',
        account: emailOf(info) ?? info.authUser ?? null,
        homeUrl: `${scheme}://${host.toLowerCase()}${portPart}${prefix}/apps/calendar/`,
        dayUrl: null,
    };
}

function detectKind(info) {
    const host = info.webdav?.host ?? info.authHost ?? null;
    const path = info.webdav?.path ?? '';
    const collection = info.collectionBackend ?? null;

    if (collection === 'google' || hostIs(host, 'apidata.googleusercontent.com') ||
        hostIs(host, 'calendar.google.com') ||
        (hostIs(host, 'www.google.com') && path.startsWith('/calendar/dav')))
        return 'google';
    if (['microsoft365', 'ews', 'outlook'].includes(collection) ||
        ['microsoft365', 'ews'].includes(info.backend) ||
        ['outlook.office365.com', 'outlook.office.com', 'outlook.live.com'].some(d => hostIs(host, d)))
        return 'microsoft';
    if (hostIs(host, 'icloud.com'))
        return 'icloud';
    if (hostIs(host, 'caldav.calendar.yahoo.com'))
        return 'yahoo';
    if (info.webdav && path.includes('/remote.php/dav/') && collection === 'webdav')
        return 'nextcloud';
    return ['local', 'contacts', 'weather', 'birthdays'].includes(info.backend) ? 'local' : 'other';
}

/**
 * @param {object} info a calendar's details (eds.js EdsAdapter.info)
 * @returns {{kind: string, label: ?string, account: ?string,
 *   homeUrl: ?string, dayUrl: ?Function}} kind is google, microsoft,
 *   icloud, nextcloud, yahoo, local or other; dayUrl(y, m, d) returns
 *   the day's page, or null for anything but integer dates
 */
export function detectProvider(info) {
    const kind = detectKind(info ?? {});
    let found = null;
    if (kind === 'google')
        found = google(info);
    else if (kind === 'microsoft')
        found = microsoft(info);
    else if (kind === 'icloud')
        found = {kind, account: emailOf(info), homeUrl: 'https://www.icloud.com/calendar/', dayUrl: null};
    else if (kind === 'yahoo')
        found = {kind, account: emailOf(info), homeUrl: 'https://calendar.yahoo.com/', dayUrl: null};
    else if (kind === 'nextcloud')
        found = nextcloud(info);

    if (!found)
        return {kind: kind === 'nextcloud' ? 'other' : kind, label: null, account: null, homeUrl: null, dayUrl: null};
    const dayUrl = found.dayUrl;
    return {
        ...found,
        label: LABELS[found.kind],
        dayUrl: dayUrl ? (y, m, d) => validDay(y, m, d) ? dayUrl(y, m, d) : null : null,
    };
}

/** The page to open for a day: its day view, or the calendar's home. */
export function urlForDay(provider, date) {
    return provider?.dayUrl?.(date?.y, date?.m, date?.d) ?? provider?.homeUrl ?? null;
}
