# Feature: Focus

Status: **implemented**, 2026-10-10. Working-tree only (`make install`): not
in `make pack` output. **On by default** (Settings → Fan → **Focus in Quick
Settings**).

Tells this computer where you are, like macOS's Focus in Control Center:
**Working** (at the computer), **Sleeping**, **Away from home**, or **Auto**
(none chosen). The cooling pad's noise cap follows it, and so does the
laptop-fan controller of the VSL batch runs (phd_speed_harmo_v5,
`vsl_lab/ops/cooling.py`). Focus never changes by itself: away from the desk
is not away from home.

## 1. Use

Quick Settings → **Focus**. The toggle switches between Auto and the last
mode picked in its menu; the menu (the arrow) picks one. While Focus is
Sleeping or Away, its icon shows in the top bar.

When Froonty starts while Focus is Away (a login, or an unlock: the Shell
turns extensions off on the lock screen), a notification asks **Focus is
Away from home**: **I’m back: Working** or **Still away**. Picking any other
mode withdraws it.

## 2. What follows it

| Focus | Pad cap (llano) | Laptop fans (batch controller) |
|---|---|---|
| Working | the clock's: 1000 rpm by day, 600 rpm in quiet hours | firmware curves |
| Sleeping | 600 rpm (the quiet-hours cap) at any time | firmware curves |
| Away from home | `away_max_rpm` (none by default: up to 100 %) | adjusted automatically |
| Auto | the clock's | firmware curves |

The caps live in llano's `noise.py` (patch 0012), so every program that
drives the pad through llano.py obeys them, the Fan tab included; the Fan
tab's limit line names the Focus mode when it sets the cap. The values are
llano's (`~/.config/llano/noise.json`: `day_max_rpm`, `quiet_max_rpm`,
`away_max_rpm`). `llano.py loud` still lifts every cap for a while.

## 3. The file

`$XDG_STATE_HOME/focus/mode.json` (`~/.local/state/focus/mode.json`):

```json
{"mode": "away", "since": 1791650000, "by": "Froonty"}
```

`mode` is `working`, `sleeping`, `away` or `auto`; a missing or unreadable
file, or any other value, is Auto. Froonty writes it atomically (a
temporary file renamed over it) and follows changes made by other programs
(a file monitor), so a script can set Focus too. It is not a GNOME setting
on purpose: llano and the batch scripts read it without GNOME.

## 4. Code

- `froonty@catalin/features/focus/mode.js`: the modes and the file (no Shell
  imports; `tools/unit/focus.test.js`).
- `froonty@catalin/features/focus/quickToggle.js`: the toggle, its menu, the
  top-bar icon and the notification; an extension part (`LOCAL_PARTS`).
- Settings: `focus-enabled`, `focus-last` (what the toggle switches to from
  Auto).
- Headless checks: `testFocus` in `tools/headless-test/checks.js`.
