// SPDX-License-Identifier: GPL-3.0-or-later
// Horizon's API keys in the user's keyring (Secret Service, GNOME Keyring),
// one per provider. Never in GSettings or config.json: Froonty reads the key
// only to hand it to Horizon while a refresh runs. Used by Settings and the
// Shell; asynchronous throughout.

import Secret from 'gi://Secret';

const SCHEMA = new Secret.Schema('org.gnome.shell.extensions.froonty.Horizon',
    Secret.SchemaFlags.NONE, {provider: Secret.SchemaAttributeType.STRING});

const promise = (start, finish) => new Promise((resolve, reject) => {
    start((_source, result) => {
        try {
            resolve(finish(result));
        } catch (e) {
            reject(e);
        }
    });
});

/** The key saved for `provider`, or null. */
export function lookupKey(provider, cancellable = null) {
    return promise(cb => Secret.password_lookup(SCHEMA, {provider}, cancellable, cb),
        Secret.password_lookup_finish);
}

export function storeKey(provider, key, label, cancellable = null) {
    return promise(cb => Secret.password_store(SCHEMA, {provider}, Secret.COLLECTION_DEFAULT,
        label, key, cancellable, cb), Secret.password_store_finish);
}

export function clearKey(provider, cancellable = null) {
    return promise(cb => Secret.password_clear(SCHEMA, {provider}, cancellable, cb),
        Secret.password_clear_finish);
}
