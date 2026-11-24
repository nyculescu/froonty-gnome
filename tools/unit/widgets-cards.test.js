// SPDX-License-Identifier: GPL-3.0-or-later
// Where the Markets and Horizon cards show (features/widgets/cards.js):
// what must be on, and what the panic buttons' menu toggles change.

import {isShown, setShown, shownKeys} from '../../froonty@catalin/features/widgets/cards.js';
import {done, eq, makeSettings, test} from './test.js';

test('a card shows where its feature, the place and its own switch are all on', () => {
    const s = makeSettings();
    eq(shownKeys('markets', 'tab'), ['markets-enabled', 'widgets-enabled', 'widgets-markets-enabled']);
    eq(shownKeys('news', 'desktop'), ['horizon-enabled', 'widgets-desktop-enabled', 'widgets-news-pin-desktop']);
    eq([isShown(s, 'markets', 'tab'), isShown(s, 'news', 'tab'), isShown(s, 'markets', 'desktop')],
        [true, true, false], 'defaults: in the tab, not on the desktop');
    s.set_boolean('horizon-enabled', false);
    eq(isShown(s, 'news', 'tab'), false, 'Horizon off');
    s.set_boolean('widgets-enabled', false);
    eq(isShown(s, 'markets', 'tab'), false, 'the tab off');
});

test('shown: everything it needs turns on; hidden: only its own switch there turns off', () => {
    const s = makeSettings();
    s.set_boolean('markets-enabled', false);
    s.set_boolean('widgets-desktop-enabled', false);
    setShown(s, 'markets', 'desktop', true);
    eq(['markets-enabled', 'widgets-desktop-enabled', 'widgets-markets-pin-desktop'].map(k => s.get_boolean(k)),
        [true, true, true]);
    setShown(s, 'markets', 'desktop', false);
    eq(['markets-enabled', 'widgets-desktop-enabled', 'widgets-markets-pin-desktop'].map(k => s.get_boolean(k)),
        [true, true, false], 'the other cards stay on the desktop');
    setShown(s, 'news', 'tab', false);
    eq([s.get_boolean('widgets-news-enabled'), s.get_boolean('widgets-enabled'), s.get_boolean('horizon-enabled')],
        [false, true, true]);
});

await done();
