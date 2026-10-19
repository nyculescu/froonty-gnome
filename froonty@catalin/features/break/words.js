// SPDX-License-Identifier: GPL-3.0-or-later
// Every user-facing string of the Break tab's levels, actions, pill cue and
// status (docs/features/break.md). Built with the caller's gettext, like
// panic/catalog.js, so it loads in plain gjs tests; no St.
//
//   const w = words({_, ngettext});

import {LEVEL} from './engine.js';

export function words({_, ngettext}) {
    const typeName = type => ({
        eyesight: _('Eye break'),
        movement: _('Movement break'),
    }[type] ?? _('Break'));

    /** "20 s", "5 min", "1 h 10 min", "2 h". */
    const duration = seconds => {
        const s = Math.max(0, Math.round(seconds));
        if (s < 60)
            return _('%d s').format(s);
        const minutes = Math.round(s / 60);
        if (minutes < 60)
            return _('%d min').format(minutes);
        const h = Math.floor(minutes / 60);
        const rest = minutes % 60;
        return rest ? _('%d h %d min').format(h, rest) : _('%d h').format(h);
    };
    const minutesWord = minutes => ngettext('%d minute', '%d minutes', minutes).format(minutes);
    const upMinutes = seconds => Math.max(1, Math.ceil(seconds / 60));
    const downMinutes = seconds => Math.max(0, Math.floor(seconds / 60));

    const levelName = level => [_('Fine'), _('Soon'), _('Due'), _('Overdue'), _('Urgent')][level];
    const rule = _('(Froonty’s rule)');

    return {
        typeName,
        duration,

        /** The status line under the level meter. */
        status(lv, longRest) {
            const name = lv.froontyRule ? `${levelName(lv.level)} ${rule}` : levelName(lv.level);
            let what;
            if (lv.reason === 'long-rest') {
                what = _('%s at the screen without a %s pause').format(
                    duration(longRest.since), duration(longRest.length));
            } else if (lv.reason === 'paused') {
                what = _('Breaks paused');
            } else if (lv.reason === 'waiting') {
                what = _('%s due at your next pause in typing').format(typeName(lv.type));
            } else if (!lv.type) {
                what = _('No break reminders');
            } else if (lv.level === LEVEL.FINE) {
                what = _('Next: %s in %s').format(typeName(lv.type).toLowerCase(), duration(lv.soonIn));
            } else if (lv.level === LEVEL.SOON) {
                what = _('%s in %s').format(typeName(lv.type), duration(lv.soonIn));
            } else if (lv.reason === 'skips') {
                what = _('%s due; skipped or delayed several times in a row').format(typeName(lv.type));
            } else if (lv.level === LEVEL.DUE) {
                what = _('%s due now').format(typeName(lv.type));
            } else {
                what = _('%s, %s overdue').format(typeName(lv.type), duration(lv.overdue));
            }
            return `${name} · ${what}`;
        },

        /** The level meter's accessible name. */
        meterName: level => _('Urgency: %s, %d of 4').format(levelName(level).toLowerCase(), level),

        suggested(s) {
            if (!s)
                return '';
            if (s.walk)
                return _('Suggested: a %s walk (you worked out today; Froonty’s rule)').format(duration(s.seconds));
            if (s.longRest) {
                return _('Suggested: %s away from the screen (Froonty’s rule, after the AOA’s 15 min after 2 h; expert opinion)')
                    .format(duration(s.seconds));
            }
            const line = _('Suggested: %s away from the screen').format(duration(s.seconds));
            return s.insteadMovement ? `${line} ${_('or take a movement break instead')}` : line;
        },

        delayLabel: seconds => _('Delay %s').format(duration(seconds)),
        skipLabel: both => (both ? _('Skip both') : _('Skip')),
        takeLabel: () => _('Take now'),

        /** The line under the buttons. */
        hint(a) {
            if (!a.skip)
                return '';
            const length = duration(a.duration);
            if (a.interrupted)
                return _('Break interrupted: it counts once you’ve been away %s in one go.').format(length);
            if (!a.take)
                return '';
            if (a.lock)
                return _('The screen locks; the break counts once you’ve been away %s.').format(length);
            if (a.fade)
                return _('The screen dims; the break counts once you’ve been away %s.').format(length);
            return _('Step away now; it counts once you’ve been away %s.').format(length);
        },

        skipHidden(h) {
            if (!h)
                return '';
            return ngettext('No more skips: %d in a row is the most (Settings → Break).',
                'No more skips: %d in a row is the most (Settings → Break).', h.max).format(h.max);
        },

        delayHidden(h) {
            if (!h)
                return '';
            if (h.reason === 'capped') {
                return ngettext('No more delays: %d in a row is the most (Settings → Break).',
                    'No more delays: %d in a row is the most (Settings → Break).', h.max).format(h.max);
            }
            return _('Delay moves a break by %s; this one is %s overdue.').format(
                duration(h.delay), duration(h.overdue));
        },

        /**
         * The pill's cue text for `mode` ('icon' or 'icon-and-time') and
         * its accessible text.
         */
        cue(cue, mode) {
            if (cue.kind === 'move') {
                return {
                    text: '\u25ae'.repeat(cue.segments),
                    accessibleText: _('No movement for %s').format(duration(cue.seconds)),
                };
            }
            if (cue.kind === 'posture') {
                return {
                    text: '',
                    accessibleText: cue.posture === 'stand' ? _('Time to stand up') : _('Time to sit down'),
                };
            }
            const timed = mode === 'icon-and-time';
            const name = typeName(cue.type);
            switch (cue.level) {
            case LEVEL.FINE:
                return {
                    text: timed ? _('%dm').format(upMinutes(cue.seconds)) : '',
                    accessibleText: _('Next break in %s').format(minutesWord(upMinutes(cue.seconds))),
                };
            case LEVEL.SOON:
                // Due, waiting for a pause in typing (Froonty's rule).
                if (cue.reason === 'waiting') {
                    return {
                        text: timed ? _('now') : '',
                        accessibleText: _('%s due at your next pause in typing').format(name),
                    };
                }
                return {
                    text: timed ? _('%dm').format(upMinutes(cue.seconds)) : '',
                    accessibleText: _('%s in %s').format(name, minutesWord(upMinutes(cue.seconds))),
                };
            case LEVEL.DUE:
                return {
                    text: timed ? _('now') : '',
                    accessibleText: _('%s due').format(name),
                };
            case LEVEL.OVERDUE:
                // Overdue at once after skips or delays in a row (Froonty's rule).
                if (cue.reason === 'skips') {
                    return {
                        text: timed ? _('now') : '',
                        accessibleText: _('%s due, after skips or delays in a row').format(name),
                    };
                }
                return {
                    text: timed ? _('+%dm').format(downMinutes(cue.seconds)) : '',
                    accessibleText: _('%s overdue by %s').format(name, minutesWord(downMinutes(cue.seconds))),
                };
            default:
                if (cue.reason === 'long-rest') {
                    const hours = Math.floor(cue.seconds / 3600);
                    return {
                        text: timed ? _('%dh').format(hours) : '!',
                        accessibleText: _('Urgent: long rest suggested, %s at the screen without a %s pause')
                            .format(ngettext('%d hour', '%d hours', hours).format(hours), duration(cue.length)),
                    };
                }
                return {
                    text: timed ? _('+%dm').format(downMinutes(cue.seconds)) : '!',
                    accessibleText: _('Urgent: %s overdue by %s').format(name.toLowerCase(),
                        minutesWord(downMinutes(cue.seconds))),
                };
            }
        },

        reminders(status) {
            if (status.state === 'unavailable') {
                return _('GNOME’s break notifications could not be turned off (locked by the administrator); you may be reminded twice.');
            }
            if (status.state !== 'froonty')
                return _('Reminders: GNOME’s notifications.');
            const line = _('Reminders: in the island. GNOME’s break notifications are off while Froonty runs.');
            return status.dailyLimitHidden
                ? `${line} ${_('GNOME’s daily screen-time limit alerts are hidden too.')}`
                : line;
        },

        /** Why the cue is held, or the grace after: "In a call: …". */
        busy(busy, graceUntil, fmt) {
            const names = {
                'fullscreen': _('a full-screen window'),
                'screen-share': _('screen sharing'),
                'microphone': _('a call (microphone in use)'),
                'dnd': _('Do Not Disturb'),
            };
            const holding = busy.reasons.filter(r => r in names).map(r => names[r]);
            if (holding.length)
                return _('Busy (%s): break cues wait until it ends.').format(holding.join(', '));
            if (graceUntil)
                return _('Break cues are back at %s.').format(fmt(graceUntil));
            return '';
        },

        /** Who keeps the screen awake: "Watching (brave): counts as time at the computer." */
        watching(apps) {
            if (!apps.length)
                return '';
            return _('Watching (%s): counts as time at the computer.').format(apps.join(', '));
        },

        /** "Paused until 15:30", "Outside working hours until Mon 09:00". */
        paused(p, fmt) {
            if (!p?.paused)
                return '';
            if (p.reason === 'hours') {
                return p.until ? _('Outside working hours: breaks resume at %s.').format(fmt(p.until))
                    : _('Outside working hours.');
            }
            return _('Breaks paused until %s.').format(fmt(p.until));
        },

        reason: r => ({
            meeting: _('Meeting'),
            deadline: _('Deadline'),
            flow: _('In the flow'),
            other: _('Other'),
        }[r]),

        /** The move bar's line in the tab. */
        move(move, segments) {
            if (!segments)
                return _('Moved %s ago; the move bar starts after %s.').format(
                    duration(move.sinceMove), duration(move.after));
            return _('No movement for %s: a walk of a couple of minutes clears it.').format(
                duration(move.sinceMove));
        },

        /** "Moved in 5 of 7 hours at the computer". */
        movedHours(moved, hours) {
            return ngettext('Moved in %d of %d hour at the computer', 'Moved in %d of %d hours at the computer',
                hours).format(moved, hours);
        },

        workout(w) {
            if (!w.minutes)
                return '';
            if (w.longDay)
                return _('Worked out %s today; after 10 h at the computer nothing is eased.').format(duration(w.minutes * 60));
            return _('Worked out %s today: the standing target stays at the minimum and counts it (up to 1 h); after it, short walks will do (Froonty’s rule).')
                .format(duration(w.minutes * 60));
        },

        /** "Garmin: strength training 52 min, walking 31 min". */
        garminActivities: list => _('Garmin: %s').format(list.map(a =>
            `${a.type.replace(/_/g, ' ')} ${duration(a.minutes * 60)}`).join(', ')),

        intensity: i => _('intensity minutes %d (vigorous count double: %d)').format(
            i.moderate + i.vigorous, i.moderate + 2 * i.vigorous),

        garminError: error => ({
            auth: _('Garmin: sign in again in Settings → Break'),
            blocked: _('Garmin refused the connection for now; retried in a few hours'),
            network: _('Garmin could not be reached'),
            setup: _('Garmin: set it up in Settings → Break'),
        }[error] ?? _('Garmin could not be read')),

        workoutAsk: (away, fmt) => _('Away %s (%s–%s). Was it a workout?').format(
            duration((away.to - away.from) / 1000), fmt(away.from / 1000), fmt(away.to / 1000)),

        notMedicalAdvice: () =>
            _('Not medical advice: reminders only; the timings are guidance, mostly expert opinion.'),
    };
}
