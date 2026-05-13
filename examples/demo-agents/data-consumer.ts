// ---------------------------------------------------------------------------
// SwarmTrade Demo — Data Consumer Agent
// ---------------------------------------------------------------------------
// Searches the SwarmTrade registry for "digital_data" assets, proposes a
// trade with the first matching seller, locks escrow after acceptance,
// and confirms delivery.
// ---------------------------------------------------------------------------

import { SwarmTradeClient } from '../../packages/client/index.js';
import type { Trade, AssetRecord, LockEscrowResult } from '../../packages/client/index.js';

export interface ConsumerSearchResult {
  asset: AssetRecord;
}

const POLL_INTERVAL_MS = 1_500;
const POLL_TIMEOUT_MS  = 30_000;

function log(msg: string) {
  console.log(`  [consumer]  ${msg}`);
}

/**
 * Search the registry for digital_data assets.
 * Returns the first matching asset or throws if none found.
 */
export async function searchForData(client: SwarmTradeClient): Promise<ConsumerSearchResult> {
  log('Searching registry for digital_data assets...');

  const assets = await client.search({ type: 'digital_data' });

  if (assets.length === 0) {
    throw new Error('No digital_data assets found in the registry');
  }

  const asset = assets[0];
  log(`Found asset: "${(asset.metadata as Record<string, unknown>).name ?? asset.asset_id}"`);
  log(`  -> seller: ${asset.agent_id}, asset_id: ${asset.asset_id}`);
  log(`  -> price: $${(asset.metadata as Record<string, unknown>).price_usd ?? 'not listed'}`);

  return { asset };
}

/**
 * Propose a trade with the seller of a given asset.
 */
export async function proposeTrade(
  client: SwarmTradeClient,
  buyerId: string,
  asset: AssetRecord,
): Promise<Trade> {
  log(`Proposing trade: buyer="${buyerId}" <-> seller="${asset.agent_id}" for asset "${asset.asset_id}"`);

  const trade = await client.createHandshake({
    buyer_id: buyerId,
    seller_id: asset.agent_id,
    asset_id: asset.asset_id,
  });

  log(`Trade proposed  ->  id: ${trade.id}, status: ${trade.status}, version: ${trade.version}`);
  return trade;
}

/**
 * Poll the trade until the seller accepts it (or timeout).
 */
export async function waitForAcceptance(
  client: SwarmTradeClient,
  tradeId: string,
): Promise<Trade> {
  log('Waiting for seller to accept the trade...');

  const deadline = Date.now() + POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const trade = await client.getTrade(tradeId);

    if (trade.status === 'accepted') {
      log(`Trade accepted by seller  ->  version: ${trade.version}`);
      return trade;
    }

    if (trade.status === 'rejected' || trade.status === 'cancelled') {
      throw new Error(`Trade was ${trade.status}`);
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error('Timed out waiting for seller acceptance');
}

/**
 * Lock escrow for the accepted trade (off-chain / confirmation adapter).
 */
export async function lockEscrow(
  client: SwarmTradeClient,
  trade: Trade,
  buyerId: string,
): Promise<LockEscrowResult> {
  const amount = trade.quote
    ? String(Number((trade.quote as Record<string, unknown>).trade_value ?? 25) * 1_000_000)
    : '25000000';  // default $25 in micro-units

  log(`Locking escrow — amount: ${amount}, buyer: ${buyerId}, seller: ${trade.seller_id}`);

  const result = await client.lockEscrow({
    handshake_id: trade.id,
    buyer_address: `wallet-${buyerId}`,
    seller_address: `wallet-${trade.seller_id}`,
    amount,
    token: 'native',
  });

  log(`Escrow locked  ->  escrowId: ${result.escrowId}, txHash: ${result.txHash}`);
  return result;
}

/**
 * Confirm delivery from the buyer side.
 */
export async function confirmDelivery(
  client: SwarmTradeClient,
  escrowId: string,
): Promise<void> {
  log('Confirming delivery (buyer acknowledges receipt of data)...');
  const result = await client.confirmDelivery(escrowId);
  log(`Delivery confirmed  ->  trade status: ${result.trade.status}, txHash: ${result.txHash}`);
}

// ---------------------------------------------------------------------------
// Standalone mode — run the consumer by itself
// ---------------------------------------------------------------------------

if (process.argv[1] && process.argv[1].includes('data-consumer')) {
  const baseUrl = process.env.SWARMTRADE_URL ?? 'https://swarmtrade.store';
  const agentId = `demo-data-consumer-${Math.random().toString(36).slice(2, 8)}`;

  const client = new SwarmTradeClient({ baseUrl, agentId });

  log(`Agent ID : ${agentId}`);
  log(`API URL  : ${baseUrl}`);
  log('');

  (async () => {
    const { asset } = await searchForData(client);
    const trade = await proposeTrade(client, agentId, asset);

    log('Trade proposed. Waiting for broker to accept...');
    log('(Make sure data-broker.ts is running to accept the trade)');

    const accepted = await waitForAcceptance(client, trade.id);
    const escrow = await lockEscrow(client, accepted, agentId);
    await confirmDelivery(client, escrow.escrowId);

    log('Trade complete!');
  })().catch((err) => {
    console.error('[consumer] Fatal error:', err);
    process.exit(1);
  });
}

// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
