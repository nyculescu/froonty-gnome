// SPDX-License-Identifier: GPL-3.0-or-later
// Media tab: what music and video players report over MPRIS, with play,
// pause, skip and seek; music on the collapsed pill
// (docs/features/media.md). Design adapted from vorssaint-utils
// (GPL-3.0-or-later).

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {MediaPillAccessory} from './pill.js';
import {acquireMedia, releaseMedia} from './shared.js';
import {MediaView} from './view.js';

// The tab's hold on the shared Media service: only while the tab is on
// screen, when it also asks for the position and the cover.
class MediaHandle {
    constructor(ctx) {
        this._ctx = ctx;
        /** The MediaService while active, else null. */
        this.service = null;
    }

    start() {}

    stop() {
        this.setActive(false);
    }

    setActive(active) {
        if (active === Boolean(this.service))
            return;
        if (active) {
            this.service = acquireMedia(this._ctx);
            this.service.watchPosition(true);
            this.service.wantArt(true);
        } else {
            this.service.watchPosition(false);
            this.service.wantArt(false);
            this.service = null;
            releaseMedia();
        }
    }
}

export default {
    id: 'media',
    get title() {
        return _('Media');
    },
    icon: 'multimedia-player-symbolic',
    enabledKey: 'media-enabled',
    // Settings → Media → Size.
    hubSizeKeys: {width: 'media-width', height: 'media-height'},
    createService: ctx => new MediaHandle(ctx),
    createView: (ctx, handle) => new MediaView(ctx, handle),
    // ctx.memory.media (the chosen player) survives screen locks.
    keepsMemory: true,
    // Music on the collapsed pill (wings, a new song's notice).
    pillAccessoryKeys: ['media-enabled', 'media-show-in-pill', 'media-track-notice'],
    wantsPillAccessory: settings => settings.get_boolean('media-enabled') &&
        (settings.get_boolean('media-show-in-pill') || settings.get_boolean('media-track-notice')),
    createPillAccessory: (ctx, island) => new MediaPillAccessory(ctx, island),
};
