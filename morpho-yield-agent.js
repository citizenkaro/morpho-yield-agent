// morpho-yield-agent.js
// A WaaP-powered agent that monitors Morpho vault rates and optimizes yield.
//
// Usage:
//   1. Copy .env.example to .env and fill in your values
//   2. node morpho-yield-agent.js
//   3. Or deploy with Docker: docker compose up -d

import { exec } from "child_process";
import { promisify } from "util";
import { mkdirSync, appendFileSync } from "fs";

const execAsync = promisify(exec);

// ─── Structured event logging ─────────────────────────────────
const AGENT_ID = process.env.AGENT_ID || "base-morpho-yield";
const LOG_DIR = process.env.LOG_DIR || "./logs";
mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = `${LOG_DIR}/${AGENT_ID}.log`;

function logEvent(level, message, data = {}) {
  const entry = { ts: new Date().toISOString(), agent: AGENT_ID, level, message, ...data };
  appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n");
}

function extractTxHash(output) {
  const m = output.match(/TxHash:\s*(0x[a-fA-F0-9]{64})/);
  return m ? m[1] : null;
}

async function fetchUsdcBalance(address, usdcAddress) {
  const data = `0x70a08231${address.slice(2).toLowerCase().padStart(64, "0")}`;
  const res = await fetch(CONFIG.RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "eth_call", params: [{ to: usdcAddress, data }, "latest"], id: 1 }),
  });
  const json = await res.json();
  return Number(BigInt(json.result || "0x0")) / 1e6;
}

async function fetchVaultShares(address, vaultAddress) {
  const data = `0x70a08231${address.slice(2).toLowerCase().padStart(64, "0")}`;
  const res = await fetch(CONFIG.RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "eth_call", params: [{ to: vaultAddress, data }, "latest"], id: 1 }),
  });
  const json = await res.json();
  return BigInt(json.result || "0x0");
}

async function fetchUnderlyingValueUsd(vaultAddress, shares) {
  if (shares === 0n) return 0;
  const sharesHex = shares.toString(16).padStart(64, "0");
  const data = `0x07a2d13a${sharesHex}`;
  const res = await fetch(CONFIG.RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "eth_call", params: [{ to: vaultAddress, data }, "latest"], id: 1 }),
  });
  const json = await res.json();
  return Number(BigInt(json.result || "0x0")) / 1e6;
}

async function fetchAllowance(owner, spender, tokenAddress) {
  const data = `0xdd62ed3e${owner.slice(2).toLowerCase().padStart(64, "0")}${spender.slice(2).toLowerCase().padStart(64, "0")}`;
  const res = await fetch(CONFIG.RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "eth_call", params: [{ to: tokenAddress, data }, "latest"], id: 1 }),
  });
  const json = await res.json();
  return BigInt(json.result || "0x0");
}

async function reconcileCurrentVault() {
  if (!CONFIG.RPC_URL) return;
  const agent = await getAgentAddress();
  const balances = await Promise.all(
    CONFIG.WATCHED_VAULTS.map(async (v) => ({ v, b: await fetchVaultShares(agent, v) }))
  );
  const nonzero = balances.filter((x) => x.b > 0n);
  if (nonzero.length === 0) {
    console.log("[RECONCILE] No existing position across watched vaults. Will deposit fresh.");
    return;
  }
  if (nonzero.length === 1) {
    CONFIG.CURRENT_VAULT = nonzero[0].v;
    console.log(`[RECONCILE] Found existing position in ${CONFIG.CURRENT_VAULT} (${nonzero[0].b} shares)`);
    return;
  }
  console.error(`[RECONCILE] Multiple watched vaults have shares: ${nonzero.map((x) => x.v).join(", ")}. Set CURRENT_VAULT in .env to disambiguate.`);
  process.exit(1);
}

// ─── Configuration ─────────────────────────────────────────────
const CONFIG = {
  MORPHO_API: "https://api.morpho.org/graphql",

  // Default to Sepolia testnet. Mainnet: 1 | Base: 8453
  CHAIN_ID: process.env.CHAIN_ID || "11155111",

  // Morpho Blue contract (same across EVM chains)
  // Verify at: https://docs.morpho.org/addresses/
  MORPHO_BLUE_ADDRESS: "0xBBBBBbbBBb9cc5e90e3b3Af64bdAF62C37EEFFCb",

  // Vaults to monitor — replace with your target vault addresses
  // Find vaults at: https://app.morpho.org/vaults
  WATCHED_VAULTS: [
    process.env.VAULT_1,
    process.env.VAULT_2,
    process.env.VAULT_3,
  ].filter(Boolean),

  // Minimum APY improvement to trigger a rebalance (percentage points)
  MIN_APY_DELTA: parseFloat(process.env.MIN_APY_DELTA) || 0.5,

  // How often to check rates (milliseconds) — default: 30 minutes
  CHECK_INTERVAL_MS: parseInt(process.env.CHECK_INTERVAL_MS) || 30 * 60 * 1000,

  // Current vault the agent's funds are in (set after first deposit)
  CURRENT_VAULT: process.env.CURRENT_VAULT || null,

  // Optional custom RPC (waap-cli auto-selects if omitted)
  RPC_URL: process.env.RPC_URL || undefined,
};

// ─── Morpho API: Fetch Vault APYs ─────────────────────────────
async function fetchVaultAPYs() {
  const results = [];

  for (const vaultAddress of CONFIG.WATCHED_VAULTS) {
    const query = `
      query {
        vaultByAddress(address: "${vaultAddress}", chainId: ${CONFIG.CHAIN_ID}) {
          address
          name
          symbol
          asset { symbol decimals }
          state { apy netApy totalAssets totalAssetsUsd }
        }
      }
    `;

    try {
      const response = await fetch(CONFIG.MORPHO_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });

      const data = await response.json();
      const vault = data?.data?.vaultByAddress;

      if (vault) {
        results.push({
          address: vault.address,
          name: vault.name || vault.symbol,
          asset: vault.asset?.symbol,
          apy: vault.state?.apy ? vault.state.apy * 100 : 0,
          netApy: vault.state?.netApy ? vault.state.netApy * 100 : 0,
          tvl: vault.state?.totalAssetsUsd || 0,
        });
      }
    } catch (err) {
      console.error(`[ERROR] Failed to fetch vault ${vaultAddress}:`, err.message);
    }
  }

  return results.sort((a, b) => b.netApy - a.netApy);
}

// ─── WaaP CLI Helpers ──────────────────────────────────────────

async function waapCli(command) {
  const needsRpc = /^(send-tx|sign-tx)\b/.test(command);
  const rpcFlag = needsRpc && CONFIG.RPC_URL ? ` --rpc ${CONFIG.RPC_URL}` : "";
  const fullCmd = `waap-cli ${command}${rpcFlag}`;
  console.log(`[WAAP] ${fullCmd}`);
  const { stdout, stderr } = await execAsync(fullCmd);
  if (stderr) console.warn(`[WAAP WARN] ${stderr}`);
  return stdout.trim();
}

async function getAgentAddress() {
  const output = await waapCli("whoami");
  const match = output.match(/EvmWalletAddress:\s*(0x[a-fA-F0-9]{40})/);
  if (!match) throw new Error("Could not parse EVM address from waap-cli whoami output");
  return match[1];
}

async function sendTransaction({ to, data, value, chainId }) {
  let cmd = `send-tx --to ${to} --chain-id ${chainId || CONFIG.CHAIN_ID}`;
  if (data) cmd += ` --data '${data}'`;
  if (value) cmd += ` --value ${value}`;
  return waapCli(cmd);
}

// ─── ERC-4626 / ERC-20 Calldata Encoders ──────────────────────

function encodeDeposit(assets, receiver) {
  const assetsHex = BigInt(assets).toString(16).padStart(64, "0");
  const receiverHex = receiver.slice(2).toLowerCase().padStart(64, "0");
  return `0x6e553f65${assetsHex}${receiverHex}`;
}

function encodeRedeem(shares, receiver, owner) {
  const sharesHex = BigInt(shares).toString(16).padStart(64, "0");
  const receiverHex = receiver.slice(2).toLowerCase().padStart(64, "0");
  const ownerHex = owner.slice(2).toLowerCase().padStart(64, "0");
  return `0xba087652${sharesHex}${receiverHex}${ownerHex}`;
}

function encodeApprove(spender, amount) {
  const spenderHex = spender.slice(2).toLowerCase().padStart(64, "0");
  const amountHex = BigInt(amount).toString(16).padStart(64, "0");
  return `0x095ea7b3${spenderHex}${amountHex}`;
}

// ─── Core Agent Logic ──────────────────────────────────────────

async function evaluateAndRebalance() {
  console.log(`\n[${new Date().toISOString()}] Checking Morpho vault rates...`);

  const vaults = await fetchVaultAPYs();

  if (vaults.length === 0) {
    console.log("[INFO] No vault data available. Skipping cycle.");
    logEvent("warn", "rates_check_empty");
    return;
  }

  console.log("\n[RATES] Current Morpho Vault APYs:");
  for (const v of vaults) {
    const marker = v.address === CONFIG.CURRENT_VAULT ? " << current" : "";
    console.log(
      `  ${v.name}: ${v.netApy.toFixed(2)}% net APY | TVL: $${(v.tvl / 1e6).toFixed(1)}M${marker}`
    );
  }

  const bestVault = vaults[0];

  logEvent("info", "rates_check", {
    vaults: vaults.map((v) => ({
      address: v.address,
      name: v.name,
      netApy: v.netApy,
      tvlUsd: v.tvl,
      isCurrent: v.address === CONFIG.CURRENT_VAULT,
    })),
    bestVaultName: bestVault.name,
    bestApy: bestVault.netApy,
  });

  // Snapshot current position value for the dashboard's chart
  if (CONFIG.CURRENT_VAULT && CONFIG.RPC_URL) {
    try {
      const agentAddress = await getAgentAddress();
      const shares = await fetchVaultShares(agentAddress, CONFIG.CURRENT_VAULT);
      const underlyingValueUsd = await fetchUnderlyingValueUsd(CONFIG.CURRENT_VAULT, shares);
      const usdcBalance = await fetchUsdcBalance(agentAddress, process.env.USDC_ADDRESS || "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
      const currentVault = vaults.find((v) => v.address === CONFIG.CURRENT_VAULT);
      logEvent("info", "balance_snapshot", { usdcBalance, usdcValue: underlyingValueUsd });
      logEvent("info", "position_status", {
        vaultAddress: CONFIG.CURRENT_VAULT,
        vaultName: currentVault?.name || "Unknown",
        shares: shares.toString(),
        underlyingValueUsd,
        rebalanceCount: CONFIG.REBALANCE_COUNT || 0,
      });
    } catch (err) {
      console.warn("[WARN] Failed to snapshot position:", err.message);
    }
  }

  if (!CONFIG.CURRENT_VAULT) {
    console.log("\n[ACTION] No current vault position. Depositing into best vault...");
    await depositIntoBestVault(bestVault);
    return;
  }

  const currentVault = vaults.find((v) => v.address === CONFIG.CURRENT_VAULT);
  if (!currentVault) {
    console.log("[WARN] Current vault not found in watched list. Skipping.");
    return;
  }

  const apyDelta = bestVault.netApy - currentVault.netApy;

  if (bestVault.address === CONFIG.CURRENT_VAULT) {
    console.log(`\n[HOLD] Already in the best vault (${bestVault.name}). No action needed.`);
    return;
  }

  if (apyDelta < CONFIG.MIN_APY_DELTA) {
    console.log(
      `\n[HOLD] Best vault (${bestVault.name}) is only +${apyDelta.toFixed(2)}% better. ` +
        `Below ${CONFIG.MIN_APY_DELTA}% threshold. Holding.`
    );
    return;
  }

  console.log(
    `\n[REBALANCE] Moving from ${currentVault.name} (${currentVault.netApy.toFixed(2)}%) ` +
      `to ${bestVault.name} (${bestVault.netApy.toFixed(2)}%) | Delta: +${apyDelta.toFixed(2)}%`
  );

  await rebalance(currentVault, bestVault);
}

async function depositIntoBestVault(vault) {
  const agentAddress = await getAgentAddress();

  const USDC_ADDRESS =
    process.env.USDC_ADDRESS || "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
  const depositAmount = process.env.DEPOSIT_AMOUNT || "1000000"; // 1 USDC (6 decimals)
  const amountUsdc = Number(BigInt(depositAmount)) / 1e6;

  // Skip approve if existing allowance covers the deposit
  const existingAllowance = await fetchAllowance(agentAddress, vault.address, USDC_ADDRESS);
  if (existingAllowance >= BigInt(depositAmount)) {
    console.log(`[SKIP APPROVE] Existing allowance ${existingAllowance} >= ${depositAmount}, no approve needed.`);
  } else {
    console.log(`[TX] Approving ${vault.name} to spend USDC...`);
    const approveData = encodeApprove(vault.address, depositAmount);
    const approveOut = await sendTransaction({ to: USDC_ADDRESS, data: approveData });
    const approveTx = extractTxHash(approveOut);
    logEvent("event", "approve", { vaultName: vault.name, vaultAddress: vault.address, amount: amountUsdc, txHash: approveTx });

    // Wait until the allowance is on-chain before submitting the deposit
    for (let i = 0; i < 30; i++) {
      const a = await fetchAllowance(agentAddress, vault.address, USDC_ADDRESS);
      if (a >= BigInt(depositAmount)) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  console.log(`[TX] Depositing into ${vault.name}...`);
  const depositData = encodeDeposit(depositAmount, agentAddress);
  const depositOut = await sendTransaction({ to: vault.address, data: depositData });
  const depositTx = extractTxHash(depositOut);
  logEvent("event", "vault_deposit", { vaultName: vault.name, vaultAddress: vault.address, amount: amountUsdc, txHash: depositTx });

  CONFIG.CURRENT_VAULT = vault.address;
  console.log(`[DONE] Deposited into ${vault.name}. Updated current vault.`);
}

async function rebalance(fromVault, toVault) {
  const agentAddress = await getAgentAddress();
  const shares = (await fetchVaultShares(agentAddress, fromVault.address)).toString();

  logEvent("event", "rebalance_start", {
    fromVaultName: fromVault.name,
    fromVaultAddress: fromVault.address,
    toVaultName: toVault.name,
    toVaultAddress: toVault.address,
    apyDelta: toVault.netApy - fromVault.netApy,
  });

  console.log(`[TX] Redeeming from ${fromVault.name}...`);
  const redeemData = encodeRedeem(shares, agentAddress, agentAddress);
  const redeemOut = await sendTransaction({ to: fromVault.address, data: redeemData });
  const redeemTx = extractTxHash(redeemOut);
  logEvent("event", "vault_redeem", { vaultName: fromVault.name, vaultAddress: fromVault.address, shares, txHash: redeemTx });

  console.log(`[TX] Redeemed. Depositing into ${toVault.name}...`);
  await depositIntoBestVault(toVault);

  CONFIG.REBALANCE_COUNT = (CONFIG.REBALANCE_COUNT || 0) + 1;
  logEvent("event", "rebalance_complete", { fromVaultName: fromVault.name, toVaultName: toVault.name });
  console.log(`\n[COMPLETE] Rebalance complete: ${fromVault.name} -> ${toVault.name}`);
}

// ─── Main Loop ─────────────────────────────────────────────────

async function main() {
  console.log("===========================================");
  console.log("  Morpho Yield Optimizer Agent (WaaP CLI)");
  console.log("===========================================");
  console.log(`Chain ID: ${CONFIG.CHAIN_ID}`);
  console.log(`Watching ${CONFIG.WATCHED_VAULTS.length} vaults`);
  console.log(`Min APY delta: ${CONFIG.MIN_APY_DELTA}%`);
  console.log(`Check interval: ${CONFIG.CHECK_INTERVAL_MS / 60000} minutes`);
  console.log("-------------------------------------------\n");

  logEvent("event", "agent_start", {
    chainId: CONFIG.CHAIN_ID,
    watchedVaults: CONFIG.WATCHED_VAULTS.length,
    minApyDelta: CONFIG.MIN_APY_DELTA,
    checkIntervalMs: CONFIG.CHECK_INTERVAL_MS,
  });

  await reconcileCurrentVault();
  await evaluateAndRebalance();

  setInterval(async () => {
    try {
      await evaluateAndRebalance();
    } catch (err) {
      console.error(`[ERROR] Agent cycle failed:`, err.message);
    }
  }, CONFIG.CHECK_INTERVAL_MS);
}

main().catch(console.error);
