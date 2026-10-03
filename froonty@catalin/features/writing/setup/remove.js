// SPDX-License-Identifier: GPL-3.0-or-later
// Remove and "Remove everything" (docs/features/writing.md §5.4, §5.5): undo
// exactly what Froonty's Writing set-up did, and nothing more.
//
// - Ollama Remove: Froonty's own Ollama (its service, unit file and
//   folder, with the models inside), or, with an Ollama of the user's, only
//   the models Froonty downloaded that are still unchanged; leftovers of an
//   unfinished set-up; the record of it.
// - Remove everything: that, Claude Code's records of Froonty's working
//   folder, Froonty's Writing folders, and every writing-* setting.
//
// The plans are pure (unit-tested); execute() runs one, item after item,
// going on past a failure, and reports what was done. No Gtk.

import GLib from 'gi://GLib';

import {WritingError} from '../errors.js';
import {deleteFile, deleteTree, exists, readText} from './fs.js';
import {deleteModel, listModels} from './ollamaModels.js';
import {hasMarker} from './ollamaInstall.js';
import {readState, writeState} from './state.js';

export const OLLAMA_KEYS = ['writing-ollama-enabled', 'writing-ollama-model'];

const digestOf = d => String(d ?? '').replace(/^sha256:/, '');

/**
 * What Ollama Remove does, in order.
 *
 * @param {object} state setup.json, validated
 * @param {object} facts {running, models: [{name, digest}] | null,
 *   unitHasMarker, prefixExists, stagingExists, cacheExists, paths, systemctl}
 * @returns {object[]} items: {id, label, …}
 */
export function ollamaRemovalPlan(state, facts) {
    const {paths, systemctl} = facts;
    const ollama = state.ollama;
    const items = [];
    const ownOllama = Boolean(ollama?.installedByFroonty) || facts.unitHasMarker ||
        facts.prefixExists;
    if (ownOllama) {
        const recorded = new Set((ollama?.models ?? []).map(m => m.name));
        const yours = (facts.models ?? []).filter(m => !recorded.has(m.name)).map(m => m.name);
        if (facts.unitHasMarker) {
            items.push({id: 'service-stop', label: 'Stop Froonty\'s Ollama (froonty-ollama.service)',
                argv: [systemctl, '--user', 'stop', paths.unitName]});
            items.push({id: 'unit-file', label: `Delete ${paths.unitFile}`, path: paths.unitFile});
            items.push({id: 'daemon-reload', label: 'Reload your user services (systemctl --user daemon-reload)',
                argv: [systemctl, '--user', 'daemon-reload']});
            items.push({id: 'reset-failed', label: 'Forget the service\'s failures (systemctl --user reset-failed)',
                argv: [systemctl, '--user', 'reset-failed', paths.unitName]});
        }
        if (facts.prefixExists) {
            items.push({
                id: 'prefix',
                label: `Delete Froonty's Ollama and its models (${paths.ollamaPrefix})`,
                path: paths.ollamaPrefix,
                yourModels: yours,
            });
        }
    } else {
        for (const model of ollama?.models ?? []) {
            const now = (facts.models ?? []).find(m => m.name === model.name);
            if (model.step !== 'done' || !model.digest) {
                items.push({id: 'model-unfinished', label: `Forget the unfinished download of ${model.name}`,
                    name: model.name});
            } else if (facts.models === null) {
                items.push({id: 'model', label: `Delete the model ${model.name}`, name: model.name,
                    digest: model.digest});
            } else if (now && digestOf(now.digest) === digestOf(model.digest)) {
                items.push({id: 'model', label: `Delete the model ${model.name}`, name: model.name,
                    digest: model.digest});
            } else if (now) {
                items.push({id: 'model-changed', label: `Keep ${model.name}: it changed since Froonty downloaded it`,
                    name: model.name});
            }
        }
    }
    if (facts.stagingExists) {
        items.push({id: 'staging', label: `Delete an unfinished unpacking (${paths.stagingDir})`,
            path: paths.stagingDir});
    }
    if (facts.cacheExists) {
        items.push({id: 'cache', label: `Delete Froonty's Writing downloads (${paths.cacheDir})`,
            path: paths.cacheDir});
    }
    if (ollama)
        items.push({id: 'state', label: 'Forget what Froonty set up for Ollama'});
    items.push({id: 'keys', label: 'Turn Ollama off in the Writing tab', keys: OLLAMA_KEYS});
    return items;
}

/**
 * What "Remove everything" does: Ollama Remove, then Claude Code's
 * records of the working folder, Froonty's Writing folders, and every
 * writing-* setting.
 *
 * @param {object} facts as ollamaRemovalPlan's, plus claude: {bin,
 *   hasRecords}, runtimeExists, dataExists, writingKeys
 */
export function everythingRemovalPlan(state, facts) {
    const {paths} = facts;
    const items = ollamaRemovalPlan(state, facts).filter(i => i.id !== 'keys');
    if (facts.claude?.bin && facts.claude.hasRecords) {
        items.push({id: 'claude-purge',
            label: `Delete Claude Code's records of ${paths.runtimeDir} (claude project purge)`,
            argv: [facts.claude.bin, 'project', 'purge', paths.runtimeDir, '--yes']});
    }
    if (facts.runtimeExists)
        items.push({id: 'runtime', label: `Delete ${paths.runtimeDir}`, path: paths.runtimeDir});
    if (facts.dataExists)
        items.push({id: 'data', label: `Delete ${paths.dataDir}`, path: paths.dataDir});
    items.push({id: 'keys', label: 'Reset every Writing setting (the tab turns off)',
        keys: facts.writingKeys ?? []});
    return items;
}

/** What stays, for the confirmation and the report. */
export const NOT_REMOVED = [
    'Claude Code and its sign-in',
    'LanguageTool: there is nothing to remove',
    'An Ollama you installed yourself, and the models you downloaded yourself',
    'The Writing code: it is part of this Froonty build and stays off',
    'froonty-ollama lines in your user journal (journalctl --user -u froonty-ollama), which age out with the journal',
];

/**
 * The facts a plan needs, read now.
 *
 * @param {object} deps {paths, session, url, systemctl, run, claudeBin}
 */
export async function gatherFacts({paths, session, url, systemctl, run, claudeBin = null,
    writingKeys = []}) {
    const models = await listModels({session, url});
    const unitText = await readText(paths.unitFile);
    const facts = {
        paths,
        systemctl,
        running: models !== null,
        models,
        unitHasMarker: hasMarker(unitText),
        prefixExists: await exists(paths.ollamaPrefix),
        stagingExists: await exists(paths.stagingDir),
        cacheExists: await exists(paths.cacheDir),
        runtimeExists: await exists(paths.runtimeDir),
        dataExists: await exists(paths.dataDir),
        writingKeys,
        claude: {bin: claudeBin, hasRecords: false},
    };
    if (claudeBin) {
        try {
            const result = await run({argv: [claudeBin, 'project', 'purge', paths.runtimeDir,
                '--dry-run'], timeoutMs: 15000, label: 'Claude Code (Writing)'});
            // Exit 0 lists records; exit 1: "No Claude Code project state found".
            facts.claude.hasRecords = result.exitOk;
            facts.claude.dryRun = result.stdout.trim().slice(0, 2000);
        } catch (e) {
            facts.claude.hasRecords = false;
        }
    }
    return facts;
}

async function runChecked(run, argv) {
    const result = await run({argv, timeoutMs: 30000, label: 'Writing removal'});
    if (!result.exitOk)
        throw new Error(result.stderr.trim().slice(0, 200) || `${argv[0]} failed`);
}

/**
 * Runs a plan's items in order, going on past a failure.
 *
 * @param {object[]} plan
 * @param {object} deps {paths, run, session, url, settings}
 * @returns {Promise<{done: object[], failed: {item, reason}[]}>}
 */
export async function execute(plan, {paths, run, session, url, settings}) {
    const done = [];
    const failed = [];
    const failedModels = new Set();
    const home = GLib.get_home_dir();
    for (const item of plan) {
        try {
            switch (item.id) {
            case 'service-stop':
            case 'daemon-reload':
                // eslint-disable-next-line no-await-in-loop
                await runChecked(run, item.argv);
                break;
            case 'reset-failed':
                // Nothing failed: fine too.
                // eslint-disable-next-line no-await-in-loop
                await run({argv: item.argv, timeoutMs: 30000, label: 'Writing removal'});
                break;
            case 'unit-file': {
                // eslint-disable-next-line no-await-in-loop
                const text = await readText(item.path);
                if (text !== null && !hasMarker(text))
                    throw new Error('it is not Froonty\'s; left alone');
                // eslint-disable-next-line no-await-in-loop
                await deleteFile(item.path);
                break;
            }
            case 'prefix':
            case 'staging':
                if (item.path !== (item.id === 'prefix' ? paths.ollamaPrefix : paths.stagingDir))
                    throw new Error('unexpected folder');
                // eslint-disable-next-line no-await-in-loop
                await deleteTree(item.path, paths.dataDir);
                break;
            case 'cache':
            case 'runtime':
            case 'data': {
                const expected = {cache: paths.cacheDir, runtime: paths.runtimeDir,
                    data: paths.dataDir}[item.id];
                if (item.path !== expected || expected === home)
                    throw new Error('unexpected folder');
                if (item.id === 'data' && failedModels.size)
                    throw new Error('kept: it records the models still to remove');
                // eslint-disable-next-line no-await-in-loop
                await deleteTree(item.path, GLib.path_get_dirname(item.path));
                break;
            }
            case 'model':
                try {
                    // eslint-disable-next-line no-await-in-loop
                    await deleteModel({session, url, name: item.name});
                } catch (e) {
                    failedModels.add(item.name);
                    throw e;
                }
                break;
            case 'model-unfinished':
            case 'model-changed':
                break;
            case 'claude-purge':
                // eslint-disable-next-line no-await-in-loop
                await runChecked(run, item.argv);
                break;
            case 'state': {
                // eslint-disable-next-line no-await-in-loop
                const state = await readState(paths);
                if (state.ollama) {
                    const left = state.ollama.models.filter(m => failedModels.has(m.name));
                    state.ollama = left.length
                        ? {...state.ollama, installedByFroonty: false, prefix: null, unit: null,
                            release: null, asset: null, sha256: null, step: 'done', models: left}
                        : null;
                    // eslint-disable-next-line no-await-in-loop
                    await writeState(paths, state);
                }
                break;
            }
            case 'keys':
                for (const key of item.keys)
                    settings.reset(key);
                break;
            default:
                throw new WritingError('failed', `Unknown step ${item.id}`);
            }
            done.push(item);
        } catch (e) {
            failed.push({item, reason: e.message});
        }
    }
    return {done, failed};
}
