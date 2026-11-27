// SPDX-License-Identifier: GPL-3.0-or-later
// Where the Markets, Weather and Horizon cards show: in the Widgets tab and
// on the desktop. A card shows in a place while its feature, the place (the
// tab, or all desktop widgets) and the card's own switch there are on. Used by
// the tab, the desktop layer and the panic buttons' menus. The ids are
// the desktop placement's (`news` is Horizon's).

export const CARDS = {
    markets: {feature: 'markets-enabled', tab: 'widgets-markets-enabled', desktop: 'widgets-markets-pin-desktop'},
    news: {feature: 'horizon-enabled', tab: 'widgets-news-enabled', desktop: 'widgets-news-pin-desktop'},
    weather: {feature: 'weather-enabled', tab: 'widgets-weather-enabled', desktop: 'widgets-weather-pin-desktop'},
};

const PLACES = {tab: 'widgets-enabled', desktop: 'widgets-desktop-enabled'};

/** The keys that must all be on for `card` to show in `place` ('tab' or 'desktop'). */
export function shownKeys(card, place) {
    const keys = CARDS[card];
    return [keys.feature, PLACES[place], keys[place]];
}

export function isShown(settings, card, place) {
    return shownKeys(card, place).every(key => settings.get_boolean(key));
}

/**
 * Shows `card` in `place`, turning on all it needs; hiding it turns off
 * only the card's own switch there, so the other cards stay as they are.
 */
export function setShown(settings, card, place, shown) {
    if (!shown) {
        settings.set_boolean(CARDS[card][place], false);
        return;
    }
    for (const key of shownKeys(card, place)) {
        if (!settings.get_boolean(key))
            settings.set_boolean(key, true);
    }
}
