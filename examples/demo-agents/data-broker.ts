// ---------------------------------------------------------------------------
// SwarmTrade Demo — Data Broker Agent
// ---------------------------------------------------------------------------
// Announces a "weather data feed" asset, waits for trade proposals,
// auto-accepts trades under $50, and confirms delivery after escrow lock.
// ---------------------------------------------------------------------------

import { SwarmTradeClient } from '../../packages/client/index.js';
import type { Trade } from '../../packages/client/index.js';

export interface BrokerResult {
  assetId: string;
  registryId: string;
}

const POLL_INTERVAL_MS = 1_500;
const POLL_TIMEOUT_MS  = 30_000;
const AUTO_ACCEPT_MAX  = 50;          // auto-accept trades up to $50

function log(msg: string) {
  console.log(`  [broker]  ${msg}`);
}

/**
 * Announce the data asset and return the asset_id + registry row id.
 */
export async function announceAsset(client: SwarmTradeClient, agentId: string): Promise<BrokerResult> {
  const assetId = `weather-feed-${Date.now()}`;

  log(`Announcing asset "${assetId}" (digital_data / weather API feed)...`);

  const result = await client.announce({
    asset_id: assetId,
    type: 'digital_data',
    metadata: {
      name: 'Real-Time Weather Data Feed',
      description: 'Hourly weather observations — temperature, humidity, wind speed',
      price_usd: 25,
      refresh_interval: '1h',
    },
    status: 'available',
    agent_card: {
      id: agentId,
      name: 'Weather Data Broker',
      capabilities: ['sell', 'stream'],
      description: 'Provides real-time weather API data feeds',
      metadata: {},
    },
  });

  log(`Asset registered  ->  registry id: ${result.id}`);
  return { assetId, registryId: result.id };
}

/**
 * Poll for a trade proposal targeting this broker, then accept it.
 * Returns the accepted Trade.
 */
export async function waitForProposalAndAccept(
  client: SwarmTradeClient,
  tradeId: string,
): Promise<Trade> {
  log('Waiting for trade proposal...');

  const deadline = Date.now() + POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const trade = await client.getTrade(tradeId);

    if (trade.status === 'proposed') {
      const quoteValue = trade.quote
        ? Number((trade.quote as Record<string, unknown>).trade_value ?? 0)
        : 0;

      if (quoteValue > 0 && quoteValue <= AUTO_ACCEPT_MAX) {
        log(`Trade ${trade.id} proposed at $${quoteValue} — auto-accepting (under $${AUTO_ACCEPT_MAX} threshold)`);
      } else if (quoteValue === 0) {
        log(`Trade ${trade.id} proposed (no price set yet) — accepting to proceed`);
      } else {
        log(`Trade ${trade.id} proposed at $${quoteValue} — exceeds auto-accept but accepting for demo`);
      }

      const accepted = await client.transition(trade.id, {
        fromVersion: trade.version,
        nextState: 'accepted',
        quote: { trade_value: 25, currency: 'USD' },
      });

      log(`Trade accepted  ->  version ${accepted.version}, status: ${accepted.status}`);
      return accepted;
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error('Timed out waiting for trade proposal');
}

/**
 * After escrow is locked, the broker confirms delivery (simulating data transfer).
 */
export async function confirmDelivery(
  client: SwarmTradeClient,
  escrowId: string,
): Promise<void> {
  log('Simulating data delivery to buyer...');
  await sleep(500); // pretend we're transferring data

  log('Confirming delivery on escrow...');
  const result = await client.confirmDelivery(escrowId);
  log(`Delivery confirmed  ->  trade status: ${result.trade.status}, txHash: ${result.txHash}`);
}

// ---------------------------------------------------------------------------
// Standalone mode — run the broker by itself
// ---------------------------------------------------------------------------

if (process.argv[1] && process.argv[1].includes('data-broker')) {
  const baseUrl = process.env.SWARMTRADE_URL ?? 'https://swarmtrade.store';
  const agentId = `demo-data-broker-${Math.random().toString(36).slice(2, 8)}`;

  const client = new SwarmTradeClient({ baseUrl, agentId });

  log(`Agent ID : ${agentId}`);
  log(`API URL  : ${baseUrl}`);
  log('');

  announceAsset(client, agentId)
    .then((r) => {
      log(`Asset announced. Waiting for incoming trades on "${r.assetId}"...`);
      log('(Run data-consumer.ts in another terminal to initiate a trade)');
    })
    .catch((err) => {
      console.error('[broker] Fatal error:', err);
      process.exit(1);
    });
}

// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
