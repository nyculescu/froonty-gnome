# Feature: When Claude needs you (the attention bar)

Status: **implemented**, 2026-10-02 (Unreleased), on top of the
Notifications tab's store (section 9), which it keeps now that the tab is
removed.

## 1. Goal

User request: "a small notification bar under the pill to inform that
Claude needs attention, like from VS Code or Claude app or even Claude from
Browser", "in a simple and low-power mode".

```
            ( 14:35 )                         the collapsed pill
  ┌───────────────────────────────────────────────┐
  │ ✳ Claude needs your permission  Froonty · Visual Studio Code  +1  × │
  └───────────────────────────────────────────────┘
```

A slim bar under the collapsed pill, only while a Claude session waits for
the user. A click goes there (raises its window); × hides it. It never
polls: Claude Code and the Claude app tell Froonty.

## 2. Sources

| Source | How it reaches Froonty | Set up | Cleared by |
|---|---|---|---|
| **Claude Code**: terminal, VS Code extension, the Claude app's Code tab | Claude Code's documented hooks run Froonty's GJS script, which writes one small file per session; Froonty watches the folder (one `Gio.FileMonitor`) | Settings → Claude → "Claude Code hooks" → **Set up** | the next prompt (`UserPromptSubmit`), the next model step (`PostToolBatch`), the session's end (`SessionEnd`), an MCP elicitation answered, Stop with background work pending, focusing that window (a permission or a question whose window is not known for sure: any window of its app; section 6), a click, × |
| **The Claude app** (`com.anthropic.Claude.desktop`) | its own desktop notifications, in GNOME's message tray | none (on by default) | the app closing its notification once you have seen the session, GNOME's list, a click, × |
| **claude.ai in a browser** (off by default) | a web browser's notification that mentions "claude.ai" | Settings → Claude → "Browser notifications from claude.ai" | GNOME's list, a click, × |

Claude Code's events and what the bar says:

| Claude Code event (`notification_type`) | Bar |
|---|---|
| `permission_prompt`, `worker_permission_prompt` | Claude needs your permission |
| `elicitation_dialog`, `elicitation_url_dialog`, `agent_needs_input` | Claude needs your input |
| `StopFailure` | Claude stopped with an error |
| `idle_prompt`, `quota_auto_resume_stale` | Claude is waiting for your input |
| `Stop` (no background task or session cron pending) | Claude finished |
| `elicitation_complete`, `elicitation_response`; `Stop` with background work pending | clears |
| anything else (`auth_success`, `agent_completed`, …) | nothing |

The Claude app's notifications (English wording, not verified): a body
starting with "Allow" → permission; "waiting for your input" → waiting;
"finished" → finished; anything else → "Claude needs your attention".
Browser notifications always read "Claude needs your attention".

Several waiting at once: the most urgent kind first (the order of the
table above: permission, input, error, attention, waiting, finished), then
the newest; "+2" counts the others.

## 3. Decisions

From the approved plan, and the spec it was built from:

- **Claude Code through its documented hooks**, not its private files
  (`~/.claude/sessions/<pid>.json` and the like): the user approved the
  hooks, and their format is documented
  ([hooks](https://code.claude.com/docs/en/hooks)). vorssaint-utils polls
  Claude Code's logs every 2 s; Froonty does not poll at all.
- **Clearing uses `PostToolBatch`, not `PreToolUse`.** `PreToolUse` runs
  before every tool call, before the permission check, so it never follows
  an approval. `PostToolBatch` runs once per model step, after every tool
  call of the step has resolved. That it also follows a denied call in VS
  Code and the Claude app is inferred from the docs, not verified (§12).
- **`Stop` counts as "Claude finished"** ("Also when Claude finishes", on
  by default). Reading Claude Code's bundle suggests `idle_prompt` comes
  only from the terminal UI, so in VS Code and the Claude app a finished
  reply is the only "come back" signal. It is not shown while you are
  looking at that window (its own window, known for sure, has the focus).
- **What counts as "already looking at it"** on arrival: only the
  session's own window, known for sure, with the focus; and in a terminal
  only for a finished reply or an error. Claude Code sends a permission,
  a question or an idle prompt only after about 6 s or 60 s in which
  nobody typed into it, whatever has the focus (reading the 2.1.286 bundle:
  the time since the last interaction with that Claude Code, not the
  terminal's focus), and a terminal's tabs are invisible to Froonty: the
  focused terminal window may show another tab. Before this rule, any
  focused window of the same app counted, and a terminal user typing in
  another tab or window never saw the bar.
- **Focus clears a permission or a question on any window of its app**
  when the session's own window is not known for sure: going there is
  most likely answering it. Answering is not an event of Claude Code's,
  and the next one (`PostToolBatch`) waits until every tool of the step,
  the approved one included, has finished. Finished replies, errors and
  idle prompts clear only on their own window.
- **Sessions in the Claude app come from its own notifications** ("Sessions
  in the Claude app", on by default): the app knows when you have viewed a
  session and closes its notification then. Claude Code's hooks from the
  app's sessions (entrypoint `claude-desktop`, `claude-desktop-3p`,
  `local-agent`) are kept but not shown; off, they are shown like VS Code's.
- **Browsers are off by default.** Matching another app's notification text
  is a heuristic; requiring "claude.ai" avoids, say, a message from a person
  named Claude.
- **Only sessions a person sits at.** The hook records nothing for
  `claude -p` runs (`CLAUDE_CODE_ENTRYPOINT` `sdk-*`, which includes
  Froonty's own `/usage` refresher), MCP servers, remote sessions or the
  GitHub Action.
- **Nothing that Claude said is ever written down**: no message, title,
  prompt, reply, tool, path (only the project folder's name) or
  notification type (only the kind it maps to).
- **The bar is hidden** while the island is open, while a GNOME banner is
  on screen (it would cover it), in the overview and under Do Not Disturb.
  Fullscreen windows hide the whole island.
- **Set up is a click**, as for the status line: Froonty never edits Claude
  Code's settings on its own.

## 4. The hook script and its state files

Claude Code runs `features/claude/attentionHook.js` with `gjs` in exec form
(no shell) and `async: true`, so it never holds Claude up:

```
/usr/bin/gjs -m <extension>/features/claude/attentionHook.js notification|stop|stop-failure
```

It is GJS, as the extensions.gnome.org guidelines ask for scripts. It never
prints to stdout (an async hook's JSON output would reach Claude) and always
exits 0. In order:

1. Its argument must be one of the three events.
2. `$XDG_RUNTIME_DIR/froonty/claude-attention/` must be a real folder (not a
   symlink). It exists only while Froonty's bar is on (and through a screen
   lock, section 6); turning the bar, the island or Froonty off removes it.
   The script never creates it, so nothing is recorded while nobody
   listens.
3. `CLAUDE_CODE_ENTRYPOINT` must be unset, `cli`, `claude-vscode`,
   `claude-desktop`, `claude-desktop-3p` or `local-agent`.
4. Stdin is read to the end (at most 16 MiB kept; `GioUnix.InputStream`),
   and parsed as JSON; anything else counts as `{}`.
5. The session is the input's `session_id`, else `CLAUDE_CODE_SESSION_ID`;
   only `[0-9A-Za-z-]{1,128}`.
6. A clearing event deletes the session's file; nothing else is done.
7. Otherwise it builds a record and renames it into place (a temporary file
   in the parent folder, `0600`, then a rename: the folder monitor sees one
   `MOVED_IN`, never a half-written file).

A state file, `<session_id>.json` (at most 4 KiB, `0600`, in a `0700`
folder on tmpfs, gone at logout):

```json
{"v":1,"kind":"permission","at":1790819528707,"session":"0b9f2c1e-…","entrypoint":"claude-vscode","project":"Froonty","pids":[[1234567,98765432],[1234500,98765000],[618287,9000000]],"desktop":"com.microsoft.VSCode.desktop"}
```

- `pids`: Claude Code (`CLAUDE_PID`, else the script's parent) and up to 15
  of its ancestors, each with its start time from `/proc/<pid>/stat`. The
  Shell uses them to tell a running Claude Code from a reused process id,
  and to find the window (VS Code, the terminal) the session belongs to.
- `project`: the basename of `CLAUDE_PROJECT_DIR`, else of the input's
  `cwd`; control characters removed, at most 128 characters.
- `desktop`: `CHROME_DESKTOP` when it is a desktop id (Electron hosts such
  as VS Code set it for their children); a fallback to find the app.
- Each write replaces the file: the newest event of a session wins.

Clearing (`UserPromptSubmit`, `PostToolBatch`, `SessionEnd`) is a one-line
`sh` command, as a GJS process after every prompt and every model step
would cost about 38 ms and 33 MB each:

```sh
case "$CLAUDE_CODE_SESSION_ID" in ""|*[!0-9A-Za-z-]*) ;; *) rm -f -- "${XDG_RUNTIME_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}}/froonty/claude-attention/$CLAUDE_CODE_SESSION_ID.json" ;; esac
```

It prints nothing and exits 0, also without the file or the folder.

## 5. What Set up adds to Claude Code's settings

Settings → Claude → "When Claude needs you" → "Claude Code hooks" → **Set
up** adds these to `$CLAUDE_CONFIG_DIR/settings.json`, else
`~/.claude/settings.json` (the path here is a `make install` copy;
`<CLEAR>` is the command above):

```json
"hooks": {
  "Notification": [{"matcher": "permission_prompt|worker_permission_prompt|elicitation_dialog|elicitation_url_dialog|elicitation_complete|elicitation_response|agent_needs_input|idle_prompt|quota_auto_resume_stale",
                    "hooks": [{"type": "command", "command": "/usr/bin/gjs", "args": ["-m", "/home/catalin/.local/share/gnome-shell/extensions/froonty@catalin/features/claude/attentionHook.js", "notification"], "async": true}]}],
  "Stop":        [{"hooks": [{"type": "command", "command": "/usr/bin/gjs", "args": ["-m", "<script>", "stop"], "async": true}]}],
  "StopFailure": [{"hooks": [{"type": "command", "command": "/usr/bin/gjs", "args": ["-m", "<script>", "stop-failure"], "async": true}]}],
  "UserPromptSubmit": [{"hooks": [{"type": "command", "command": "<CLEAR>", "async": true}]}],
  "PostToolBatch":    [{"hooks": [{"type": "command", "command": "<CLEAR>", "async": true}]}],
  "SessionEnd":       [{"hooks": [{"type": "command", "command": "<CLEAR>"}]}]
}
```

- The matcher holds only letters, `_` and `|`, so Claude Code reads it as a
  list of exact names, not a pattern.
- `SessionEnd` is synchronous (an async hook may be killed while the
  session ends) and has no `timeout`, so it does not raise SessionEnd's
  shared 1.5 s budget.
- `gjs` is `/usr/bin/gjs` when it exists. Deviation from the spec, which
  took the first `gjs` on `PATH`: on this machine `PATH` starts with
  another toolchain's folder holding its own `gjs` link (the Makefile notes
  the same for GLib's tools), and a fixed path keeps the entries identical
  between Set up runs.
- Needs Claude Code 2.1.233 or later (`permission_prompt` in VS Code and
  Claude app sessions). The installed copies are 2.1.286 and 2.1.287.

**Never inside a group of the user's.** Froonty's handlers are in groups of
their own, appended after the user's; a new event key is appended to
`hooks`, a missing `hooks` at the end of the file; every other key keeps
its value and place. A second Set up writes a byte-identical file.

**Which handlers are Froonty's:** the exact clear command, or a handler
whose command is `gjs` or `gjs-console` (any folder) with exactly the
arguments `-m`, a path ending in
`/froonty@catalin/features/claude/attentionHook.js`, and one of the three
events. A user's command that merely runs the script inside a shell
pipeline is the user's.

**States** (the row's button):

- **Set up** (none of Froonty's).
- **Remove** (exactly the set above, for this copy).
- **Update** (some of Froonty's, but not exactly that set: another copy of
  Froonty, an older layout, partly removed). Update replaces them.

Remove drops only Froonty's handlers, then the groups and event lists this
emptied, then `hooks` if that emptied it; a user's empty group or list
stays. It writes only if something changed. Known limitation: a file that
had `"hooks": {}` before Set up ends without that key after Remove.

Errors (the file is unreadable, not JSON, not an object, `hooks` or one of
the six event keys of the wrong type) leave the file byte-identical and are
shown in the row. The row also says when Claude Code's `disableAllHooks` is
on, and when the bar is off (the hooks then record nothing).

**How the file is written** (`statusLineSetup.js` `saveClaudeSettings()`,
shared with the status line's Set up): a whole new file renamed onto the
old one (Gio's replace), never a half-written one.

- A symbolic link (a dotfiles manager's `~/.claude/settings.json` →
  `~/dotfiles/…`) is followed, also through a chain: the file it names is
  replaced, and the link stays. GLib, given the link, would rewrite the
  file in place (truncate, then write, with no temporary file).
- A file with more than one hard link is refused, with the reason in the
  row: GLib would rewrite it in place, and a rename would cut it off from
  its other names.
- The file must not have changed since it was read: the read's entity tag
  (its modification time) goes with the write, so a save Claude Code made
  in between fails cleanly ("it changed since Froonty read it … try
  again") instead of being overwritten. Without a file at the read, one
  that appeared since is not overwritten either.
- A new file is made in place (there is nothing to lose), `0600`.

**Claude Code may drop the entries.** Reading its bundle suggests it can
save the file from its cached copy; the rows read the file again whenever
the Claude page comes on screen, and while it is on screen whenever the
file changes, so Set up can be clicked again.

## 6. The Shell side

```
features/claude/
├── attention.js         pure: constants, event → kind, the state file's
│                        format, /proc stat, project name, order, wording
├── attentionHook.js     the hook script Claude Code runs (GJS); imported
│                        by attentionSetup.js for its own path, it does
│                        nothing (it runs only as gjs's program)
├── attentionSetup.js    adds/removes Froonty's hooks in settings.json
└── attentionService.js  the model (Shell-free): state files and GNOME
                         notifications → entries
shell/
├── claudeAttention.js   ClaudeDesktop: app and window of a session, focus,
│                        raising, banners/overview, which notification
│                        sources to follow
├── messageTray.js       the message tray's adapter: createStore({filter})
└── notificationStore.js the notification store: `filter`, and
                         describe()'s `appId` (section 9)
features/claude/attentionBar.js  the St bar
```

**`AttentionService`** (`start()` / `stop()` with the island):

- `start()` makes the folder (`0700`, synchronously, once per start: it is
  on tmpfs), watches it with one `Gio.FileMonitor` (`WATCH_MOVES`), and
  lists it once.
- A file that arrives or changes is read asynchronously, at most 4 KiB
  (larger files are ignored and left). Reads of the same file fold into one
  more read. Each file is checked field by field; one that does not parse
  is left alone.
- Then, in order: Claude Code still running (`/proc/<pid>/stat`, same start
  time), else the file is deleted; a finished or error reply with "Also
  when Claude finishes" off is deleted; a Claude app session with
  "Sessions in the Claude app" on is kept but not shown; the session's app
  and window are found (below); if the user is already looking at it (its
  own window, known for sure, has the focus) and it is not a terminal's
  permission, question or idle prompt (section 3), the file is deleted and
  nothing shows.
- While at least one shown entry has a known app, the focus is followed
  (`notify::focus-window`), counting only a move to another window: the
  focus leaving the windows for the Shell (Ctrl+Alt+Tab to the bar) and
  coming back to the same one is none. Focusing a session's own window,
  known for sure, deletes its file. When its window is not known for sure,
  a permission or a question is deleted on a move to any window of its app;
  a finished reply, an error or an idle prompt stays. Each such move, and
  each end of a collapse of the island (also one cut short by a monitor or
  size change), also checks that every recorded Claude Code still runs; a
  crashed one leaves its file behind.
- Someone deleting the folder: the monitor goes (GLib would look for the
  missing path every 4 s) and the folder and monitor are made again, once
  per start.
- `stop()` keeps the files. The island removes the folder when it goes,
  unless the screen is locking (GNOME Shell disables extensions at a lock
  with `Main.sessionMode.isLocked` already set; `shell/claudeAttention.js`
  `screenLocked()`): what waits survives a screen lock, but turning
  Froonty, the island or the bar off leaves nothing for Claude Code's hooks
  to write into.

**Finding the window** (`ClaudeDesktop.resolve`, the choice in
`attention.js` `pickWindow()`): the app is the first of the recorded
processes that owns a window (`Shell.WindowTracker get_app_from_pid`: the
terminal, VS Code), else the app the `desktop` hint names. Of its windows
(not skip-taskbar, most recent first), the one whose title has a part
(split on " - ", " — ", " – ") equal to the project, else one that contains
it, else the most recent. "For sure" only when the app has one window, or
exactly one title has a part equal to the project; a title that merely
contains it (a shell's "user@host: ~/src/Froonty") is a guess. A click
raises the chosen window either way. "Looking at it" (`isLookingAt`): that
window has the focus when known for sure; otherwise, unless only the own
window may count (`exactOnly`), any window of its app.

**A click** raises the window (`Main.activateWindow`; Froonty never
starts an app) and deletes the file. For the Claude app and browsers, it
raises the app's window, if it has one, and then does what a click on the
notification does in GNOME's own list (`activate()`: the app's default
action, or GNOME opening the app, as in its list; GNOME then removes the
notification unless it is resident). **×** deletes the file; for a GNOME notification it is GNOME's
own close button (`destroy(DISMISSED)`), so it also leaves GNOME's list.

## 7. The bar

```
bar     St.BoxLayout .froonty-attention (Ctrl+Alt+Tab group root)
 ├ main  St.Button .froonty-attention-main, role NOTIFICATION
 │   └ [Spark] [kind text, bold] [place, ellipsized] [+N]
 └ close St.Button .froonty-attention-close, "Dismiss"
```

- In the island's actor tree, a vertical column under the strip holds the
  pill, then the bar; the column is as wide as the strip, so the pill stays
  centered and covers the clock as before. A hidden bar takes no room.
- One line, at most 480 px wide; the place gives way first. The pill's
  black and hairline; the Spark in Claude's clay (#d97757).
- The place: hook entries "project · app" (the window's app, else "VS
  Code", "Claude" or "Claude Code" by entrypoint); the Claude app
  "notification title · Claude" (its title is left out when it is just
  "Claude" or "Claude Code"); browsers the browser's name.
- It fades in and out (`ease()`, at most 150 ms). It hides at once when the
  island expands, and comes back once the island has collapsed.
- Keyboard: Ctrl+Alt+Tab lists it while it shows and moves the focus to
  it; Enter or Space goes there, Delete or BackSpace dismisses, Escape gives
  the focus back to the windows, as on GNOME's top bar. Its accessible name
  is "kind, place, N more".

## 8. Resources

- **Files:** one `Gio.FileMonitor` (inotify, `WATCH_MOVES`) on the state
  folder, while the island exists and the bar is on. Per state file event,
  one read of at most 4 KiB. Per recorded session, one `/proc/<pid>/stat`
  read on arrival, on each move of the focus to another window while an
  entry with a known app shows, and on each collapse of the island.
- **Signals:** the message tray's `notify::visible` and the overview's
  `showing` / `hidden` (3); `org.gnome.desktop.notifications`
  `changed::show-banners` (1); three of Froonty's settings; the tray's
  `source-added` / `source-removed` (2) while the Claude app or browsers
  are followed, plus 4 per followed source and 3 per followed
  notification (other sources: none); `global.display`
  `notify::focus-window` (1), only while a shown entry has a known app.
- **Ctrl+Alt+Tab:** one more group, listed only while the bar is mapped.
- **Timers:** none. **Subprocesses:** none by Froonty. Outside the Shell,
  after Set up, Claude Code runs the GJS hook (about 38 ms and 33 MB,
  measured on this machine; an estimate) per qualifying Notification, Stop
  and StopFailure, and `sh` (about 1.2 ms) per prompt, per model step and
  per session end.
- **Disk:** the folder (`0700`) and at most one file of 4 KiB per waiting
  session (`0600`), on tmpfs; kept through a screen lock, removed when
  Froonty, the island or the bar is turned off.

## 9. GNOME's notifications: the Notifications tab's store

The Claude app and browser entries come through the adapter and store
the Notifications tab had (`shell/messageTray.js` `gnomeNotifications()`,
`shell/notificationStore.js`), so the message tray's private objects stay
in one place. The tab was removed (the date pill opens GNOME's own list);
the bar is now the only user of both modules, which the public package
leaves out. The bar makes a store of its own, with two additive changes
to the tab's code:

- `createStore(options)` passes `{filter}` on to the store, and the store
  skips a source the filter turns down in `_addSource()`: such a source
  (any app but the Claude app, or a web browser) gets no handler at all.
- `describe()` gives `appId`, the source's app's id
  (`FdoNotificationDaemonSource` has one; other sources give null).

The bar uses what the tab's store already offers: `notifications`,
`describe()`, `plainText()` (GNOME's own markup rules), `activate()`
(GNOME's activate) and `dismiss()` (`destroy(DISMISSED)`), and follows
`'changed'` and `'notification-changed'` (a notification replaced in place
is classified again). Changing "Sessions in the Claude app" or "Browser
notifications from claude.ai" makes a new store with the new filter; with
both off there is none.

(While the tab was not yet committed, an interim observer of the same
shape was written; it was dropped when this was rebased onto the tab.)

## 10. Tests

- `tools/unit/claude-attention.test.js` (43): the event mapping, the state
  file's checks, `/proc` stat, project names, the order, the Claude app's
  wording; the hook script run as Claude Code runs it (no folder, a
  permission prompt recorded with none of Claude's text and mode `0600`, no
  temporary file left, Stop and its background work, clears, `-p` and MCP
  and remote sessions, unreadable input, 2 MiB of input, a file where the
  folder should be, bad session ids, `CHROME_DESKTOP`); Set up and Remove
  (the exact entries, byte-identical twice, the user's hooks untouched and
  restored, errors, which handlers are Froonty's, another copy's,
  `disableAllHooks`, side by side with the status line); the clear command
  under `/bin/sh`; the service with fakes for the Shell (the folder, arrival,
  replacement, deletion, two reads for a burst, a Claude Code gone, already
  looking at it, focus, the switches, click and ×, stop and removal, the
  folder deleted, GNOME notifications, the 64-entry cap).
  `tools/unit/notifications.test.js` covers the store's `filter` (no
  handler on any other source, also one added later) and `appId`.
  Every hook or `sh` run gets a private `XDG_RUNTIME_DIR` and none of
  Claude Code's variables; `CLAUDE_CONFIG_DIR` is private.
- `tools/headless-test/checks.js` `testClaudeAttention`, both session
  modes: the actor tree and placement; the real hook script end to end (the
  bar within a second, under and centered on the pill, one line, its
  accessible name); the clear command; order and "+1"; ×; "Also when Claude
  finishes"; a Claude Code that is gone; the open island, a banner, Do Not
  Disturb (default mode only), the overview; the window a session runs in
  (Froonty's settings window stands for VS Code): its app named, a click
  raising it, already focused, focusing it; Ctrl+Alt+Tab, Delete, Escape;
  real notifications posing as the Claude app (banner first, then the bar;
  the app closing it; a click; ×) and as a browser; turning the bar off and
  on (folder, handlers); disable and enable with something waiting. The
  lifecycle footprint counts the tray's `notify::visible` and the
  overview's handlers too.

## 11. Risks and known gaps

- Claude Code renames hook events or fields, or stops sending
  `worker_permission_prompt` (seen only in its bundle): the bar shows less.
- The Claude app rewords or translates its notifications: they show as
  "Claude needs your attention".
- VS Code's window title template changed: several VS Code windows are no
  longer told apart (focus does not clear; a click raises the most recent).
- Claude Code rewrites `settings.json` from its cache and drops the entries:
  the row shows "Set up" again.
- A permission can clear early: a step whose batch holds a subagent's work
  clears the main session's entry (same `session_id`; Notification carries
  no tool id).
- If the GJS write (about 38 ms) lands after a fast clear, a stale entry
  stays until focus, a click or ×.
- Terminals with several windows, tmux, multi-root VS Code workspaces: the
  window is not known for sure. tmux may not lead to an app at all; then
  the place reads "Claude Code" and a click only clears.
- No hooks run in untrusted terminal folders, with `disableAllHooks`, with
  managed hooks-only policies, or when Claude Code's `CLAUDE_CONFIG_DIR`
  differs from what Froonty's settings window sees.
- Flatpak hosts are not supported (sandboxed process ids and runtime
  folder), and Flatpak browsers notify through the portal, whose sources
  hide their app.
- Whether claude.ai sends web notifications, and whether browsers put
  "claude.ai" in them, is not known.

## 12. Verification log and manual checks

Checked for this work:

- Claude Code's docs (saved copies of code.claude.com hooks and env-vars,
  2026-10-02): handler fields, exec form, `async`, matchers, the
  Notification types table, Stop's `background_tasks` / `session_crons`,
  StopFailure, PostToolBatch, SessionEnd's budget, `CLAUDE_CODE_SESSION_ID`,
  `CLAUDE_PID` (2.1.214+), hooks inheriting the environment and running
  without a terminal.
- The installed Claude Code (read only): the VS Code extension 2.1.287 sets
  `CLAUDE_CODE_ENTRYPOINT=claude-vscode` for the Claude Code it starts; the
  CLI sets `sdk-cli` for `-p` and `cli` otherwise when nothing set it.
- GNOME Shell 50.1's JavaScript: the tray's sources and `visible`, the
  notification daemon's sources and `CloseNotification`, Ctrl+Alt+Tab
  listing only mapped groups, `Main.activateWindow`.
- This machine: `/usr/share/applications/com.anthropic.Claude.desktop`
  exists, and GNOME has a notification policy for the Claude app.

Not verified (needs a real Claude Code; agents never run it with a model
request):

1. Set up, then read `~/.claude/settings.json`: Froonty's entries exactly as
   in section 5, the status line kept.
2. VS Code, default permission mode: switch to another window while a
   permission prompt waits about 6 s. The bar shows "Claude needs your
   permission · <folder> · Visual Studio Code"; a click brings that VS Code
   window up. Before clicking, copy the state file and note whether the
   window came from the process chain or from `desktop` (Mutter's
   `get_pid()` on Wayland).
3. VS Code: a reply finishing while another window has the focus shows
   "Claude finished"; with VS Code focused, nothing.
4. Approve, and deny, a permission in VS Code: the bar clears by itself
   (`PostToolBatch` after a denial).
5. A terminal (GNOME Terminal or Ptyxis) in a trusted folder: the permission
   prompt after about 6 s without typing; `idle_prompt` about 60 s after a
   reply; the file says `"entrypoint":"cli"`.
6. The Claude app's Code tab: a permission request while viewing another
   session shows the app's own notification on the bar; viewing the session
   clears it. Write down the exact notification texts; if they differ from
   section 2, update `appNotificationKind`.
7. Optional: claude.ai's notifications in a browser, with Froonty's browser
   switch on: does GNOME's notification text contain "claude.ai"? If not,
   that source cannot work as built; do not loosen the match.
