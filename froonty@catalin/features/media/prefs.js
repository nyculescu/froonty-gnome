// SPDX-License-Identifier: GPL-3.0-or-later
// Media settings tab (docs/features/media.md §Settings). Runs in the
// preferences process (GTK 4, libadwaita).

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const SIZE_KEYS = ['media-width', 'media-height'];

export function mediaPage(settings) {
    const page = new Adw.PreferencesPage({
        name: 'media',
        title: _('Media'),
        icon_name: 'multimedia-player-symbolic',
    });

    const main = new Adw.PreferencesGroup({
        title: _('Media'),
        description: _('What music and video players on this computer report (MPRIS), with play, pause, skip and seek. Nothing leaves this computer unless you turn on one of the two internet options below.'),
    });
    main.add(switchRow(settings, 'media-enabled', _('Show the Media tab')));
    page.add(main);

    const island = new Adw.PreferencesGroup({title: _('In the island')});
    island.add(switchRow(settings, 'media-show-in-pill', _('Show music while playing'),
        _('Cover and bars beside the time')));
    island.add(switchRow(settings, 'media-track-notice', _('New song'),
        _('Shows the title for a few seconds')));
    island.add(switchRow(settings, 'media-pill-opens-tab', _('Open the Media tab from the island')));
    island.add(switchRow(settings, 'media-animate-bars', _('Moving bars'),
        _('While music plays, GNOME redraws the bars every frame')));
    island.add(switchRow(settings, 'media-gestures', _('Swipe to change song'),
        _('Two fingers left or right on the touchpad')));
    page.add(island);

    const players = new Adw.PreferencesGroup({title: _('Players')});
    players.add(switchRow(settings, 'media-include-other-players',
        _('Follow browsers and video players automatically'),
        _('When off, they show only when you pick them; music players are always followed. On by default because much music plays in a browser.')));
    page.add(players);

    const extras = new Adw.PreferencesGroup({title: _('Extras')});
    extras.add(switchRow(settings, 'media-lyrics', _('Lyrics')));
    const online = switchRow(settings, 'media-lyrics-online', _('Find lyrics online'),
        _('Sends the song’s title, artist, album and length to lrclib.net.'));
    settings.bind('media-lyrics', online, 'sensitive', Gio.SettingsBindFlags.GET);
    extras.add(online);
    extras.add(switchRow(settings, 'media-queue', _('Up next')));
    page.add(extras);

    const internet = new Adw.PreferencesGroup({title: _('Internet')});
    internet.add(switchRow(settings, 'media-remote-art', _('Cover art from the internet'),
        _('Some players give their cover as a web address. Froonty then downloads it from that address.')));
    page.add(internet);

    page.add(sizeGroup(settings));
    return page;
}

// Island size while the Media tab is shown; applies live. As Kill Process'.
function sizeGroup(settings) {
    const reset = new Gtk.Button({
        label: _('Default size'),
        valign: Gtk.Align.CENTER,
        css_classes: ['flat'],
    });
    const group = new Adw.PreferencesGroup({
        title: _('Size'),
        description: _('Of the island while the Media tab is shown, in logical pixels. Lyrics and Up next add room while open. Or drag the open island’s bottom-right corner.'),
        header_suffix: reset,
    });
    group.add(spinRow(settings, 'media-width', _('Width')));
    group.add(spinRow(settings, 'media-height', _('Height')));

    const sync = () => {
        const defaults = SIZE_KEYS.map(key => settings.get_default_value(key).unpack());
        reset.tooltip_text = defaults.join(' × ');
        reset.sensitive = SIZE_KEYS.some(key => settings.get_user_value(key) !== null);
    };
    sync();
    for (const key of SIZE_KEYS)
        settings.connect(`changed::${key}`, sync);
    reset.connect('clicked', () => SIZE_KEYS.forEach(key => settings.reset(key)));
    return group;
}

function switchRow(settings, key, title, subtitle = '') {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

// Spin bounds are read from the schema's <range>, as in prefs.js.
function spinRow(settings, key, title) {
    const [, [lower, upper]] = settings.settings_schema.get_key(key)
        .get_range().recursiveUnpack();
    const row = Adw.SpinRow.new_with_range(lower, upper, 1);
    row.title = title;
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}
