# BAI Tracker

Dashboard, performance attribution, and entry-price education tool for **BAI**
— the iShares A.I. Innovation and Tech Active ETF (NYSE Arca, inception
2024-10-21, 0.55% expense ratio, ~54 holdings, actively managed).

> **Educational tool only.** Nothing in this app is investment advice, a
> recommendation, a forecast, or a price target. Past performance does not
> predict future results.

## Always-on website

```bash
./scripts/install-server.sh
```

Installs a launchd user agent that builds and serves the dashboard at
**http://localhost:8787** from login onward, restarting it if it dies. One
origin serves both the API and the built React bundle, so there is no dev
server to keep running and nothing to start by hand — bookmark the URL.

```bash
launchctl kickstart -k gui/$(id -u)/com.bai-tracker.server   # restart (after editing .env)
launchctl bootout    gui/$(id -u)/com.bai-tracker.server     # stop for good
tail -f briefs/server.log                                     # logs
```

Bound to `127.0.0.1` deliberately: the process holds provider API keys and
nothing needs it reachable from the LAN.

## Public link (Cloudflare quick tunnel)

```bash
./scripts/install-tunnel.sh
cat briefs/tunnel-url.txt      # the current public URL
```

Publishes the dashboard on a `https://<random>.trycloudflare.com` URL with no
Cloudflare account. Two things follow from "quick tunnel":

- **The hostname changes on every restart.** `scripts/tunnel.sh` scrapes the
  assigned name out of cloudflared's startup output and writes it to
  `briefs/tunnel-url.txt`, which is the one place to look after a reboot.
- **It only works while this Mac is awake.** For a URL that survives sleep, the
  app needs to be deployed somewhere rather than tunnelled.

### The password is not optional

The public URL is protected by HTTP basic auth (`BAI_AUTH_USER` /
`BAI_AUTH_PASS`), and `tunnel.sh` **refuses to start** if `BAI_AUTH_PASS` is
empty. The content is not secret, but the free Tiingo tier allows ~45
requests/hour — one crawler on an open URL exhausts it and the dashboard starts
showing coverage gaps instead of data. The password protects the rate limit as
much as the view.

Auth is enforced only on requests carrying Cloudflare's `CF-Ray` header, so a
local browser at `localhost:8787` is never prompted. cloudflared connects over
loopback like everything else, so source IP cannot distinguish the two — the
header can. Forging it requires the ability to reach `127.0.0.1`, which implies
local access already, and can only *add* an auth requirement rather than bypass
one. Set `BAI_AUTH_ALWAYS=1` to require credentials locally too.

## Development

```bash
npm install
npm run dev        # server on :8787, web on :5183 with HMR
```

With no API keys the app runs in **synthetic fixture mode**: a clearly-banner-ed
demo dataset so every panel and all the math is reviewable. Nothing in fixture
mode describes the real fund, and the UI says so persistently.

### Real data

```bash
TIINGO_API_KEY=...    npm run dev   # US-listed prices (free tier is fine)
EODHD_API_KEY=...     npm run dev   # adds non-US venues: SK hynix (KRX), TSMC (TWSE), …
MARKETAUX_API_KEY=... npm run dev   # adds cited news for the attribution narrative
POLYGON_API_KEY=... / ALPHAVANTAGE_API_KEY=...   # alternate market providers
BAI_FIXTURES=0                       # force-disable fixtures (auto-disabled when a key exists)
```

Provider fallback order is `tiingo, eodhd, polygon, alphavantage`
(override with `BAI_MARKET_PROVIDER_ORDER`).

## Daily brief — "what happened to BAI today"

```bash
npm run brief
```

Prints and saves `briefs/YYYY-MM-DD.md`: the fund's move, top contributors and
detractors with any cited news, the sub-theme rollup, what the manager traded,
and the data caveats. Also available at `GET /api/brief` and rendered in the app.

**This is already scheduled** to run every weekday at 17:45 local:

```bash
./scripts/install-daily.sh                                # (re)install
launchctl list | grep bai-tracker                         # verify
launchctl kickstart -k gui/$(id -u)/com.bai-tracker.daily # run it now
launchctl bootout    gui/$(id -u)/com.bai-tracker.daily   # disable
```

### Delivery

The brief is pushed as well as saved. Each channel is gated on its own config
and cannot fail the job — the markdown is on disk before delivery is attempted.

| Channel | Enable with | Notes |
|---|---|---|
| macOS notification | `BAI_NOTIFY=1` | Fires on success *and* on failure. The failure banner matters: without it a broken job is invisible, since "no brief" looks exactly like a quiet day. |
| Email | `BRIEF_EMAIL_TO`, `SMTP_USER`, `SMTP_PASS` | Gmail requires an **App Password** (Account → Security → 2-Step Verification → App passwords), not your Google password. Generate it yourself and paste it into `.env`. |

The same job archives the day's holdings file. That matters: the issuer only
ever serves *today's* file, so manager activity is only observable as the
difference between two published dates. Weight-change flags, turnover, and the
manager-effect split all activate from the second archived file onward.

## Live intraday view

The dashboard's top panel — *What's moving BAI right now* — shows, during the
US session, which holdings are pushing the fund up and down today:
`weight × today's change` per name, rolled up by sub-theme, auto-refreshing
every 2 minutes.

Two honesty rules specific to intraday:

- The fund's **quoted** move and the **holdings-implied** sum are shown side by
  side, never blended. They differ because of the quote delay, the closed
  foreign markets, and the premium/discount moving intraday.
- Each mover carries the articles published in the same window, cited with
  outlet and timestamp so you can judge whether a story plausibly *precedes*
  the move or merely reports it. Nothing generates causal language, and an
  empty result renders as "no story found", never as a guess. With no news key
  the per-row line is suppressed entirely and one banner says why.
- Non-US holdings (~24% of the fund) finished their home sessions before the US
  opened. They are listed separately as *already closed*, never mixed into the
  US-session movers.

### What "live" can and cannot mean here

Free tiers are **delayed ~15 minutes** and the UI labels every quote `DELAYED`.
To-the-second data requires paid exchange entitlements (Tiingo ~$10/mo, Polygon
~$29/mo); the Polygon adapter is already written, so only a key is needed.

Two things are inherently end-of-day regardless of spend:

- **Daily bars** — today's bar only exists after the 4pm close.
- **The holdings file** — iShares publishes as of the prior close, so a file
  dated yesterday genuinely *is* the newest one in existence.

### Request budgets

Free tiers cap requests per hour (Tiingo ~50), and a cold attribution load wants
one request per holding — enough to trip that cap. So the app caches one full
history per symbol and slices windows locally (timeframe switching is free),
batches all intraday quotes into a single request, and tracks spend in a
persistent ledger (`server/data/rate-ledger.json`), refusing locally when the
budget is gone and reporting when it resets. Exhausting the budget yields
partial coverage with the gap stated — never wrong numbers. Check it at
`GET /api/health`.

## Data sources & refresh cadence

| Field | Source | Cadence / TTL | Notes |
|---|---|---|---|
| Holdings, weights | iShares `latest-holdings.csv` (product 339081) | Daily, 6h TTL | The stable per-fund CSV behind the product page's Download button. Note this is **not** the widely-cited `.ajax?fileType=csv` endpoint, which answers with the product page's HTML under a `text/csv` content-type; the adapter sniffs the body and fails loudly rather than parsing that into "zero holdings". |
| Daily bars | Tiingo / EODHD / Polygon / AlphaVantage | 6h TTL; **24h for foreign venues** | Adjusted closes. One full history cached per symbol, windows sliced locally. Foreign bars refresh daily: KRX/TWSE/TSE close before the US opens, so re-asking mid-session returns the same bar, and only EODHD resolves those venues on a ~20-request/day free tier. Polygon is split-adjusted only (no dividends) — ranked last-but-one by default for that reason. |
| Quotes | same chain, batched | 120s TTL | Labelled DELAYED unless a real-time-entitled provider is configured. All holdings in one request. |
| NAV, premium/discount | none configured | — | Requires an ETF-NAV-aware feed. Shown as unavailable, **not** approximated from price. |
| News | Marketaux | 15m TTL | Only used to *cite* coincident articles — never to invent a driver. |
| Fund facts (ER, inception) | Static prospectus facts | — | AUM/P/E/distributions are shown only when a source supplies them; they are not hardcoded to rot. |

All fetches are cached to disk (`server/data/cache`) with stale-on-error: a
provider outage serves the last good copy, visibly labelled STALE, rather than
nothing — but staleness is never hidden.

## Design rules that shape the code

1. **No naked numbers.** Every externally-sourced value is a `Sourced<T>`
   carrying provenance (source, as-of, reliability). Absence is representable
   and renders as an explicit empty state with the reason. There is no code
   path that substitutes a plausible default.
2. **Math before narrative.** The narrative layer receives only computed
   results and fetched articles; it cannot query anything. Causal language is
   never generated — moves "coincide with" cited, timestamped articles, and
   when nothing is found the UI says "no clear driver identified".
3. **Synthetic infects.** Fixture provenance propagates through every derived
   value; if any input was synthetic, the output is marked synthetic and the
   banner shows. Demo data cannot launder itself into looking real.
4. **Suppression over false precision.** Beta split hides its interpretation
   below R² 0.5; spread/median ratio hides on a near-zero denominator; the
   manager-effect panel says "needs two archived files" instead of guessing.

## Attribution methodology

- Contribution = **start-of-window weight × holding return** (end weights
  double-count winners). Σ contributions ≠ fund return exactly; the residual
  (drift + intra-window trading + fee drag) is displayed, not scaled away.
- Sub-theme rollups (semis / memory / hyperscalers / software /
  infrastructure) use an inspectable rule table (`domain/subthemes.ts`), one
  bucket per name, so rollups partition exactly.
- Beta vs QQQ: OLS on ~120 aligned trading days; `systematic = β ×
  benchmark return` uses the same window-anchoring as the headline return, so
  systematic + idiosyncratic reconciles to the displayed number exactly.
- Manager effect = actual return − frozen start-weight portfolio return, plus
  the holdings diff (adds/removes/resizes) between archived issuer files.
- **Foreign staleness:** KRX/TWSE/TSE/HKEX close 5.5–14.5h before the US
  close. On 1-day windows those holdings (SK hynix is the fund's largest) are
  flagged per-row and counted in a caveat; their same-day contribution
  reflects the prior local close and the attribution says so.

## Entry-price education

- Horizon dispersion evaluates *every* historical entry day. The honest
  finding: raw best-vs-worst spread **widens** with horizon; what shrinks is
  spread **per year held** and spread relative to the typical outcome. The UI
  leads with those.
- Horizons longer than BAI's history use a clearly-labelled QQQ proxy row —
  visually separated, never presented as BAI.
- Lump-sum vs DCA shows full outcome distributions (p5/p25/median/p75/p95),
  not averages, over every historical start date.
- Execution costs (spread, premium/discount, open/close timing, limit orders)
  are presented as the part of "does price matter" that is real at any
  horizon. With no NBBO source configured the spread panel says "measure it at
  your broker" rather than inventing a number.
- Concentration scenarios are stated arithmetic (`weight × assumed shock`),
  with the basis printed on each row.

## Layout

```
server/src/
  util/provenance.ts      Sourced<T> envelope — the no-fabrication mechanism
  providers/ishares.ts    issuer CSV adapter + bot-wall detection
  providers/market/       Tiingo / EODHD / Polygon / AlphaVantage chain
  providers/news/         Marketaux (citation-only)
  store/holdingsHistory   append-only daily snapshot archive + diffing
  analytics/              returns, beta, attribution, concentration, entry-price
  narrative/              claims + citations, no causal language
  deliver/                brief fan-out: macOS notification + email, each
                          independently gated, neither able to fail the job
  fixtures/synthetic.ts   labelled demo world (fund built FROM holdings so
                          attribution reconciles in demo mode)
web/src/                  React dashboard; one timeframe state drives chart,
                          ranking and narrative together
scripts/                  install-server.sh (always-on site), install-daily.sh
                          (17:45 brief), serve.sh, daily.sh
```

`npm test` runs the engine test suite (23 tests: anchoring, reconciliation,
staleness, parser guards, dispersion math).
