// SPDX-License-Identifier: GPL-3.0-or-later
// What went wrong with a Writing request (docs/features/writing.md): a
// short code the view and the tests branch on, the message shown, and an
// optional hint (what to do about it). Messages never contain the text.
//
// Codes: empty, too-long, password, offline, not-installed, not-signed-in,
// api-key, not-a-plan, too-old, limit, rate-limited, unavailable,
// not-running, needs-setup, timeout, cancelled, bad-output, failed.

export class WritingError extends Error {
    constructor(code, message = '', hint = '') {
        super(message || code);
        this.name = 'WritingError';
        this.code = code;
        this.hint = hint;
    }
}

/** {code, message, hint} of any error, for the view. */
export function describeError(e) {
    if (e instanceof WritingError)
        return {code: e.code, message: e.message, hint: e.hint};
    return {code: 'failed', message: String(e?.message ?? e), hint: ''};
}
