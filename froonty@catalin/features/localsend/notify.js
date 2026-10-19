// SPDX-License-Identifier: GPL-3.0-or-later
// The LocalSend tab's GNOME notifications (docs/features/localsend.md): an
// incoming transfer to accept or decline, files received, a text message.
// They show whether the island is open or not.
//
// GNOME Shell 50.1 (ui/messageTray.js): new Source({title, iconName}),
// Main.messageTray.add(source), new Notification({source, title, body,
// urgency, resident}), notification.addAction(label, callback),
// source.addNotification(notification); a source destroys itself with
// its last notification.

import Gio from 'gi://Gio';
import St from 'gi://St';

import {gettext as _, ngettext} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

import {formatSize} from './service.js';

const ICON = 'send-to-symbolic';

function openUri(uri) {
    try {
        Gio.AppInfo.launch_default_for_uri(uri, global.create_app_launch_context(0, -1));
    } catch (e) {
        console.warn(`Froonty: LocalSend: cannot open ${uri}: ${e.message}`);
    }
}

export const openPath = path => openUri(Gio.File.new_for_path(path).get_uri());

/** What an offer holds, in one line: "photo.heic (2.1 MB)" or "3 files (12 MB)". */
export function offerSummary(offer) {
    const total = offer.files.reduce((sum, f) => sum + (Number(f.size) || 0), 0);
    if (offer.files.length === 1)
        return `${offer.files[0].name} (${formatSize(total)})`;
    return ngettext('%d file (%s)', '%d files (%s)', offer.files.length)
        .format(offer.files.length, formatSize(total));
}

export class LocalSendNotifier {
    constructor() {
        this._source = null;
        this._offers = new Map();
        this._pins = new Map();
    }

    _ensureSource() {
        if (!this._source) {
            this._source = new MessageTray.Source({title: _('LocalSend'), iconName: ICON});
            this._source.connect('destroy', () => {
                this._source = null;
            });
            Main.messageTray.add(this._source);
        }
        return this._source;
    }

    _notify(params, actions = []) {
        const source = this._ensureSource();
        const notification = new MessageTray.Notification({source, ...params});
        for (const [label, callback] of actions)
            notification.addAction(label, callback);
        source.addNotification(notification);
        return notification;
    }

    /**
     * @param {object} offer
     * @param {object} answers {accept, decline}
     * @param {boolean} [trusts] whether Accept makes the device trusted
     */
    offer(offer, {accept, decline}, trusts = false) {
        const title = offer.message !== null
            ? _('%s sends a message').format(offer.sender)
            : _('%s wants to send you files').format(offer.sender);
        let body = offer.message !== null ? offer.message.slice(0, 300) : offerSummary(offer);
        if (trusts)
            body += `\n${_('Accepting trusts this device: later transfers from it are accepted automatically.')}`;
        const notification = this._notify({
            title,
            body,
            urgency: MessageTray.Urgency.CRITICAL,
            resident: true,
        }, [[_('Accept'), accept], [_('Decline'), decline]]);
        // Closing it is declining it.
        notification.connect('destroy', () => {
            if (this._offers.get(offer.id) === notification) {
                this._offers.delete(offer.id);
                decline();
            }
        });
        this._offers.set(offer.id, notification);
    }

    /** A device asks to connect: the PIN to enter there. */
    pin({ip, sender, pin}) {
        this.pinGone(ip);
        const shown = `${pin.slice(0, 3)} ${pin.slice(3)}`;
        const notification = this._notify({
            title: _('%s wants to connect').format(sender),
            body: _('Enter this PIN in LocalSend on %s: %s\nIt makes %s a trusted device. If you did not send anything, ignore it.')
                .format(sender, shown, sender),
            urgency: MessageTray.Urgency.CRITICAL,
            resident: true,
        });
        notification.connect('destroy', () => {
            if (this._pins.get(ip) === notification)
                this._pins.delete(ip);
        });
        this._pins.set(ip, notification);
    }

    pinGone(ip) {
        const notification = this._pins.get(ip);
        this._pins.delete(ip);
        notification?.destroy();
    }

    offerGone(id) {
        const notification = this._offers.get(id);
        this._offers.delete(id);
        notification?.destroy();
    }

    received(item, folder) {
        const count = item.paths.length;
        const title = ngettext('Received %d file from %s', 'Received %d files from %s', count)
            .format(count, item.sender);
        const body = item.paths.map(p => p.split('/').pop()).slice(0, 5).join(', ');
        const actions = [[_('Open folder'), () => openPath(folder)]];
        if (count === 1)
            actions.unshift([_('Open'), () => openPath(item.paths[0])]);
        this._notify({title, body}, actions);
    }

    interrupted(sender, reason, kept) {
        const title = reason === 'sender'
            ? _('%s cancelled the transfer').format(sender)
            : _('The transfer from %s stopped').format(sender);
        const body = kept
            ? ngettext('%d file was saved before it stopped.', '%d files were saved before it stopped.', kept)
                .format(kept)
            : _('Nothing was saved.');
        this._notify({title, body});
    }

    message(sender, text) {
        const actions = [[_('Copy'), () => St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text)]];
        if (/^https?:\/\/\S+$/i.test(text.trim()))
            actions.push([_('Open link'), () => openUri(text.trim())]);
        this._notify({title: _('Message from %s').format(sender), body: text.slice(0, 1000)}, actions);
    }

    destroy() {
        for (const id of [...this._offers.keys()])
            this.offerGone(id);
        for (const ip of [...this._pins.keys()])
            this.pinGone(ip);
        this._source?.destroy();
        this._source = null;
    }
}
