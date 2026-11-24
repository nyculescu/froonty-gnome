// SPDX-License-Identifier: GPL-3.0-or-later
// The Markets keys in the user's keyring (Secret Service), never in
// GSettings: the free FRED API key, and the Alpaca key ID and secret (as
// one JSON item). Used by Settings and the Shell; asynchronous throughout.

import Secret from 'gi://Secret';

const SCHEMA = new Secret.Schema('org.gnome.shell.extensions.froonty.Markets',
    Secret.SchemaFlags.NONE, {service: Secret.SchemaAttributeType.STRING});

const promise = (start, finish) => new Promise((resolve, reject) => {
    start((_source, result) => {
        try {
            resolve(finish(result));
        } catch (e) {
            reject(e);
        }
    });
});

const lookup = (service, cancellable) => promise(
    cb => Secret.password_lookup(SCHEMA, {service}, cancellable, cb), Secret.password_lookup_finish);

const store = (service, value, label, cancellable) => promise(
    cb => Secret.password_store(SCHEMA, {service}, Secret.COLLECTION_DEFAULT, label, value, cancellable, cb),
    Secret.password_store_finish);

const clear = (service, cancellable) => promise(
    cb => Secret.password_clear(SCHEMA, {service}, cancellable, cb), Secret.password_clear_finish);

/** The saved FRED key, or null. */
export function lookupFredKey(cancellable = null) {
    return lookup('fred', cancellable);
}

export function storeFredKey(key, label, cancellable = null) {
    return store('fred', key, label, cancellable);
}

export function clearFredKey(cancellable = null) {
    return clear('fred', cancellable);
}

/** The saved Alpaca keys as {key, secret}, or null (also for a damaged item). */
export async function lookupAlpacaKeys(cancellable = null) {
    const value = await lookup('alpaca', cancellable);
    try {
        const {key, secret} = JSON.parse(value ?? 'null') ?? {};
        return key && secret ? {key, secret} : null;
    } catch {
        return null;
    }
}

export function storeAlpacaKeys({key, secret}, label, cancellable = null) {
    return store('alpaca', JSON.stringify({key, secret}), label, cancellable);
}

export function clearAlpacaKeys(cancellable = null) {
    return clear('alpaca', cancellable);
}
