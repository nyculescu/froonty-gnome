// SPDX-License-Identifier: GPL-3.0-or-later
// The free FRED API key in the user's keyring (Secret Service), never in
// GSettings. Used by Settings and the Shell; asynchronous throughout.

import Secret from 'gi://Secret';

const SCHEMA = new Secret.Schema('org.gnome.shell.extensions.froonty.Markets',
    Secret.SchemaFlags.NONE, {service: Secret.SchemaAttributeType.STRING});
const ATTRIBUTES = {service: 'fred'};

const promise = (start, finish) => new Promise((resolve, reject) => {
    start((_source, result) => {
        try {
            resolve(finish(result));
        } catch (e) {
            reject(e);
        }
    });
});

/** The saved key, or null. */
export function lookupFredKey(cancellable = null) {
    return promise(cb => Secret.password_lookup(SCHEMA, ATTRIBUTES, cancellable, cb),
        Secret.password_lookup_finish);
}

export function storeFredKey(key, label, cancellable = null) {
    return promise(cb => Secret.password_store(SCHEMA, ATTRIBUTES, Secret.COLLECTION_DEFAULT,
        label, key, cancellable, cb), Secret.password_store_finish);
}

export function clearFredKey(cancellable = null) {
    return promise(cb => Secret.password_clear(SCHEMA, ATTRIBUTES, cancellable, cb),
        Secret.password_clear_finish);
}
