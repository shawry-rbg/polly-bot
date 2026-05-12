# Polymarket Weather Trading Bot

Node.js / TypeScript trading automation for Polymarket daily temperature markets. The bot fuses multi-region weather forecasts (NWS for US cities, Open-Meteo for international cities) with Polymarket CLOB pricing: it maps each city's forecast max temperature to the matching market bucket, then either prints read-only signals, paper-trades against a local JSON ledger, or posts real CLOB limit orders.

## Overview

For each configured city, the bot:

1. Pulls a daily-max forecast for the next few days from the right weather provider.
2. Looks up the matching Polymarket "Highest temperature in {city} on {date}" event.
3. Finds the temperature bucket (Yes/No market) whose range contains the forecast.
4. Compares the YES price to `ENTRY_THRESHOLD` and `EXIT_THRESHOLD` and acts according to the selected mode.

Everything is driven by `.env` at runtime; there is no `config.json` in the primary flows.

---

## Key features

- **Multi-region weather data**: NWS observations + hourly forecasts for US cities (°F), Open-Meteo `temperature_2m_max` (with `timezone=auto`) for international cities (°C). The provider, coordinates, and temperature unit are declared per city in `src/nws.ts` (`LOCATIONS`).
- **Unit-safe bucket matching**: each city declares `tempUnit` (`F` or `C`); the parser tags every Polymarket bucket question with its own unit, and the strategy only matches buckets whose unit equals the city's. °F and °C markets are never cross-matched.
- **Three execution modes**:
  - `signal` (dry-run) — no orders, no state changes.
  - `paper` (`--live`) — simulated PnL written to `simulation.json`.
  - `execute` (`--execute`) — real CLOB limit orders on Polygon.
- **Proxy wallet support**: MetaMask signer with Polymarket proxy/Safe funder via `USE_PROXY_WALLET=true` and `SIGNATURE_TYPE=2`. Signature types 0 (EOA), 1 (Polymarket proxy/Magic), 2 (Gnosis Safe) all supported.
- **Live wallet check**: before any `execute` run the bot reads pUSD collateral via the CLOB `getBalanceAllowance` endpoint (with a Polygon `eth_call` fallback) and prints the current wallet balance.
- **Loop mode**: `--interval N` runs the strategy every N minutes until Ctrl+C; `npm run trade` is a 30-minute live preset.

## Architecture

### Technology stack

- **Runtime**: Node.js 18+, TypeScript 5
- **Chain**: Polygon (chainId 137)
- **Execution**: Polymarket CLOB V2 via `@polymarket/clob-client-v2`
- **Signing**: `@ethersproject/wallet` (EOA / proxy / Safe)
- **Weather data**: `api.weather.gov` for US cities; `api.open-meteo.com` for international cities (no API key required)
- **Markets**: `gamma-api.polymarket.com` for event + price lookup; CLOB for orders and balances
- **CLI / output**: `yargs`, `chalk`, `sleek-pretty` (boxed status panels)
- **Config**: `.env` only for the primary flows

### System flow

```
Weather forecast (NWS / Open-Meteo) + city list
  → Polymarket event for date (gamma-api)
    → Map daily-max temp to bucket (unit-aware)
      → Compare YES to ENTRY_THRESHOLD / EXIT_THRESHOLD
        → Signal | Update simulation.json | Place CLOB limit order
```

## Installation

### Prerequisites

- Node.js 18+ and npm
- Outbound network access to `api.weather.gov`, `api.open-meteo.com`, `gamma-api.polymarket.com`, `clob.polymarket.com`, and `polygon-rpc.com`
- For live mode: a wallet funded with **Polymarket USD (pUSD)** collateral on Polygon and CLOB trading allowance set up, with the keys provided only via environment variables

### Setup

1. **Clone the repository and enter the directory**

   ```bash
   git clone <repository-url>
   cd Polymarket-Weather-Bot
   ```

2. **Install dependencies**

   ```bash
   npm install
   ```

3. **Configure environment**

   ```bash
   cp .env.example .env
   ```

   Edit `.env`. Example:

   ```env
   POLYMARKET_PRIVATE_KEY=0xYOUR_METAMASK_PRIVATE_KEY
   POLYMARKET_PROXY_WALLET_ADDRESS=0xYOUR_POLYMARKET_PROXY_WALLET
   USE_PROXY_WALLET=true
   SIGNATURE_TYPE=2
   ENTRY_THRESHOLD=0.15
   EXIT_THRESHOLD=0.45
   MAX_TRADES_PER_RUN=5
   MIN_HOURS_TO_RESOLUTION=2
   LOCATIONS="nyc,london,hong-kong,seattle"
   ```

4. **Credentials**

   For live trading, double-check the private key, proxy address, pUSD balance, and CLOB trading allowance. Always test with `npm run signal` and `npm run paper` before `npm run execute` or `npm run trade`.

## Configuration

### Environment variables

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `POLYMARKET_PRIVATE_KEY` | string | **required** | EOA / MetaMask private key used to sign (64 hex chars, with or without `0x`) |
| `POLYMARKET_PROXY_WALLET_ADDRESS` | string | **required** | Polymarket proxy / funder address from `polymarket.com/settings` (`0x` + 40 hex) |
| `USE_PROXY_WALLET` | boolean | `false` | When `true`, the proxy/Safe at `POLYMARKET_PROXY_WALLET_ADDRESS` funds the trades |
| `SIGNATURE_TYPE` | `0` \| `1` \| `2` | derived | `0` EOA, `1` Polymarket proxy (Magic), `2` Gnosis Safe. If unset and `USE_PROXY_WALLET=true`, defaults to `2` |
| `ENTRY_THRESHOLD` | number | `0.15` | Buy when the matched-bucket YES price is below this |
| `EXIT_THRESHOLD` | number | `0.45` | Exit an open position when YES reaches or exceeds this |
| `MAX_TRADES_PER_RUN` | number | `5` | Hard cap on new entries per run (existing-position skips still count toward iteration) |
| `MIN_HOURS_TO_RESOLUTION` | number | `2` | Skip markets resolving sooner than this many hours from now |
| `LOCATIONS` | string | `nyc,chicago,miami,dallas,seattle,atlanta,london,hong-kong` | Comma-separated city keys to scan |

`POLYMARKET_PRIVATE_KEY` and `POLYMARKET_PROXY_WALLET_ADDRESS` are validated at startup; the bot exits early with a formatted error panel if either is missing or malformed.

### Supported cities

US (NWS forecast, °F Polymarket buckets):

- `nyc`, `chicago`, `miami`, `dallas`, `seattle`, `atlanta`

International (Open-Meteo forecast, °C Polymarket buckets):

- `london`, `hong-kong`

The authoritative list is `LOCATIONS` in `src/nws.ts`. Each entry declares its `lat` / `lon`, display `name`, weather `provider` (`nws` | `open-meteo`), and `tempUnit` (`F` | `C`). Polymarket slugs are the same as the city key, so `hong-kong` (with hyphen) is required — `hongkong` will not resolve to a market.

### Strategy parameters (hardcoded)

These live in `src/strategy.ts` and are intentionally not env-driven:

| Constant | Value | Meaning |
|---|---|---|
| `POSITION_PCT` | `0.05` | Each entry sizes at 5% of the current balance |
| `MIN_PAPER_ORDER_USD` | `$0.50` | Floor for paper-mode order size |
| `MIN_EXECUTE_ORDER_USD` | `$1.00` | Floor for live CLOB order size |
| Scan window | next 4 days | The strategy iterates `i = 0..3` daily forecasts per city |
| Buy limit price | `min(price + 0.03, 0.99)` | Crosses the spread by ~3¢ to improve fill odds |
| Sell limit price | `max(currentPrice - 0.01, 0.01)` | Crosses the spread by ~1¢ on exits |

## Usage

### Run modes

| Mode | Command | Real orders? | Side effects |
|------|---------|---|---|
| Signal | `npm run signal` | No | None |
| Paper | `npm run paper` | No | Updates `simulation.json` |
| One-shot live | `npm run execute` | Yes (single pass) | CLOB orders + `simulation.json` |
| Live on interval | `npm run trade` | Yes | CLOB orders every 30 min until Ctrl+C |

```bash
npm run signal
npm run paper
npm run execute
npm run trade
```

### Other scripts

```bash
npm run positions   # show open positions and PnL from simulation.json
npm run reset       # delete simulation.json (restart paper balance at $1000)
npm run build       # tsc only
```

### CLI flags

All scripts compile with `tsc` first and then invoke `node dist/index.js` with flags:

| Flag | Type | Description |
|---|---|---|
| `--execute` | boolean | Place real limit orders on Polymarket CLOB (requires pUSD + allowance) |
| `--live` | boolean | Paper trading — update `simulation.json`, no on-chain orders |
| `--interval N` | number | With `--execute` or `--live`, run every N minutes (Ctrl+C to stop) |
| `--positions` | boolean | Print open positions with current price and unrealized PnL |
| `--reset` | boolean | Reset `simulation.json` to the $1000 starting balance |

`--execute` and `--live` are mutually exclusive; passing both exits with an error.

## Technical details

### Entry logic

1. For each city in `LOCATIONS` (filtered by `LOCATIONS` env), pull daily-max temps for today + the next 3 days.
2. For each (city, date), GET `gamma-api.polymarket.com/events?slug=highest-temperature-in-{city}-on-{month}-{day}-{year}`.
3. Skip if the event resolves in fewer than `MIN_HOURS_TO_RESOLUTION` hours.
4. Walk the event's markets and pick the one whose bucket range contains the rounded forecast, **only if** the bucket's unit matches the city's `tempUnit`.
5. If YES is below `ENTRY_THRESHOLD`, the position isn't already open, `MAX_TRADES_PER_RUN` hasn't been hit, and the sized order is above the per-mode minimum, open the position (paper or CLOB).

### Exit logic

For every open position the bot checks the current YES price from gamma. If it is at or above `EXIT_THRESHOLD`, the bot sells (CLOB limit on `execute`, virtual close on `paper`), records the trade, and updates win/loss counters.

### State

- **Paper / simulation**: `simulation.json` at the project root tracks virtual balance, peak balance, total trades, wins, losses, open positions, and trade history. The file is gitignored and auto-created on first run (`$1000` starting balance).
- **Live**: positions are *also* persisted to `simulation.json` so that `--positions` and exit detection work across runs; on `execute` the on-chain order is the source of truth and the local file is just a tracker.

## Project structure

```
Polymarket-Weather-Bot/
├── src/
│   ├── index.ts          # CLI entry, validateKeys, mode dispatch
│   ├── config.ts         # .env loading, defaults, getActiveLocations
│   ├── nws.ts            # LOCATIONS + getForecast (NWS + Open-Meteo)
│   ├── polymarket.ts     # gamma-api event / price lookup
│   ├── clob.ts           # CLOB client init, signing, buy/sell limit helpers
│   ├── walletBalance.ts  # pUSD balance via CLOB (with Polygon eth_call fallback)
│   ├── strategy.ts       # entry/exit scan, sizing, position tracking
│   ├── parsing.ts        # parseTempBucket (°F + °C), hoursUntilResolution
│   ├── simState.ts       # load/save/reset simulation.json
│   ├── time.ts           # month names
│   └── colors.ts         # chalk + sleek-pretty panel/stat/badge helpers
├── dist/                  # tsc output (gitignored)
├── simulation.json        # local paper state (gitignored, $1000 default)
├── package.json
├── tsconfig.json
├── .env.example
└── README.md
```

## API integration

### CLOB

Orders use `@polymarket/clob-client-v2` with the configured signer and, when `SIGNATURE_TYPE` is `1` or `2`, the proxy/Safe at `POLYMARKET_PROXY_WALLET_ADDRESS` as funder. API keys are derived on demand (`deriveApiKey`) and created via `createApiKey` as a fallback. All entries and exits go in as `GTC` limit orders.

### Weather providers

- **NWS** (`api.weather.gov`, US cities): hourly forecast + recent station observations, daily-max derived in code. Respect NWS terms of use and rate limits; the bot identifies itself with a `User-Agent: weatherbot-ts/1.0` header.
- **Open-Meteo** (`api.open-meteo.com`, international cities): `daily=temperature_2m_max` with `timezone=auto`, so the daily max aligns with the city's local calendar day — the same basis Polymarket uses for resolution. No API key required.

### Adding a new city

1. Find the resolution source for the market (the description on Polymarket usually names the weather station, e.g. London City Airport / Hong Kong Observatory).
2. Add an entry to `LOCATIONS` in `src/nws.ts` with the station coordinates, the right `tempUnit`, and `provider: "open-meteo"` (or `"nws"` if it's a new US city, in which case also add NWS gridpoint and station ID).
3. Make sure the key you use matches Polymarket's URL slug for that city (e.g. `hong-kong`, not `hongkong`).
4. Add the key to your `.env` `LOCATIONS` list.

## Monitoring and logging

- Console output uses `chalk` + `sleek-pretty` for boxed panels: a header per city/date, a "Matched Bucket" panel, an "Entry Signal" panel, a "Run Summary" panel, and a final dry-run reminder when running in signal mode.
- Paper mode: inspect `simulation.json` directly or run `npm run positions`.
- Live mode: every `execute` run prints a "Live Wallet Check" panel with the current pUSD balance and uses that figure for sizing.

## Risk considerations

1. **Forecast error**: NWS / Open-Meteo can disagree with the official resolution source Polymarket uses (e.g. Wunderground for London).
2. **Liquidity and slippage**: temperature-bucket order books can be thin, especially for tail buckets.
3. **Time to resolution**: short horizons increase sensitivity to price moves; the `MIN_HOURS_TO_RESOLUTION` guard exists for this reason.
4. **Live credentials**: a mistake in `POLYMARKET_PRIVATE_KEY` / `POLYMARKET_PROXY_WALLET_ADDRESS` or insufficient allowance can still move real funds. Validate with `signal` and `paper` first.

**Operational suggestion**: run `signal` → `paper` → small-size `execute` → scheduled `trade` in that order, and watch a few full cycles before scaling size.

## Development

```bash
npm run build      # type-check + emit to dist/
npm run signal     # dry-run end-to-end smoke test
```

The project is plain TypeScript compiled with `tsc`; there is no bundler. Source lives in `src/`, output goes to `dist/`.

## Support

Use repository issues for bugs and feature requests. For CLOB and proxy-wallet behavior, refer to Polymarket's official documentation.

---

**Disclaimer**: This software is provided as-is, without warranty. Prediction markets and digital assets involve substantial risk of loss. Use only capital you can afford to lose and comply with applicable laws in your jurisdiction.

**Version**: 1.0.0  
**Last updated**: May 2026
