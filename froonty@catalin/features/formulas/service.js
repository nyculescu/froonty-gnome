// SPDX-License-Identifier: GPL-3.0-or-later
// Formulas tab (docs/features/formulas.md): owns the math renderer client
// while the tab exists, and the recent and starred lists in the settings.
// The helper process starts on the first preview and stops after a minute
// without one, or when the tab goes (stop(), from the hub, also on
// disable()). No St.

import {pushRecent, toggleFavourite} from './edit.js';
import {isMathJaxFetched, MathRenderClient} from './renderer/client.js';

export const RECENT_KEY = 'formulas-recent';
export const FAVOURITES_KEY = 'formulas-favorites';

export class FormulasService {
    /**
     * @param {Gio.Settings} settings
     * @param {object} [deps] for tests: `client` (a MathRenderClient),
     *   `isFetched` (→ Promise<boolean>)
     */
    constructor(settings, {client = null, isFetched = isMathJaxFetched} = {}) {
        this._settings = settings;
        this._client = client;
        this._isFetched = isFetched;
        this._fetched = false;
    }

    start() {
        this._client ??= new MathRenderClient();
    }

    stop() {
        this._client?.destroy();
        this._client = null;
    }

    /**
     * Whether MathJax is there (`make mathjax`); asked again until it is,
     * so a fetch and `make install` are noticed when the tab next shows.
     */
    async available() {
        this._fetched ||= await this._isFetched();
        return this._fetched;
    }

    /** See MathRenderClient.render(); rejects once stopped. */
    render(request, options) {
        if (!this._client)
            return Promise.reject(new Error('stopped'));
        return this._client.render(request, options);
    }

    get recent() {
        return this._settings.get_strv(RECENT_KEY);
    }

    get favourites() {
        return this._settings.get_strv(FAVOURITES_KEY);
    }

    addRecent(tex) {
        const list = this.recent;
        const next = pushRecent(list, tex);
        if (next !== list)
            this._settings.set_strv(RECENT_KEY, next);
    }

    toggleFavourite(tex) {
        const list = this.favourites;
        const next = toggleFavourite(list, tex);
        if (next !== list)
            this._settings.set_strv(FAVOURITES_KEY, next);
    }

    removeRecent(tex) {
        this._settings.set_strv(RECENT_KEY, this.recent.filter(item => item !== tex));
    }
}
