# Feature: Widgets

Status: **first iteration, implemented**, 2026-11-07.

The Widgets tab surfaces compact desktop and island widgets: a Markets card
of stock index graphs (below) and a Horizon briefing reader. The Horizon
module it looks for dated Markdown summaries in a
Horizon data directory and shows the newest headlines in the island. When enabled,
Froonty can also pin the Horizon widget to the desktop background layer.

## Rules it follows

- **Opt-in.** `widgets-enabled` is off only when the user turns the tab off.
- **Background work stays isolated.** Horizon refreshes run as a detached
  subprocess and watch the summary directory using `Gio.FileMonitor`.
- **No blocking on the composition thread.** Summary parsing is done in async
  file loads, and the widget only renders the latest items.

## Configuration

- `widgets-enabled`: show the Widgets tab.
- `widgets-news-pin-desktop`: pin the Horizon card to the desktop background.
  Desktop cards (`desktopLayer.js`) are an extension part: each exists
  while its pin switch and `widgets-enabled` are both on, whether or not
  the tab was opened. They sit in one column on GNOME's background actor
  group at the top left of the primary monitor's work area, Markets first,
  and share their services with the tab (`news/shared.js`,
  `markets/shared.js`). With Desktop Icons NG on, its transparent window
  covers the desktop, so clicks may go to it instead of the card (not yet
  tested).
- `widgets-markets-enabled` (on), `widgets-markets-pin-desktop` (off),
  `widgets-markets-symbols`, `widgets-markets-range` (`1d`): the Markets
  card (below).
- `horizon-repo-path`: local Horizon checkout used for refreshes.
- `horizon-data-dir`: custom state directory used by Horizon.
- `horizon-ai` (`local`): which AI writes the briefings (below).
- `horizon-ai-provider` (`anthropic`), `horizon-ai-model` (empty: Horizon's
  default for the provider): with an API key.
- `horizon-chatgpt-model`, `horizon-chatgpt-account`: with a ChatGPT plan.

## Markets (Settings → Widgets → Markets)

Added 2026-11-20 (user request: index graphs in one widget, without paying
for an API). Per index: its name, a sparkline of the span with the
previous close dashed, the last value and the change since the previous
close. A row opens the index's Yahoo Finance page.

| Source | Used | Notes |
|---|---|---|
| Yahoo Finance chart endpoint (`query1.finance.yahoo.com/v8/finance/chart/<symbol>`) | First, for every symbol | Unofficial and keyless; any Yahoo symbol, intraday bars for `1d` (5 min) and `5d` (30 min). Today's daily bar has no close until the session ends, so the line ends at the live price. Yahoo's own message (an unknown symbol) is shown as is. |
| FRED API (`api.stlouisfed.org/fred/series/observations`) | When Yahoo fails, for `^GSPC`, `^IXIC`, `^DJI` (`SP500`, `NASDAQCOM`, `DJIA`) | Official, free with a key kept in the keyring (Secret Service: schema `org.gnome.shell.extensions.froonty.Markets`, attribute `service=fred`); daily closes only. FRED's keyless `fredgraph.csv` was tried on 2026-11-20: it dropped connections whose User-Agent named Froonty (or a browser without its other headers) and let only known tools through, so it is not used. |
| The last good reading | When both fail | Marked "not updated". The readings are also kept in `$XDG_CACHE_HOME/froonty/markets.json`, shown at start until the first refresh ends, for the same span only. |

`MarketsService` (`markets/service.js`) runs while the tab's Markets card
or the desktop card holds it (`markets/shared.js`). It asks for one symbol
at a time, every 5 minutes while a market in the list is in its regular
session, every 30 otherwise, and again at once when the symbols or the
span change. The readers are pure (`markets/sources.js`) and tested with
the service on a fake fetch (`tools/unit/widgets-markets.test.js`).

## AI for Horizon (Settings → Widgets)

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
(`### [Title](url) ⭐️ 8.0/10`, then a paragraph, of which the first
sentence is shown) as well as plain `- [Title](url) — summary` lists. On
2026-11-14, Hacker News with `qwen3:4b-instruct-2507-q4_K_M` took about
2 minutes and 52k tokens for 9 stories.

In the devkit, the keyring is the sandbox's own: its session bus starts one,
which may ask for a password the first time.

## Intended workflow

1. Run `make horizon-setup`. It installs Horizon's dependencies in a
   copy-based Python environment, `~/.cache/horizon-venv`, not inside the
   submodule, whose filesystem may not allow symlinks. The session and the
   devkit both use it. Froonty also finds one left in the devkit's cache
   (`~/.cache/froonty-devkit/cache/horizon-venv`), where it went before.
   It no longer runs the wizard.
2. Choose the AI in Settings → Widgets (default: this computer's model).
3. Start the devkit with `make devkit`, then select **Refresh** in the
   Widgets tab. The tab updates when the summary is written.

`make horizon-wizard` is optional: Horizon's own wizard picks sources by
interest. Its AI step still has to be answered, and that answer is
replaced unless the AI is set to "Horizon's own setting".
`horizon-repo-path` and `horizon-data-dir` remain available for custom
installations.
