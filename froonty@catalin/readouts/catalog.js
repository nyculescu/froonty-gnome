// SPDX-License-Identifier: GPL-3.0-or-later
// Every readout Froonty knows, in the order Settings offers them. A readout
// only prints a value on the collapsed pill: nothing to press, so anything
// that acts (mute, pin) stays a panic button. Pure data, shared by the Shell
// side (readouts/registry.js) and the settings window (readouts/prefs.js).
//
// Adding a readout: an entry here and a factory in registry.js.

export const MAX_READOUTS = 8;

// A better balance has to win by this much (px), so that a digit changing
// does not send a readout across the time.
const SPLIT_MARGIN = 12;

export const READOUTS = [
    {
        id: 'cpu-load',
        icon: 'froonty-cpu-symbolic',
        title: _ => _('CPU load'),
    },
    {
        id: 'gpu-load',
        icon: 'froonty-gpu-symbolic',
        title: _ => _('GPU load'),
        description: _ => _('The busiest graphics card. A card that sleeps is not woken up, but ' +
            'reading an awake NVIDIA card at each refresh may keep it from going to sleep.'),
    },
    {
        id: 'ram-usage',
        icon: 'froonty-memory-symbolic',
        title: _ => _('RAM usage'),
    },
    {
        id: 'cpu-temp',
        icon: 'froonty-cpu-symbolic',
        title: _ => _('CPU temperature'),
        description: _ => _('The average over the CPU’s cores'),
    },
    {
        id: 'cpu-temp-max',
        icon: 'froonty-thermometer-symbolic',
        title: _ => _('Hottest CPU core'),
    },
    {
        id: 'gpu-temp',
        icon: 'froonty-gpu-symbolic',
        title: _ => _('GPU temperature'),
        description: _ => _('The hottest graphics card. A card that sleeps is not woken up, but ' +
            'reading an awake NVIDIA card at each refresh may keep it from going to sleep.'),
    },
    {
        id: 'net-down',
        icon: 'go-down-symbolic',
        title: _ => _('Download speed'),
    },
    {
        id: 'net-up',
        icon: 'go-up-symbolic',
        title: _ => _('Upload speed'),
    },
    {
        id: 'disk-used',
        icon: 'drive-harddisk-symbolic',
        title: _ => _('Disk used'),
        description: _ => _('The root file system'),
    },
    {
        id: 'claude-session',
        icon: 'froonty-claude-symbolic',
        title: _ => _('Claude session usage'),
    },
    {
        id: 'claude-weekly',
        icon: 'froonty-claude-symbolic',
        title: _ => _('Claude weekly usage'),
    },
    {
        id: 'timezone-1',
        icon: 'preferences-system-time-symbolic',
        title: _ => _('First favourite time zone'),
        description: _ => _('Its city and time. Choose favourites in Settings → Time zones.'),
    },
    {
        id: 'timezone-2',
        icon: 'preferences-system-time-symbolic',
        title: _ => _('Second favourite time zone'),
        description: _ => _('Its city and time. Choose favourites in Settings → Time zones.'),
    },
];

/**
 * The configured list as it should be shown: known ids only, no duplicates,
 * at most MAX_READOUTS, order kept.
 *
 * @param {string[]} ids from the readouts setting
 */
export function sanitize(ids) {
    const known = new Set(READOUTS.map(r => r.id));
    return [...new Set(ids)].filter(id => known.has(id)).slice(0, MAX_READOUTS);
}

/**
 * Where to split the readouts, in order, so that the two sides of the time
 * come closest in width. A tie gives the right side more.
 *
 * @param {number[]} widths each readout's width, 0 when hidden
 * @param {number} spacing between two shown readouts
 * @param {number} current the split now, kept unless SPLIT_MARGIN is beaten
 * @returns {number} how many go on the left
 */
export function balancedSplit(widths, spacing, current) {
    const width = part => {
        const shown = part.filter(w => w > 0);
        return shown.reduce((sum, w) => sum + w, 0) + spacing * Math.max(0, shown.length - 1);
    };
    const imbalance = split => Math.abs(width(widths.slice(0, split)) - width(widths.slice(split)));
    let best = 0;
    for (let split = 1; split <= widths.length; split++) {
        if (imbalance(split) < imbalance(best))
            best = split;
    }
    return imbalance(current) - imbalance(best) > SPLIT_MARGIN ? best : current;
}

export function byId(id) {
    return READOUTS.find(r => r.id === id) ?? null;
}
