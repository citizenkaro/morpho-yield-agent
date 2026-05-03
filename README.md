# Morpho Yield Agent (Base)

Working Morpho yield optimizer agent. Monitors USDC vault APYs on Base and rebalances to the highest-yielding vault automatically. All transactions go through WaaP two-party signing — the agent never holds the private key.

Recipe source: [holonym-foundation/waap-docs#90](https://github.com/holonym-foundation/waap-docs/pull/90). Local patches applied (see *Patches vs upstream* below).

Companion dashboard: [citizenkaro/morpho-dashboard](https://github.com/citizenkaro/morpho-dashboard).

## Quick start

```bash
# 1. Install WaaP CLI
npm install -g @human.tech/waap-cli@latest

# 2. Create your agent wallet
waap-cli signup --email you+morpho-agent@example.com --password 'YOUR_PASSWORD'
waap-cli policy set --daily-spend-limit 10
# 2FA recommended — use email or telegram (telegram flow has known issues, see below)

# 3. Configure
cp .env.example .env
# Edit .env — set your vault addresses, USDC address, RPC URL

# 4. Fund the agent wallet
# Send a small amount of ETH (gas) + USDC on Base to the address from `waap-cli whoami`

# 5. Run
npm install
npm start
```

## Patches vs upstream PR #90

This fork carries small fixes on top of `waap-docs#90`:

1. `getAgentAddress()` parses just the EVM address from `whoami` output (upstream returns the full multi-line block, which then breaks `encodeDeposit`)
2. `waapCli()` only adds `--rpc` to `send-tx`/`sign-tx` (upstream adds it to every command including `whoami`, which rejects it)
3. `package.json` start script uses `node --env-file=.env` so env vars actually load (upstream agent silently runs with hardcoded defaults)
4. `reconcileCurrentVault()` on startup reads vault `balanceOf` for each watched vault, sets `CURRENT_VAULT` from on-chain truth (upstream resets to null on every restart and tries to deposit fresh)
5. `depositIntoBestVault()` skips approve if existing allowance is sufficient, and waits for the allowance to land on-chain before submitting deposit (upstream race-conditions deposit against pre-approve chain state)
6. Structured JSON event log written to `./logs/<agent-id>.log` for the dashboard to consume (upstream only `console.log`s)

These will be sent upstream as a separate PR.

## Known issues

- **Sepolia default in upstream `.env.example` is wrong** — Morpho has no Sepolia deployment. Use Base mainnet (chain `8453`) with a low daily spend cap.
- **Telegram 2FA flow returns 401** on the verification link even when clicked from a laptop browser within the timeout window. Falling back to email 2FA works. Tracked separately.

## Configuration

See `.env.example`. Key settings:

| Setting | Description |
|---|---|
| `CHAIN_ID` | `8453` for Base, `1` for Ethereum |
| `VAULT_1/2/3` | Morpho vault addresses to monitor (find at [app.morpho.org/vaults](https://app.morpho.org/vaults)) |
| `USDC_ADDRESS` | USDC contract for your chain |
| `DEPOSIT_AMOUNT` | Amount to deposit, in token smallest units (1 USDC = 1000000) |
| `MIN_APY_DELTA` | Minimum APY improvement to trigger rebalance (default: 0.5%) |
| `CHECK_INTERVAL_MS` | How often to check rates (default: 30 min, demo uses 5 min) |
| `RPC_URL` | RPC for the chain (e.g., `https://mainnet.base.org`) |

## Tracked under

[holonym-foundation/internal-docs#717](https://github.com/holonym-foundation/internal-docs/issues/717)
