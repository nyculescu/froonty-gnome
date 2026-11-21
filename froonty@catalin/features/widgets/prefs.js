// SPDX-License-Identifier: GPL-3.0-or-later
// Widgets settings: enable the tab, Horizon repo/data path, desktop pinning,
// the AI Horizon uses and the Markets card's indexes.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {choiceRow, sizeGroup, switchRow} from '../../prefs/rows.js';
import {horizonAiGroup} from './aiPrefs.js';
import {clearFredKey, lookupFredKey, storeFredKey} from './markets/fredKey.js';
import {defaultHorizonRepoPath} from './news/horizonAi.js';

export function widgetsPage(settings) {
    const page = new Adw.PreferencesPage({
        name: 'widgets',
        title: _('Widgets'),
        icon_name: 'view-list-symbolic',
    });

    const group = new Adw.PreferencesGroup({
        title: _('Widgets'),
        description: _('Stock index graphs and news from Horizon, shown in the island and optionally pinned to the desktop background.'),
    });
    group.add(switchRow(settings, 'widgets-enabled', _('Show the Widgets tab')));
    group.add(switchRow(settings, 'widgets-news-pin-desktop', _('Pin the Horizon news card to the desktop background')));

    const defaultRepoPath = defaultHorizonRepoPath();
    const repoRow = new Adw.EntryRow({
        title: _('Horizon repo path'),
        text: settings.get_string('horizon-repo-path') || defaultRepoPath,
        show_apply_button: true,
    });
    repoRow.connect('apply', () => settings.set_string('horizon-repo-path', repoRow.text.trim()));
    settings.connect('changed::horizon-repo-path', () => {
        repoRow.text = settings.get_string('horizon-repo-path') || defaultRepoPath;
    });
    group.add(repoRow);

    const dataRow = new Adw.EntryRow({
        title: _('Horizon data directory'),
        text: settings.get_string('horizon-data-dir'),
        show_apply_button: true,
    });
    dataRow.connect('apply', () => settings.set_string('horizon-data-dir', dataRow.text.trim()));
    settings.connect('changed::horizon-data-dir', () => {
        dataRow.text = settings.get_string('horizon-data-dir');
    });
    group.add(dataRow);
    page.add(group);
    page.add(horizonAiGroup(settings));
    page.add(marketsGroup(settings));
    page.add(sizeGroup(settings, ['widgets-width', 'widgets-height'],
        _('Of the island while the Widgets tab is shown, in logical pixels.')));
    return page;
}

function marketsGroup(settings) {
    const group = new Adw.PreferencesGroup({
        title: _('Markets'),
        // The description is markup; "S&P" would break it.
        description: GLib.markup_escape_text(_('Stock index graphs from Yahoo Finance, free and without a key. When Yahoo fails, the S&P 500, Nasdaq and Dow come from FRED as daily closes, with a free FRED API key.'), -1),
    });
    group.add(switchRow(settings, 'widgets-markets-enabled', _('Show Markets in the Widgets tab')));
    group.add(switchRow(settings, 'widgets-markets-pin-desktop', _('Pin the Markets card to the desktop background')));

    const symbols = () => settings.get_strv('widgets-markets-symbols').join(', ');
    const symbolsRow = new Adw.EntryRow({
        title: _('Indexes (Yahoo symbols, comma separated)'),
        text: symbols(),
        show_apply_button: true,
    });
    symbolsRow.connect('apply', () => settings.set_strv('widgets-markets-symbols',
        symbolsRow.text.split(',').map(s => s.trim()).filter(Boolean)));
    settings.connect('changed::widgets-markets-symbols', () => {
        symbolsRow.text = symbols();
    });
    group.add(symbolsRow);

    group.add(choiceRow(settings, 'widgets-markets-range', _('Graph span'),
        ['1d', '5d', '1mo', '6mo', '1y'],
        [_('Today'), _('5 days'), _('1 month'), _('6 months'), _('1 year')]));
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
