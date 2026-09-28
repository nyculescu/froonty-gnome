# How Froonty features are built

Status: **agreed** (2026-09-28). Decisions for the first features: calendar
events come from GNOME's Evolution Data Server; features are switched by an
icon tab row; notes are Markdown files. See `docs/features/`.

The goal is that the tenth feature is as easy to read, test and remove as
the first one. Every rule below exists to stop one specific kind of bloat.

## 1. Anatomy of a feature

Each feature lives in its own folder and nowhere else:

```
froonty@catalin/features/<id>/
├── index.js      descriptor: id, title, icon, settings key, factories
├── service.js    data and logic; NO St/Clutter imports; start()/stop()
├── view.js       St UI for the hub; renders the service; destroy()
├── prefs.js      its settings tab (Adw.PreferencesPage), if any
└── *.js          further small modules if needed (e.g. a parser)
```

- **Service** (`service.js`) owns data, I/O and GNOME/D-Bus access. It knows
  nothing about St, so it can be unit-tested with plain `gjs`, without a
  Shell. It extends `core/emitter.js` (not the Shell's `EventEmitter`, which only
  loads inside the Shell) and emits `'changed'`. Views keep the handler ids and
  disconnect them in `destroy()`. Its lifecycle is
  `start()` / `stop()`, and `stop()` must release everything `start()`
  created.
- **View** (`view.js`) only renders what the service exposes and turns user
  input into service calls. It never does I/O itself. Its lifecycle is
  constructor / `destroy()`.
- **Descriptor** (`index.js`) is the only file the Shell side imports (listed
  in `features/registry.js`). The settings tab (`prefs.js`) is imported only
  by the top-level `prefs.js`, which runs in a separate GTK process that
  cannot load St modules, so it is never referenced from the descriptor.
  A descriptor declares:

  ```js
  export default {
      id: 'calendar',
      get title() { return _('Calendar'); },   // lazy: see below
      icon: 'x-office-calendar-symbolic',
      enabledKey: 'calendar-enabled',          // GSettings boolean
      hubSize: {width: 720, height: 360},      // logical px, preferred
      createService: ctx => new CalendarService(ctx),
      createView: (ctx, service) => new CalendarView(ctx, service),
  };
  ```

- Translated strings in a descriptor must be **getters**: GNOME Shell's
  `gettext` fails while extension modules are still being imported.
- `ctx` is the only way a feature reaches shared things: `ctx.settings`
  (Gio.Settings), `ctx.dataDir` (a Gio.File), `ctx.openUri(uri)`,
  `ctx.collapse()`. Features never import `Main` or another feature.

## 2. The hub

The expanded island becomes a small host with no feature logic of its own:

```
┌────────────────────────────────────────────────────────┐
│  [🕒] [📅] [📝]                                    ⚙️  │  ← icon tab row
├────────────────────────────────────────────────────────┤
│                  active feature's view                 │
└────────────────────────────────────────────────────────┘
```

- `ui/hub.js` (the host) builds the menu from the enabled descriptors. It
  creates a feature's **view lazily**, on its first selection, and destroys
  the views when the island is disabled.
- The island animates to the active feature's `hubSize` when switching.
- The last selected tab is remembered in GSettings (`hub-last-tab`).
- A **service starts lazily**, the first time its view is shown, and stops
  when the feature is disabled or the island is torn down. A service may
  pause work while its view is hidden (`service.setActive(bool)`), e.g. to
  stop listening for live updates it does not need. Views get the same call
  (`view.setActive(bool)`), e.g. to take the key focus when shown.

## 3. Rules

| Rule | Prevents |
|---|---|
| A feature touches only its folder, `ctx`, and `core/`. Features never import each other. | Hidden coupling; features that cannot be removed |
| Code moves to `core/` only when a **second** feature needs it ("rule of two"). | Premature frameworks |
| Private GNOME Shell APIs only in `shell/` adapters, listed in DESIGN.md §6.3. | Silent breakage on Shell updates |
| No synchronous I/O or D-Bus on the compositor thread; Gio async only. | UI stalls of the whole desktop |
| No polling unless the design note justifies it; the interval is configurable, and polling stops while hidden. | Wasted CPU, battery and network |
| Files should stay under ~250 lines of code (comments excluded; they explain GNOME behaviour and are welcome) and functions short; split by responsibility, not by size alone. | God files |
| Every feature has an `<id>-enabled` key; disabled means **nothing is created**. | Paying for unused features |
| No new runtime dependency without a line in the design note and a clear message in the UI when it is missing. | Mysterious breakage on other machines |
| User data lives in `ctx.dataDir` (under `$XDG_DATA_HOME/froonty/`) or in the service that owns it (e.g. EDS); never in GSettings. | Settings used as a database |

## 4. Process for each feature

1. **Design note**: a short section in `docs/features/<id>.md` covering the
   goal, data sources, GNOME facilities reused, any private APIs, resource
   use and open questions. The user answers the open questions *before*
   code is written.
2. **Service first**, with unit tests (`tools/unit/<id>*.test.js`, plain
   `gjs -m`, no Shell, run by `make unit` with a private `TMPDIR` and
   `XDG_DATA_HOME`): logic, parsing, date math, file I/O.
3. **View**, then the **prefs tab**.
4. **Headless Shell checks** in `tools/headless-test/`: (the hub itself is
   tested with a fake feature added to the registry at runtime; see
   `testHub` in `checks.js`)
   - the feature appears, can be selected and renders
   - disabling it creates nothing
   - the footprint is unchanged after disable
   - screenshots are taken
5. **Definition of done**:
   - the headless suite passes in the default and Ubuntu modes
   - unit tests pass
   - there are no warnings in the Shell log
   - the screenshots have been looked at
   - DESIGN.md is updated for any new API
   - the commit is small and focused
