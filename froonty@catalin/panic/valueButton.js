// SPDX-License-Identifier: GPL-3.0-or-later
// A panic button that shows a value: its icon in front of the value, as the
// readouts on the collapsed pill.

import Clutter from 'gi://Clutter';
import St from 'gi://St';

/**
 * @param {string} title its accessible name
 * @param {string} buttonClass
 * @param {string} numberClass
 * @returns {{actor: St.Button, icon: St.Icon, number: St.Label}}
 */
export function valueButton(title, buttonClass, numberClass) {
    const icon = new St.Icon({
        style_class: 'froonty-panic-value-icon',
        y_align: Clutter.ActorAlign.CENTER,
    });
    const number = new St.Label({
        style_class: numberClass,
        y_align: Clutter.ActorAlign.CENTER,
    });
    const row = new St.BoxLayout({style_class: 'froonty-panic-value'});
    row.add_child(icon);
    row.add_child(number);
    const actor = new St.Button({
        style_class: `froonty-icon-button froonty-panic-button ${buttonClass}`,
        accessible_name: title,
        can_focus: true,
        track_hover: true,
        child: row,
    });
    return {actor, icon, number};
}
