# Feature: Horizon

Status: **implemented**. A briefing reader in the Widgets tab since
2026-11-07; a feature of its own since 2026-11-23 (owner: "Make the
latter a stand alone feature like in the case of Markets").

Horizon (the `third_party/Horizon` submodule) gathers news from the sources it
follows and has an AI write a briefing of the best items, as dated
Markdown files in its data directory. Froonty runs it on request and
shows the latest briefing's items as a card in the Widgets tab and on the
desktop ([widgets.md](widgets.md)). It is not a hub tab.

Code: `froonty@catalin/features/horizon/`: `horizonService.js` (reads the
latest summary, runs Horizon), `shared.js` (one service for the tab, the
desktop card and the panic button), `view.js` (`HorizonView`, the card),
`parser.js`, `horizonAi.js`, `horizonSecret.js`, `aiPrefs.js`,
`prefs.js`.

## 1. Settings

Settings → Horizon (`prefs.js`):

- `horizon-enabled` (on): off, the card shows neither in the Widgets tab
  nor on the desktop, and Horizon is not run.
- `horizon-repo-path`: local Horizon checkout used for refreshes.
- `horizon-data-dir`: custom state directory used by Horizon.
- `horizon-ai` (`local`): which AI writes the briefings (§4).
- `horizon-ai-provider` (`anthropic`), `horizon-ai-model` (empty:
  Horizon's default for the provider): with an API key.
- `horizon-chatgpt-model`, `horizon-chatgpt-account`: with a ChatGPT
  plan.

Settings → Widgets → Horizon: "Show Horizon in the Widgets tab"
(`widgets-news-enabled`). The desktop card: Settings → Widgets → On the
desktop (`widgets-news-pin-desktop`). The keys keep their `widgets-news`
names (owner, 2026-11-20: keep setting keys), as does the card's id in
the desktop placement (`news`).

## 2. Rules it follows

- **Background work stays isolated.** Horizon runs as a subprocess, and
  the summary directory is watched with `Gio.FileMonitor`.
- **No blocking on the composition thread.** Summary parsing is done in
  async file loads, and the card only renders the latest items.

## 3. Refresh

A refresh runs Horizon for a new briefing: the card's Refresh button in
the tab (the desktop card has none, owner's choice), or the Refresh
Horizon panic button ([panic-buttons.md](panic-buttons.md)). The panic
button holds the service for the run (`shared.js` `refreshHorizon`), so
it also works while no card shows Horizon; the card shows the briefing
when it next opens. A card made during a run says so (`service.refreshing`).
The last run's problem is kept (`horizonError`) for the panic button's
tooltip, until the next run starts.

## 4. AI for Horizon (Settings → Horizon)

Added 2026-11-13 (user request: use the laptop's model without the wizard's
steps, else an API key or a ChatGPT plan, all from Settings). Before each
refresh Froonty writes the `ai` part of Horizon's `config.json` in the data
directory (`horizonAi.js`). The rest of the file stays as it is, and so do
the user's `temperature`, `max_tokens`, `languages` and concurrency values.
Without a `config.json`, Froonty writes a starter one, as Horizon's wizard
does when no source is chosen: Hacker News, the last 24 hours, its three
profiles, English.

| Choice | `ai` written | Needs |
|---|---|---|
| **This computer** (default) | `ollama`, Writing's model (`writing-ollama-model`), `http://127.0.0.1:11434/v1`, no key | A model chosen or downloaded in Settings → Writing. Froonty's own Ollama is started if it is stopped (`startOwn`, as Writing's first click does); a model that isn't downloaded is reported. Text stays on this computer. |
| **ChatGPT plan** | `openai-chatgpt`, the chosen model, the account's client ID | "Sign in" runs Horizon's `horizon-chatgpt login --enable-plan --no-browser` and opens the address it prints. Horizon keeps the sign-in in its own folder (`$XDG_CONFIG_HOME/horizon/chatgpt`), and the model list comes from `horizon-chatgpt models`. Requests count toward the ChatGPT plan's usage. |
| **API key** | the provider, its model, the variable Horizon reads the key from | The key is kept in the keyring (Secret Service: schema `org.gnome.shell.extensions.froonty.Horizon`, attribute `provider`), never in GSettings or `config.json`. It is set in Horizon's environment only for the refresh (`horizonSecret.js`). Providers: Anthropic, OpenAI, Gemini, DeepSeek, Alibaba Qwen, MiniMax, Doubao. A Claude plan can't be used: Horizon's Anthropic option needs a Console API key, billed separately from the plan. |
| **Horizon's own setting** | nothing | A `config.json` from `make horizon-wizard`. |

Horizon runs from its repository folder: it finds its profiles from there,
and it keeps a copy of each briefing for GitHub Pages in `docs/_posts`,
which its `.gitignore` covers. The tab reads Horizon's own briefing format
(`### [Title](url) ⭐️ 8.0/10`, then a paragraph, shown in 3 lines
and cut with "…"; `ui/linesLabel.js` caps it as GNOME's notifications
do) as well as plain `- [Title](url) — summary` lists. Titles and text
are read as plain text: Horizon's backslash escapes (`&\#x27;`, `\(`) and
HTML entities are decoded, links keep only their text, and bold and code
marks go (`parser.js` `plainText`). Titles wrap without "…": a scroll
view gives its content the minimum height, and an ellipsizing label's
minimum is one line, which is why both used to show one line;
`linesLabel` makes 3 lines the summary's minimum
(`testWidgetsNews` measures both). The desktop card has no Refresh
button (owner's choice); Refresh is in the tab. On 2026-11-14, Hacker
News with `qwen3:4b-instruct-2507-q4_K_M` took about 2 minutes and 52k
tokens for 9 stories.

In the devkit, the keyring is the sandbox's own: its session bus starts one,
which may ask for a password the first time.

## 5. Card

On the desktop and in the tab: the latest briefing's first 6 items, each
its title and its text in 3 lines (§4). A headline opens its page
(`widgets-desktop-actions` on the desktop).

## 6. Intended workflow

1. Run `make horizon-setup`. It installs Horizon's dependencies in a
   copy-based Python environment, `~/.cache/horizon-venv`, not inside the
   submodule, whose filesystem may not allow symlinks. The session and the
   devkit both use it. Froonty also finds one left in the devkit's cache
   (`~/.cache/froonty-devkit/cache/horizon-venv`), where it went before.
   It no longer runs the wizard.
2. Choose the AI in Settings → Horizon (default: this computer's model).
3. Start the devkit with `make devkit`, then select **Refresh** in the
   Widgets tab, or click the Refresh Horizon panic button. The card
   updates when the summary is written.

`make horizon-wizard` is optional: Horizon's own wizard picks sources by
interest. Its AI step still has to be answered, and that answer is
replaced unless the AI is set to "Horizon's own setting".
`horizon-repo-path` and `horizon-data-dir` remain available for custom
installations.

## 7. Tests

`tools/unit/horizon.test.js`: the parser and `horizonAi.js`. Headless
(`tools/headless-test/checks.js`): `testWidgetsNews` (3-line texts, whole
titles) and `testCardPanicButtons` (the panic button's menu).
