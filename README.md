# Multi Broker Copy Trader (Electron)

Desktop app for leader/follower trade replication across multiple broker accounts.

Supported broker types:

- Upstox
- Kotak Neo

## Features included

- Multi-account setup with leader/follower roles.
- Broker dropdown while adding accounts with broker-specific required fields.
- API routing by account broker type:
  - Upstox accounts use Upstox APIs.
  - Kotak Neo accounts use Kotak Neo APIs.
- Copy trading: place from leader -> replicate to followers.
- Exit leader trade -> cascade exit to followers.
- Follower requests are processed in parallel (`Promise.allSettled`) so one failure does not block others.
- Instrument search for indexes/options.
- Favorite instruments list for quick reuse in order entry.
- Lot-based order entry (`lots x lot size`).
- Per-account risk controls:
  - quantity mode (multiplier/fixed)
  - max order quantity
  - max daily loss
  - margin guard + minimum funds
- Emergency stop for follower copy.
- Audit logs + clear logs action.
- In-app modal dialogs for login/risk/confirm flows (no native `prompt()` dependency).
- Tabbed UI: Accounts, Search, Trade, Dashboard, Audit.
- Theme modes: `System`, `Light`, `Dark`.

## Project structure

- `main.js`: Electron boot + IPC routes.
- `src/preload.js`: safe renderer bridge.
- `src/backend/store.js`: encrypted local persistence.
- `src/backend/engine.js`: copy-trading orchestration and risk checks.
- `src/backend/brokers.js`: broker constants and normalization.
- `src/backend/brokerFactory.js`: broker client router.
- `src/backend/upstoxClient.js`: Upstox live client.
- `src/backend/kotakNeoClient.js`: Kotak Neo live client.
- `src/backend/mockBrokerClient.js`: mock adapter for safe local testing.
- `src/backend/auditLogger.js`: append-only audit logger.
- `src/renderer/`: desktop UI.

## Run

```bash
cmd /c npm install
cmd /c npm start
```

## Mock vs live mode

Default is mock mode.

- mock mode: `USE_MOCK_BROKER=true` (default)
- live mode: `USE_MOCK_BROKER=false`

PowerShell example:

```bash
set USE_MOCK_BROKER=false && cmd /c npm start
```

## Optional API base overrides

- `UPSTOX_API_BASE` (default `https://api.upstox.com`)
- `UPSTOX_ORDER_BASE` (default `https://api-hft.upstox.com`)
- `KOTAK_NEO_SESSION_BASE` (default `https://mis.kotaksecurities.com`)
- `KOTAK_NEO_TRADING_BASE` (default `https://mis.kotaksecurities.com`)
- `KOTAK_NEO_FIN_KEY` (default `neotradeapi`)

## Login flow notes

- Upstox:
  - Supports `Auth URL` + local callback capture (`localhost` / `127.0.0.1` redirect with explicit port).
  - Also supports manual login by code/redirect URL/access token.
- Kotak Neo:
  - Manual login supports:
    - `accessToken|tradingSid|serverId`
    - JSON payload with fields such as `accessToken`, `tradingSid`, `serverId`, `consumerKey`
  - Interactive TOTP flow is supported if JSON includes `mobileNumber`, `ucc`, `totp`, `mpin`.

## Audit log

- Stored in Electron user data folder at `data/audit.log`.
- One JSON object per line.
- UI `Audit Logs` section shows recent entries.
