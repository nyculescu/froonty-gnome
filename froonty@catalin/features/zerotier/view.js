// SPDX-License-Identifier: GPL-3.0-or-later
// ZeroTier tab: tells at a glance whether ZeroTier runs, is set up, and how
// each joined network is doing. Networks are joined and left in ZeroTier's
// own tools; the tab only starts and stops the service.

import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {zeroTierIcon} from './icon.js';
import {networkProblem, notices} from './service.js';

function noticeText(notice) {
    switch (notice) {
    case 'not-installed':
        return _('ZeroTier is not installed.');
    case 'stopped':
        return _('ZeroTier is stopped, so its networks are offline.');
    case 'no-autostart':
        return _('ZeroTier does not start with the computer. Turn that on in ZeroTier’s own setup.');
    case 'no-access':
        return _('Froonty cannot read ZeroTier’s status yet. Allow it on the ZeroTier page of Froonty’s settings.');
    case 'offline':
        return _('ZeroTier cannot reach its network. Check the internet connection, or a firewall blocking UDP port 9993.');
    case 'no-networks':
        return _('No networks joined. Join one in ZeroTier.');
    default:
        return '';
    }
}

function problemText(problem, network) {
    switch (problem) {
    case 'not-authorized':
        return _('Not authorized yet: approve this device in the network’s controller');
    case 'not-found':
        return _('Network not found: check its ID in ZeroTier');
    case 'waiting':
        return _('Waiting for the network’s configuration');
    case 'port-error':
        return _('ZeroTier could not open the network interface');
    case 'too-old':
        return _('ZeroTier is too old for this network');
    case 'sign-in':
        return _('Sign-in required in ZeroTier');
    case 'no-address':
        return _('Connected, but the controller assigned no IP address');
    default:
        return network.status;
    }
}

export class ZeroTierView {
    constructor(service) {
        this._service = service;
        this.actor = new St.BoxLayout({
            style_class: 'froonty-zerotier',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
        });

        const header = new St.BoxLayout({style_class: 'froonty-zerotier-header'});
        header.add_child(new St.Icon({gicon: zeroTierIcon(), icon_size: 18}));
        header.add_child(new St.Label({
            style_class: 'froonty-zerotier-title',
            text: _('ZeroTier'),
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this._startButton = this._actionButton('media-playback-start-symbolic', _('Start'),
            () => this._service.startNode());
        this._stopButton = this._actionButton('media-playback-stop-symbolic', _('Stop'),
            () => this._service.stopNode());
        header.add_child(this._startButton);
        header.add_child(this._stopButton);
        this._refreshButton = new St.Button({
            style_class: 'froonty-icon-button',
            accessible_name: _('Refresh ZeroTier status'),
            can_focus: true,
            child: new St.Icon({icon_name: 'view-refresh-symbolic'}),
        });
        this._refreshButton.connect('clicked', () => this._service.refresh());
        header.add_child(this._refreshButton);
        this.actor.add_child(header);

        this._summaryLabel = new St.Label({style_class: 'froonty-zerotier-status'});
        this.actor.add_child(this._summaryLabel);

        this._noticeList = new St.BoxLayout({
            style_class: 'froonty-zerotier-notices',
            orientation: Clutter.Orientation.VERTICAL,
        });
        this.actor.add_child(this._noticeList);

        this._networkList = new St.BoxLayout({
            style_class: 'froonty-zerotier-network-list',
            orientation: Clutter.Orientation.VERTICAL,
        });
        this._networkScroll = new St.ScrollView({
            style_class: 'froonty-zerotier-network-scroll',
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true,
        });
        this._networkScroll.add_child(this._networkList);
        this.actor.add_child(this._networkScroll);

        this._serviceId = this._service.connect('changed', () => this._sync());
        this._sync();
    }

    destroy() {
        this._service.disconnect(this._serviceId);
        this.actor.destroy();
    }

    _actionButton(icon, text, action) {
        const content = new St.BoxLayout({style_class: 'froonty-zerotier-action-content'});
        content.add_child(new St.Icon({icon_name: icon}));
        content.add_child(new St.Label({text, y_align: Clutter.ActorAlign.CENTER}));
        const button = new St.Button({
            style_class: 'froonty-zerotier-action',
            can_focus: true,
            child: content,
        });
        button.connect('clicked', action);
        return button;
    }

    _wrappingLabel(styleClass, text) {
        const label = new St.Label({style_class: styleClass, text, x_expand: true});
        label.clutter_text.line_wrap = true;
        label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        return label;
    }

    _summary(state) {
        if (state.installed === false)
            return _('Not installed');
        if (state.installed === null)
            return _('Checking…');
        const parts = [state.serviceActive === true ? _('Running')
            : state.serviceActive === false ? _('Stopped') : _('Service status unknown')];
        if (state.online === true)
            parts.push(_('online'));
        else if (state.online === false && state.serviceActive !== false)
            parts.push(_('offline'));
        if (state.nodeId)
            parts.push(_('node %s').format(state.nodeId));
        return parts.join(' · ');
    }

    _sync() {
        const state = this._service.state;
        this._summaryLabel.text = this._summary(state);

        this._noticeList.remove_all_children();
        for (const notice of notices(state)) {
            this._noticeList.add_child(this._wrappingLabel('froonty-zerotier-notice',
                noticeText(notice)));
        }
        if (state.error) {
            this._noticeList.add_child(this._wrappingLabel('froonty-zerotier-error',
                state.error));
        }
        this._noticeList.visible = this._noticeList.get_n_children() > 0;

        const installed = state.installed !== false;
        this._startButton.visible = installed && state.serviceActive !== true;
        this._stopButton.visible = installed && state.serviceActive !== false;
        this._startButton.reactive = this._stopButton.reactive = !state.busy;
        this._refreshButton.reactive = !state.busy;

        this._networkList.remove_all_children();
        for (const network of state.networks ?? [])
            this._addNetwork(network);
        this._networkScroll.visible = Boolean(state.networks?.length);
    }

    _addNetwork(network) {
        const row = new St.BoxLayout({
            style_class: 'froonty-zerotier-network',
            orientation: Clutter.Orientation.VERTICAL,
        });
        row.add_child(new St.Label({
            style_class: 'froonty-zerotier-network-name',
            text: network.name || network.id,
        }));
        const parts = [network.id, network.type.toLowerCase(), ...network.addresses]
            .filter(Boolean);
        row.add_child(new St.Label({
            style_class: 'froonty-zerotier-network-meta',
            text: parts.join(' · '),
        }));
        const problem = networkProblem(network);
        row.add_child(this._wrappingLabel(problem
            ? 'froonty-zerotier-network-problem' : 'froonty-zerotier-network-ok',
        problem ? problemText(problem, network) : _('Connected')));
        this._networkList.add_child(row);
    }
}
