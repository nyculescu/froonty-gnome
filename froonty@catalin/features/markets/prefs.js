// SPDX-License-Identifier: GPL-3.0-or-later
// Settings → Markets: the feature's switch, its symbols, the live prices
// with Alpaca's keys, and FRED's key for when Yahoo fails. How the card
// looks and where it shows are under Widgets (widgets/prefs.js).

import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import Soup from 'gi://Soup?version=3.0';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {switchRow} from '../../prefs/rows.js';
import {
    clearAlpacaKeys, clearFredKey, lookupAlpacaKeys, lookupFredKey, storeAlpacaKeys, storeFredKey,
} from './keys.js';
import {MAX_SYMBOLS, chosenSymbols} from './sources.js';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

// Any symbol's latest IEX trade, to see whether Alpaca takes the keys.
const ALPACA_CHECK_URL = 'https://data.alpaca.markets/v2/stocks/trades/latest?symbols=SPY&feed=iex';

// The description is markup; "S&P" would break it.
const plain = text => GLib.markup_escape_text(text, -1);

export function marketsPage(settings) {
    const page = new Adw.PreferencesPage({
        name: 'markets',
        title: _('Markets'),
        icon_name: 'org.gnome.SystemMonitor-symbolic',
    });
    page.add(symbolsGroup(settings));
    page.add(liveGroup(settings));
    page.add(fredGroup());
    return page;
}

function symbolsGroup(settings) {
    const group = new Adw.PreferencesGroup({
        title: _('Markets'),
        description: plain(_('Prices and graphs for any Yahoo Finance symbol, free and without a key: ' +
            'stocks (AAPL), ETFs (SPY), funds (VFIAX), indexes (^GSPC), crypto (BTC-USD), ' +
            'futures (GC=F) and yields (^TNX). The card shows in the Widgets tab and on the desktop; ' +
            'how it looks is set under Widgets.')),
    });
    group.add(switchRow(settings, 'markets-enabled', _('Markets'),
        _('Off, the card shows nowhere and nothing is fetched')));

    const symbols = () => settings.get_strv('widgets-markets-symbols').join(', ');
    const symbolsRow = new Adw.EntryRow({
        title: _('Symbols (Yahoo\'s, comma separated, up to %d)').format(MAX_SYMBOLS),
        text: symbols(),
        show_apply_button: true,
    });
    // Shows what was kept: repeats and those past the limit go.
    symbolsRow.connect('apply', () => {
        settings.set_strv('widgets-markets-symbols', chosenSymbols(symbolsRow.text.split(',')));
        symbolsRow.text = symbols();
    });
    settings.connect('changed::widgets-markets-symbols', () => {
        symbolsRow.text = symbols();
    });
    settings.bind('markets-enabled', symbolsRow, 'sensitive', Gio.SettingsBindFlags.GET);
    group.add(symbolsRow);
    return group;
}

function liveGroup(settings) {
    const group = new Adw.PreferencesGroup({
        title: _('Live prices'),
        description: plain(_('While their market is open, US stocks and ETFs come live from Alpaca\'s ' +
            'free plan, with a free account\'s API keys (paper trading is enough). It streams the trades ' +
            'on IEX, one US exchange, so a quiet stock may not move for a while. Crypto pairs come live ' +
            'from Coinbase, without a key. Otherwise, and when a stream fails, the price is Yahoo\'s, ' +
            'fetched every minute; then FRED\'s daily close (below); then the last one.')),
    });
    const live = switchRow(settings, 'markets-live', _('Live prices'),
        _('A row shows "Alpaca live (IEX)" or "Coinbase live" while its price streams'));
    settings.bind('markets-enabled', live, 'sensitive', Gio.SettingsBindFlags.GET);
    group.add(live);
    for (const row of alpacaKeyRows())
        group.add(row);
    return group;
}

function alpacaKeyRows() {
    const keyId = new Adw.EntryRow({title: _('Alpaca API key ID')});
    const secret = new Adw.PasswordEntryRow({title: _('Alpaca secret key'), show_apply_button: true});
    const saved = new Adw.ActionRow({title: _('Saved Alpaca keys')});
    const getKeys = new Gtk.LinkButton({
        label: _('Get them'),
        uri: 'https://app.alpaca.markets/signup',
        valign: Gtk.Align.CENTER,
    });
    const remove = new Gtk.Button({label: _('Remove'), valign: Gtk.Align.CENTER, css_classes: ['flat']});
    saved.add_suffix(getKeys);
    saved.add_suffix(remove);

    const syncSaved = (checked = '') => {
        lookupAlpacaKeys().then(keys => {
            saved.subtitle = keys
                ? checked || _('In your keyring')
                : _('None: US stocks and ETFs show Yahoo\'s price, every minute.');
            remove.sensitive = Boolean(keys);
        }).catch(e => {
            saved.subtitle = _('The keyring could not be read: %s').format(e.message);
            remove.sensitive = false;
        });
    };
    secret.connect('apply', () => {
        const keys = {key: keyId.text.trim(), secret: secret.text.trim()};
        secret.text = '';
        if (!keys.key || !keys.secret) {
            saved.subtitle = _('Fill in the key ID and the secret key, then press ✓ on the secret.');
            return;
        }
        keyId.text = '';
        saved.subtitle = _('Saving and asking Alpaca…');
        storeAlpacaKeys(keys, _('Froonty: Alpaca API keys'))
            .then(() => checkAlpacaKeys(keys))
            .then(syncSaved)
            .catch(e => (saved.subtitle = _('Could not save them in the keyring: %s').format(e.message)));
    });
    remove.connect('clicked', () => {
        clearAlpacaKeys().finally(() => syncSaved());
    });
    syncSaved();
    return [keyId, secret, saved];
}

// What Alpaca says about the keys, as the saved row's subtitle.
async function checkAlpacaKeys({key, secret}) {
    const session = new Soup.Session({timeout: 15, user_agent: 'Froonty'});
    const message = Soup.Message.new('GET', ALPACA_CHECK_URL);
    message.request_headers.append('APCA-API-KEY-ID', key);
    message.request_headers.append('APCA-API-SECRET-KEY', secret);
    try {
        await session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null);
    } catch (e) {
        return _('In your keyring; Alpaca could not be asked: %s').format(e.message);
    }
    const status = message.get_status();
    if (status === 200)
        return _('In your keyring; Alpaca accepts them');
    if (status === 401 || status === 403)
        return _('In your keyring, but Alpaca refuses them (HTTP %d)').format(status);
    return _('In your keyring; Alpaca answered HTTP %d').format(status);
}

function fredGroup() {
    const group = new Adw.PreferencesGroup({
        title: _('When Yahoo fails'),
        description: plain(_('The S&P 500, Nasdaq and Dow come from FRED as daily closes, with a free ' +
            'FRED API key. Other symbols show their last reading, marked "not updated".')),
    });
    for (const row of fredKeyRows())
        group.add(row);
    return group;
}

function fredKeyRows() {
    const key = new Adw.PasswordEntryRow({title: _('FRED API key (free)'), show_apply_button: true});
    const saved = new Adw.ActionRow({title: _('Saved FRED key')});
    const getKey = new Gtk.LinkButton({
        label: _('Get one'),
        uri: 'https://fred.stlouisfed.org/docs/api/api_key.html',
        valign: Gtk.Align.CENTER,
    });
    const remove = new Gtk.Button({label: _('Remove'), valign: Gtk.Align.CENTER, css_classes: ['flat']});
    saved.add_suffix(getKey);
    saved.add_suffix(remove);

    const syncSaved = () => {
        lookupFredKey().then(value => {
            saved.subtitle = value
                ? _('In your keyring; used only when Yahoo fails')
                : _('None. Without one, an index Yahoo fails for shows its last reading.');
            remove.sensitive = Boolean(value);
        }).catch(e => {
            saved.subtitle = _('The keyring could not be read: %s').format(e.message);
            remove.sensitive = false;
        });
    };
    key.connect('apply', () => {
        const value = key.text.trim();
        key.text = '';
        if (!value)
            return;
        storeFredKey(value, _('Froonty: FRED API key'))
            .then(syncSaved)
            .catch(e => (saved.subtitle = _('Could not save it in the keyring: %s').format(e.message)));
    });
    remove.connect('clicked', () => {
        clearFredKey().finally(syncSaved);
    });
    syncSaved();
    return [key, saved];
}
