# Feature: Markets

Status: **implemented**. Index graphs added 2026-11-20 inside Widgets
(user request: index graphs in one widget, without paying for an API).
Since 2026-11-23 a feature of its own, with live prices (owner: "I want
to be updated at least one minute, and if possible with free of charge,
every 30, 15, or 1 seconds"; "The most important are stocks, then
indexes"; "If something fails, we should have backup to Yahoo, then
FRED"; "make Markets a standalone feature … Only the visuals should be
configured from Widgets").

Code: `froonty@catalin/features/markets/`. The card shows in the Widgets
tab and on the desktop ([widgets.md](widgets.md)); it is not a hub tab.

## 1. Settings

Settings → Markets (`prefs.js`):

- `markets-enabled` (on): off, the card shows neither in the Widgets tab
  nor on the desktop, and nothing is fetched. The Widgets page's Markets
  group is dimmed then.
- `widgets-markets-symbols` (`^GSPC`, `^IXIC`, `^DJI`, `^GSPTSE`): any
  Yahoo Finance symbols, up to 30 (`sources.js` `chosenSymbols` trims
  them, drops repeats in any case and keeps the first 30, as many as
  Alpaca's free plan streams). Stocks (`AAPL`), ETFs (`SPY`), mutual funds
  (`VFIAX`), indexes (`^GSPC`), crypto (`BTC-USD`), futures (`GC=F`),
  currencies (`EURUSD=X`), yields (`^TNX`), other exchanges (`SHOP.TO`,
  `VWCE.DE`). The key keeps its `widgets-` name (owner, 2026-11-20: keep
  setting keys).
- `markets-live` (on): live prices (§3).
- Alpaca's key ID and secret key: in the keyring, never in GSettings
  (`keys.js`; Secret Service schema
  `org.gnome.shell.extensions.froonty.Markets`, one JSON item with
  attribute `service=alpaca`). On saving, Settings asks Alpaca for SPY's
  latest IEX trade with them (`/v2/stocks/trades/latest`) and says whether
  Alpaca accepts them. A free paper-trading account's keys are enough;
  Alpaca's docs say paper trading is open worldwide.
- FRED's key: the same schema, `service=fred`.

Settings → Widgets → Markets: "Show Markets in the Widgets tab"
(`widgets-markets-enabled`) and "Graph span" (`widgets-markets-range`,
`1d`). The desktop card: Settings → Widgets → On the desktop.

## 2. The card

Per symbol, left to right (owner's order, 2026-11-23): the last value
with the change under it, the name with the reading's time, and a
sparkline of the span. A row opens the symbol's Yahoo Finance page.

The change is measured over the span the graph shows, from the level
dashed across it (owner, 2026-11-23: "+17.44% … it is not clear from
when"). That level is yesterday's close for "Today", else the close just
before the span (Yahoo's `chartPreviousClose`; its first close without
it). The header says it once for every row, e.g. "Change over 6 months".
Before, longer spans compared with yesterday's close, so a six-month
graph sloping down could show +17%.

The line under the name: the time (with seconds while the price is
live), "Open" in green or "Closed" dimmed by the market's session
(`marketState`; crypto is always open; FRED's rows say neither), then
where the price comes from: "Alpaca live (IEX)", "Coinbase live",
"Yahoo" or "FRED daily close" (owner, 2026-11-23: every row says its
source); "not updated" when the last fetch failed and no live price came
since. A stream that is down says why in yellow
under the header ("Alpaca: auth failed").

A live price updates only its row, in place (`view.js` `_syncLive`): the
service collects the prices and emits `live` with the changed symbols at
most once a second (`LIVE_FLUSH_MS`).

## 3. Sources, in order

Each stands in when the one before it fails (`service.js`):

| Source | For | Notes |
|---|---|---|
| Alpaca's stream (`wss://stream.data.alpaca.markets/v2/iex`) | US stocks and ETFs, with keys, in the regular session | Free plan: the trades on IEX, one US exchange, so a quiet stock may not move for a while and the price may differ a little from the consolidated one; up to 30 symbols, one connection. |
| Coinbase's stream (`wss://advanced-trade-ws.coinbase.com`, `ticker`) | Crypto pairs, all week | Public market data, no key. A pair Coinbase lacks is left out silently. |
| Yahoo Finance chart endpoint (`query1.finance.yahoo.com/v8/finance/chart/<symbol>`) | Every symbol: the graph, the name, the session and the close the change is measured from; the price when no stream has it | Unofficial and keyless; intraday bars for `1d` (5 min) and `5d` (30 min). Today's daily bar has no close until the session ends, so the line ends at the live price. Yahoo's own message (an unknown symbol) is shown as is. |
| FRED API (`api.stlouisfed.org/fred/series/observations`) | When Yahoo fails, for `^GSPC`, `^IXIC`, `^DJI` (`SP500`, `NASDAQCOM`, `DJIA`) | Official, free with a key; daily closes only. FRED's keyless `fredgraph.csv` was tried on 2026-11-20: it dropped connections whose User-Agent named Froonty (or a browser without its other headers) and let only known tools through, so it is not used. |
| The last good reading | When all fail | Marked "not updated". The readings are also kept in `$XDG_CACHE_HOME/froonty/markets.json` (without the live mark), shown at start until the first refresh ends, for the same span only. |

A live price goes on top of the symbol's Yahoo (or FRED, or cached)
reading (`sources.js` `applyTick`): the price, its time and the change
from the same baseline; on the graph it moves the last point while in the
same bar, else adds a point. A price older than the reading changes
nothing, and when Yahoo's newer reading comes, the last live price is put
on it again if it is newer still. Without any reading (Yahoo down at the
first start, nothing cached), the live price alone shows, without a
change (`tickReading`).

Which stream a symbol takes (`streamRoute`): by Yahoo's
`instrumentType` and `exchangeTimezoneName` when its reading has them
(`EQUITY` or `ETF` in `America/New_York` → Alpaca; `CRYPTOCURRENCY` →
Coinbase), else by the symbol's shape (one to five letters, a share
class after a hyphen as in `BRK-B`, which Alpaca names `BRK.B`; a pair
such as `BTC-USD`). Five letters ending in X are US mutual funds: one
price a day and not on IEX, so not streamed.

A US stock's live price counts only in the regular session
(`liveAllowed`), so the after-hours trades IEX also sends do not pass for
the close: by Yahoo's session while its reading is fresh (it knows
holidays and early closes), else 9:30 to 16:00 on a weekday in New York
(`usRegularSession`; holidays unknown).

Measured 2026-11-23 from this machine: Coinbase's `ticker` sent BTC-USD
several updates a second; Alpaca answers `[{"T":"success","msg":"connected"}]`
on connect and `[{"T":"error","code":402,"msg":"auth failed"}]` for bad
keys, and keeps the connection open after that, so Froonty closes it.

## 4. Streams

`live.js` `LiveStream`: one WebSocket per source (libsoup 3), open while
it has symbols, subscribed to them as they change (`setSymbols` sends
only the difference). Alpaca: the auth message, then the subscription
once it answers `authenticated`. Coinbase: `heartbeats` at once (it
closes a connection that subscribes to nothing, or a quiet one), then
`ticker`. Soup pings every 20 s and drops a connection that answers none
in 30 s. After a drop it opens again after 2 s, doubling up to 5 min,
back to 2 s once prices arrive. Alpaca's 402 (auth failed) and 409
(insufficient subscription) stop it until the keys change; 401, 404 and
406 (connection limit, another client with the same keys) end the
connection and it tries again later.

`MarketsService._syncStreams` runs after each refresh: each stream gets
the symbols that take it and whose market is open now; Alpaca only with
keys (looked up each time, so keys saved in Settings are used from the
next refresh). A stream without symbols closes, so Alpaca's connection
is open only in US trading hours.

## 5. Refreshes

`MarketsService` runs while the tab's Markets card or the desktop card
holds it (`shared.js`). It asks Yahoo for one symbol at a time. Every
symbol is fetched at start and when the symbols, the span or the live
switch change. Otherwise only the symbols that are due are (owner's
request 2026-11-23: no refresh while a market is closed; `sources.js`
`isDue`, `nextCheckDelay`):

- while its market is in its regular session (Yahoo's
  `currentTradingPeriod.regular`): every minute; every 5 minutes while its
  stream is live (only the graph is new then); every 30 minutes for a
  mutual fund. Counted from its last fetch, a tenth early, so the symbols
  one refresh fetched one after another stay together;
- once just after the session ends, for the closing price;
- then not until it should open again (`expectedOpen`): the session's
  start if it is still ahead, else the same time on the next weekday in
  the exchange's time zone (Yahoo's `gmtoffset`). On a holiday Yahoo
  still gives the last session at that check, so the day after is tried.
  A daylight-saving change may make the guess an hour off; that check
  then finds the session Yahoo gives;
- without a reading, after an error, or without a session (FRED's daily
  closes), every 30 minutes.

Crypto has no session (Yahoo gives it one day long; `continuous`), so it
counts as always open.

## 6. Tests

`tools/unit/markets.test.js`: the readers, routes, sessions, live prices
on readings, both protocols' messages (Coinbase's as it sent them on
2026-11-23), `LiveStream` on a fake socket (auth, subscriptions, a drop
and its retry, wrong keys), and the service on a fake fetch, clock and
streams. Headless (`tools/headless-test/checks.js`
`testDesktopMarketsRows`): the desktop card's rows and the Open/Closed
mark.

Not tried yet: Alpaca with real keys (no account here), and the card in a
running Shell with live prices.
