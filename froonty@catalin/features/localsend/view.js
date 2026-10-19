// SPDX-License-Identifier: GPL-3.0-or-later
// LocalSend tab (docs/features/localsend.md): whether this computer is
// visible to LocalSend, PINs to enter on a new device, transfers waiting
// to be accepted, the networks (each trusted or not), the devices seen
// (each with "Send files…"), devices added by IP address (over ZeroTier,
// say), and what was received lately, with the folder it goes to.

import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {offerSummary, openPath} from './notify.js';
import {chooseFiles, chooseFolder} from './run.js';
import {formatSize, trustedDevices} from './service.js';

function kindLabel(kind) {
    return {wifi: _('Wi-Fi'), zerotier: _('ZeroTier'), wired: _('Wired')}[kind];
}

function errorText(error) {
    switch (error?.reason) {
    case 'port-in-use':
        return _('Port %d is taken, probably by the LocalSend app on this computer. Quit it, or choose another port in Settings → LocalSend.').format(error.port);
    case 'certificate':
        return _('Could not make the encryption certificate: %s').format(error.message);
    case 'no-python':
        return _('Could not start the helper: /usr/bin/python3 is missing.');
    case 'network':
        return _('Could not open the network: %s').format(error.message);
    default:
        return _('The LocalSend helper stopped (%s).').format(error?.message || error?.reason || '?');
    }
}

function failureText(result) {
    switch (result.reason) {
    case 'declined':
        return _('%s declined.').format(result.to);
    case 'busy':
        return _('%s is busy with another transfer.').format(result.to);
    case 'pin':
        return _('%s asks for a PIN: turn “Require PIN” off in its LocalSend settings.').format(result.to);
    case 'unreachable':
        return _('Could not reach %s. Is LocalSend open on it?').format(result.to);
    case 'cancelled':
        return _('Sending cancelled.');
    case 'gone':
        return _('That device is not around any more.');
    default:
        return _('Sending to %s failed.').format(result.to);
    }
}

const percent = (done, total) => (total > 0 ? Math.min(100, Math.floor(done * 100 / total)) : 0);

export class LocalSendView {
    constructor(ctx, service) {
        this._settings = ctx.settings;
        this._service = service;
        this.actor = new St.BoxLayout({
            style_class: 'froonty-localsend',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
        });

        const header = new St.BoxLayout({style_class: 'froonty-localsend-header'});
        header.add_child(new St.Icon({icon_name: 'send-to-symbolic', icon_size: 18}));
        header.add_child(new St.Label({
            style_class: 'froonty-localsend-title',
            text: _('LocalSend'),
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this._visibleButton = this._button('', () =>
            this._settings.set_boolean('localsend-visible', !this._settings.get_boolean('localsend-visible')));
        header.add_child(this._visibleButton);
        this._scanButton = new St.Button({
            style_class: 'froonty-icon-button',
            accessible_name: _('Look for devices'),
            can_focus: true,
            child: new St.Icon({icon_name: 'view-refresh-symbolic'}),
        });
        this._scanButton.connect('clicked', () => this._service.scan());
        header.add_child(this._scanButton);
        this.actor.add_child(header);

        this._statusLabel = this._wrapping('froonty-localsend-status');
        this.actor.add_child(this._statusLabel);
        this._noticeList = this._vbox('froonty-localsend-notices');
        this.actor.add_child(this._noticeList);

        const list = this._vbox('froonty-localsend-list');
        this._scroll = new St.ScrollView({
            style_class: 'froonty-localsend-scroll',
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true,
        });
        this._scroll.add_child(list);
        this.actor.add_child(this._scroll);

        this._pinList = this._vbox('froonty-localsend-section');
        this._offerList = this._vbox('froonty-localsend-section');
        this._transferList = this._vbox('froonty-localsend-section');
        this._networkList = this._vbox('froonty-localsend-section');
        this._peerList = this._vbox('froonty-localsend-section');
        this._manualList = this._vbox('froonty-localsend-section');
        this._recentList = this._vbox('froonty-localsend-section');
        list.add_child(this._pinList);
        list.add_child(this._offerList);
        list.add_child(this._transferList);
        list.add_child(this._networkList);
        list.add_child(this._peerList);
        list.add_child(this._manualList);
        list.add_child(this._addRow());
        list.add_child(this._recentList);

        const sync = () => this._sync();
        this._settings.connectObject('changed::localsend-visible', sync,
            'changed::localsend-trusted', sync, 'changed::localsend-devices', sync, this);
        this._serviceId = this._service.connect('changed', () => this._sync());
        this._sync();
    }

    destroy() {
        this._service.disconnect(this._serviceId);
        this._settings.disconnectObject(this);
        this.actor.destroy();
    }

    _vbox(styleClass) {
        return new St.BoxLayout({style_class: styleClass, orientation: Clutter.Orientation.VERTICAL});
    }

    _wrapping(styleClass, text = '') {
        const label = new St.Label({style_class: styleClass, text, x_expand: true});
        label.clutter_text.line_wrap = true;
        label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        return label;
    }

    _button(text, action, styleClass = 'froonty-localsend-action') {
        const button = new St.Button({style_class: styleClass, can_focus: true, label: text,
            y_align: Clutter.ActorAlign.CENTER});
        button.connect('clicked', action);
        return button;
    }

    _heading(text) {
        return new St.Label({style_class: 'froonty-localsend-heading', text});
    }

    _addRow() {
        const row = new St.BoxLayout({style_class: 'froonty-localsend-add'});
        this._addEntry = new St.Entry({
            style_class: 'froonty-localsend-entry',
            hint_text: _('Add a device by IP address'),
            can_focus: true,
            x_expand: true,
        });
        const add = () => {
            const address = this._addEntry.text.trim();
            if (!address)
                return;
            // Kept until it is an address (10.40.196.27, say).
            if (this._service.addDevice(address))
                this._addEntry.text = '';
            else
                this._addEntry.clutter_text.set_selection(0, -1);
        };
        this._addEntry.clutter_text.connect('activate', add);
        row.add_child(this._addEntry);
        row.add_child(this._button(_('Add'), add));
        this._addRowActor = row;
        return row;
    }

    _status(state) {
        switch (state.status) {
        case 'hidden':
            return _('Hidden: other devices cannot see this computer or send to it.');
        case 'starting':
            return _('Starting…');
        case 'failed':
            return errorText(state.error);
        case 'ready': {
            const used = state.addresses.filter(a => a.used);
            if (!state.addresses.length)
                return _('Visible as “%s”, but not connected to a network.').format(state.alias);
            if (!used.length)
                return _('Not visible on any network: none is trusted. Trust one below, or use ZeroTier.');
            const where = used.map(a => `${kindLabel(a.kind)} ${a.address}`);
            return _('Visible as “%s” · %s').format(state.alias, where.join(' · '));
        }
        default:
            return _('Off');
        }
    }

    _sync() {
        const state = this._service.state;
        const visible = this._settings.get_boolean('localsend-visible');
        this._visibleButton.label = visible ? _('Hide') : _('Show');
        this._visibleButton.accessible_name = visible
            ? _('Stop being visible to LocalSend') : _('Be visible to LocalSend');
        const ready = state.status === 'ready';
        this._scanButton.reactive = ready;
        this._statusLabel.text = this._status(state);
        this._statusLabel.style_class = state.status === 'failed'
            ? 'froonty-localsend-error' : 'froonty-localsend-status';

        this._noticeList.remove_all_children();
        for (const warning of state.warnings)
            this._noticeList.add_child(this._wrapping('froonty-localsend-notice', warning));
        if (state.sendResult) {
            const row = new St.BoxLayout({style_class: 'froonty-localsend-result'});
            const text = state.sendResult.ok
                ? _('Sent to %s.').format(state.sendResult.to) : failureText(state.sendResult);
            row.add_child(this._wrapping(state.sendResult.ok
                ? 'froonty-localsend-ok' : 'froonty-localsend-error', text));
            row.add_child(this._button(_('OK'), () => this._service.dismissResult()));
            this._noticeList.add_child(row);
        }
        this._noticeList.visible = this._noticeList.get_n_children() > 0;

        this._syncPins(state);
        this._syncOffers(state);
        this._syncTransfers(state);
        this._syncNetworks(state, ready);
        this._syncManual(state, ready);
        this._syncPeers(state, ready);
        this._addRowActor.visible = ready;
        this._syncRecent(state);
    }

    _syncPins(state) {
        this._pinList.remove_all_children();
        for (const pin of state.pins) {
            const box = this._vbox('froonty-localsend-offer');
            box.add_child(this._wrapping('froonty-localsend-offer-title',
                _('%s wants to connect').format(pin.sender)));
            box.add_child(new St.Label({style_class: 'froonty-localsend-pin',
                text: `${pin.pin.slice(0, 3)} ${pin.pin.slice(3)}`}));
            box.add_child(this._wrapping('froonty-localsend-meta',
                _('Enter this PIN in LocalSend on %s; it then becomes a trusted device. Did not send anything? Ignore it.')
                    .format(pin.sender)));
            this._pinList.add_child(box);
        }
        this._pinList.visible = state.pins.length > 0;
    }

    _syncNetworks(state, ready) {
        this._networkList.remove_all_children();
        this._networkList.visible = ready && state.addresses.length > 0;
        if (!this._networkList.visible)
            return;
        this._networkList.add_child(this._heading(_('Networks')));
        for (const net of state.addresses) {
            const row = new St.BoxLayout({style_class: 'froonty-localsend-peer'});
            row.add_child(new St.Icon({
                icon_name: {wifi: 'network-wireless-symbolic', zerotier: 'network-vpn-symbolic'}[net.kind] ??
                    'network-wired-symbolic',
                icon_size: 16,
                y_align: Clutter.ActorAlign.CENTER,
            }));
            const text = this._vbox('froonty-localsend-peer-text');
            text.x_expand = true;
            text.add_child(new St.Label({style_class: 'froonty-localsend-peer-name',
                text: [kindLabel(net.kind), net.kind === 'zerotier' ? '' : net.name].filter(Boolean).join(' · ')}));
            let note;
            if (net.kind === 'zerotier')
                note = _('encrypted, members only: trusted');
            else if (net.trusted)
                note = _('trusted');
            else if (net.used)
                note = _('not trusted: every transfer asks');
            else
                note = _('not trusted: hidden here');
            text.add_child(new St.Label({style_class: 'froonty-localsend-meta', text: `${net.address} · ${note}`}));
            row.add_child(text);
            if (net.kind !== 'zerotier' && net.uuid) {
                row.add_child(net.trusted
                    ? this._button(_('Untrust'), () => this._service.untrustNetwork(net.uuid))
                    : this._button(_('Trust'), () => this._service.trustNetwork(net.uuid, net.name || net.interface)));
            }
            this._networkList.add_child(row);
        }
    }

    _syncManual(state, ready) {
        this._manualList.remove_all_children();
        const devices = this._settings.get_strv('localsend-devices');
        this._manualList.visible = ready && devices.length > 0;
        if (!this._manualList.visible)
            return;
        this._manualList.add_child(this._heading(_('Added by address')));
        for (const address of devices) {
            const peer = state.peers.find(p => p.ip === address);
            const row = new St.BoxLayout({style_class: 'froonty-localsend-peer'});
            const text = this._vbox('froonty-localsend-peer-text');
            text.x_expand = true;
            text.add_child(new St.Label({style_class: 'froonty-localsend-peer-name', text: address}));
            text.add_child(new St.Label({style_class: 'froonty-localsend-meta', text: peer
                ? _('%s · this computer shows up there').format(peer.alias)
                : _('waiting for LocalSend to be open there')}));
            row.add_child(text);
            row.add_child(this._button(_('Forget'), () => this._service.forgetDevice(address)));
            this._manualList.add_child(row);
        }
    }

    _syncOffers(state) {
        this._offerList.remove_all_children();
        for (const offer of state.offers) {
            const box = this._vbox('froonty-localsend-offer');
            box.add_child(this._wrapping('froonty-localsend-offer-title', offer.message !== null
                ? _('%s sends a message').format(offer.sender)
                : _('%s wants to send %s').format(offer.sender, offerSummary(offer))));
            if (offer.message !== null)
                box.add_child(this._wrapping('froonty-localsend-meta', offer.message.slice(0, 300)));
            const buttons = new St.BoxLayout({style_class: 'froonty-localsend-buttons'});
            buttons.add_child(this._button(_('Accept'), () => this._service.accept(offer.id),
                'froonty-localsend-action froonty-localsend-accept'));
            buttons.add_child(this._button(_('Decline'), () => this._service.decline(offer.id)));
            box.add_child(buttons);
            this._offerList.add_child(box);
        }
        this._offerList.visible = state.offers.length > 0;
    }

    _syncTransfers(state) {
        this._transferList.remove_all_children();
        if (state.receiving) {
            const r = state.receiving;
            this._transferList.add_child(this._wrapping('froonty-localsend-progress',
                _('Receiving from %s · %d%% of %s').format(r.sender, percent(r.received, r.total),
                    formatSize(r.total))));
        }
        if (state.sending) {
            const s = state.sending;
            const row = new St.BoxLayout({style_class: 'froonty-localsend-buttons'});
            row.add_child(this._wrapping('froonty-localsend-progress', s.waiting
                ? _('Waiting for %s to accept…').format(s.to)
                : _('Sending to %s · %d%% of %s').format(s.to, percent(s.sent, s.total), formatSize(s.total))));
            row.add_child(this._button(_('Cancel'), () => this._service.cancelSend()));
            this._transferList.add_child(row);
        }
        this._transferList.visible = this._transferList.get_n_children() > 0;
    }

    _syncPeers(state, ready) {
        this._peerList.remove_all_children();
        this._peerList.visible = ready;
        if (!ready)
            return;
        this._peerList.add_child(this._heading(_('Devices')));
        if (!state.peers.length) {
            this._peerList.add_child(this._wrapping('froonty-localsend-meta',
                _('None seen yet. Open LocalSend on your phone (on the same Wi-Fi); it shows up here, and this computer shows up there.')));
            return;
        }
        const trusted = trustedDevices(this._settings);
        for (const peer of state.peers) {
            const row = new St.BoxLayout({style_class: 'froonty-localsend-peer'});
            row.add_child(new St.Icon({
                icon_name: peer.deviceType === 'mobile' ? 'phone-symbolic' : 'computer-symbolic',
                icon_size: 16,
                y_align: Clutter.ActorAlign.CENTER,
            }));
            const text = this._vbox('froonty-localsend-peer-text');
            text.x_expand = true;
            text.add_child(new St.Label({style_class: 'froonty-localsend-peer-name', text: peer.alias}));
            text.add_child(new St.Label({style_class: 'froonty-localsend-meta',
                text: [peer.deviceModel, peer.ip, peer.fingerprint in trusted ? _('trusted') : '']
                    .filter(Boolean).join(' · ')}));
            row.add_child(text);
            const send = this._button(_('Send files…'), async () => {
                const paths = await chooseFiles().catch(e => {
                    console.warn(`Froonty: LocalSend file chooser: ${e.message}`);
                    return [];
                });
                if (paths.length)
                    this._service.sendTo(peer.fingerprint, paths);
            });
            send.reactive = !state.sending;
            row.add_child(send);
            this._peerList.add_child(row);
        }
    }

    _syncRecent(state) {
        this._recentList.remove_all_children();
        if (!state.recent.length && !state.folder) {
            this._recentList.visible = false;
            return;
        }
        this._recentList.visible = true;
        const head = new St.BoxLayout({style_class: 'froonty-localsend-buttons'});
        head.add_child(this._heading(_('Received')));
        head.add_child(new St.Widget({x_expand: true}));
        if (state.folder) {
            head.add_child(this._button(_('Open folder'), () => openPath(state.folder)));
            const change = this._button(_('Change…'), async () => {
                const path = await chooseFolder(state.folder).catch(e => {
                    console.warn(`Froonty: LocalSend folder chooser: ${e.message}`);
                    return null;
                });
                if (path)
                    this._service.setFolder(path);
            });
            change.accessible_name = _('Change where received files are saved');
            head.add_child(change);
        }
        this._recentList.add_child(head);
        if (!state.recent.length) {
            this._recentList.add_child(this._wrapping('froonty-localsend-meta',
                _('Nothing yet. Files go to %s.').format(state.folder)));
            return;
        }
        this._recentList.add_child(this._wrapping('froonty-localsend-meta',
            _('Saved in %s').format(state.folder)));
        for (const item of state.recent) {
            for (const path of item.paths.slice(0, 5)) {
                const button = new St.Button({
                    style_class: 'froonty-localsend-file',
                    can_focus: true,
                    x_expand: true,
                    child: new St.Label({
                        text: `${path.split('/').pop()} · ${item.sender}`,
                        x_align: Clutter.ActorAlign.START,
                    }),
                });
                button.connect('clicked', () => openPath(path));
                this._recentList.add_child(button);
            }
            if (item.paths.length > 5) {
                this._recentList.add_child(new St.Label({style_class: 'froonty-localsend-meta',
                    text: _('and %d more from %s').format(item.paths.length - 5, item.sender)}));
            }
        }
    }
}
