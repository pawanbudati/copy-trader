# Alice Copy Trader (Electron Scaffold)

Desktop app scaffold for leader/follower trade replication across multiple accounts.

## What is implemented

- Electron desktop shell with single dashboard screen.
- Multi-account management (add/remove/set leader).
- Daily login flow for each account (mocked broker by default).
- Instrument search (indices and option contracts in mock mode).
- Leader order placement with follower replication.
- Exit leader order and cascade exit to followers.
- Per-account dashboard cards for funds, P/L and open positions.
- Local encrypted persistence for account/session/order-link state.
- Theme switching with `System`, `Light`, and `Dark` modes.
- Per-account risk policy: quantity multiplier, max qty, max loss/day, margin guard.
- One-click emergency stop for follower copy trading.
- JSONL audit trail for login/order/risk/emergency actions.

## Project structure

- `main.js`: Electron startup + IPC registration.
- `src/preload.js`: safe renderer bridge.
- `src/backend/store.js`: encrypted file store for runtime state.
- `src/backend/engine.js`: account management and copy-trading logic.
- `src/backend/mockAliceClient.js`: runnable mock broker adapter.
- `src/backend/aliceClient.js`: live Alice REST adapter + mock switch.
- `src/backend/auditLogger.js`: append-only audit logger.
- `src/renderer/`: UI (`index.html`, `styles.css`, `app.js`).

## Run

```bash
npm install
npm start
```

PowerShell on this machine blocks direct npm scripts; use:

```bash
cmd /c npm install
cmd /c npm start
```

## Real Alice Blue integration

This scaffold defaults to mock mode.

- Keep mock mode: `USE_MOCK_BROKER=true` (default)
- Switch to live mode: `USE_MOCK_BROKER=false`

Live mode is wired against Alice REST endpoints (matching pya3 flow):

- Login: `customer/getAPIEncpkey` -> `customer/getUserSID`
- Search: `DataApiService/v2/exchange/getScripForSearchAPI`
- Place order: `placeOrder/executePlaceOrder`
- Funds: `limits/getRmsLimits`
- Positions/PnL: `positionAndHoldings/positionBook`

Optional environment variables:

- `ALICE_BASE_API` (defaults to `https://ant.aliceblueonline.com/rest/AliceBlueAPIService/api/`)
- `USE_MOCK_BROKER=false` to enable live broker calls

If your account requires daily primary login, complete normal ANT/mobile login first.

## Audit log file

- Stored in Electron user-data folder under `data/audit.log`.
- Format: one JSON object per line.
- UI also shows recent entries in the `Audit Logs` panel.

## Safety notes before live deployment

- Use per-account risk limits (max qty, max orders/day, max loss/day).
- Add pre-trade margin checks and block partial replication when needed.
- Add idempotency keys to avoid duplicate orders on retries.
- Add explicit emergency kill switch and trading time window rules.
- Use OS credential vault for API keys/session storage in production.
