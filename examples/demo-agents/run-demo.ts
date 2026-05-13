#!/usr/bin/env npx tsx
// ---------------------------------------------------------------------------
// SwarmTrade Demo — Orchestrator
// ---------------------------------------------------------------------------
// Runs the Data Broker and Data Consumer agents sequentially to demonstrate
// a full trade lifecycle:
//
//   1. Broker announces a weather-data asset
//   2. Consumer discovers the asset via search
//   3. Consumer proposes a trade
//   4. Broker auto-accepts (price under $50)
//   5. Consumer locks escrow
//   6. Buyer confirms delivery (escrow settles)
//
// Usage:
//   npx tsx examples/demo-agents/run-demo.ts
//   SWARMTRADE_URL=http://localhost:8080 npx tsx examples/demo-agents/run-demo.ts
// ---------------------------------------------------------------------------

import { SwarmTradeClient } from '../../packages/client/index.js';
import {
  announceAsset,
  waitForProposalAndAccept,
  confirmDelivery as brokerConfirmDelivery,
} from './data-broker.js';
import {
  searchForData,
  proposeTrade,
  waitForAcceptance,
  lockEscrow,
} from './data-consumer.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BASE_URL = process.env.SWARMTRADE_URL ?? 'https://swarmtrade.store';
const BROKER_ID   = `demo-data-broker-${Math.random().toString(36).slice(2, 8)}`;
const CONSUMER_ID = `demo-data-consumer-${Math.random().toString(36).slice(2, 8)}`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function banner(text: string) {
  const line = '='.repeat(60);
  console.log(`\n${line}`);
  console.log(`  ${text}`);
  console.log(`${line}\n`);
}

function step(n: number, text: string) {
  console.log(`\n--- Step ${n}: ${text} ${'─'.repeat(Math.max(0, 44 - text.length))}\n`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  banner('SwarmTrade Demo — Two-Agent Trade Lifecycle');

  console.log(`  API URL     : ${BASE_URL}`);
  console.log(`  Broker ID   : ${BROKER_ID}`);
  console.log(`  Consumer ID : ${CONSUMER_ID}`);
  console.log('');

  const broker   = new SwarmTradeClient({ baseUrl: BASE_URL, agentId: BROKER_ID });
  const consumer = new SwarmTradeClient({ baseUrl: BASE_URL, agentId: CONSUMER_ID });

  // -- Check connectivity ---------------------------------------------------

  step(0, 'Health check');
  try {
    const health = await broker.health();
    console.log(`  [health]  status: ${health.status}, db: ${health.db_connected}, escrow: ${health.escrow_ready}`);
    if (health.adapters?.length) {
      console.log(`  [health]  adapters: ${health.adapters.map(a => a.name).join(', ')}`);
    }
  } catch (err: unknown) {
    console.error('  [health]  Could not reach SwarmTrade API at', BASE_URL);
    console.error('  ', err instanceof Error ? err.message : err);
    console.error('\n  Set SWARMTRADE_URL to your running instance and try again.');
    process.exit(1);
  }

  // -- Step 1: Broker announces asset ---------------------------------------

  step(1, 'Broker announces asset');
  const { assetId } = await announceAsset(broker, BROKER_ID);

  // -- Step 2: Consumer searches for data -----------------------------------

  step(2, 'Consumer searches for data assets');
  const { asset } = await searchForData(consumer);

  // -- Step 3: Consumer proposes trade --------------------------------------

  step(3, 'Consumer proposes trade');
  const trade = await proposeTrade(consumer, CONSUMER_ID, asset);

  // -- Step 4: Broker accepts the trade -------------------------------------

  step(4, 'Broker accepts trade');

  // The broker accepts the proposed trade directly (no polling needed in
  // orchestrated mode because we control both sides sequentially).
  const accepted = await broker.transition(trade.id, {
    fromVersion: trade.version,
    nextState: 'accepted',
    quote: { trade_value: 25, currency: 'USD' },
  });
  console.log(`  [broker]  Trade accepted  ->  version ${accepted.version}, status: ${accepted.status}`);

  // -- Step 5: Consumer locks escrow ----------------------------------------

  step(5, 'Consumer locks escrow');
  const escrow = await lockEscrow(consumer, accepted, CONSUMER_ID);

  // -- Step 6: Confirm delivery (settles the trade) -------------------------

  step(6, 'Confirm delivery & settle');
  console.log(`  [broker]  Simulating data delivery to consumer...`);
  await sleep(300);

  const settled = await consumer.confirmDelivery(escrow.escrowId);
  console.log(`  [consumer]  Delivery confirmed  ->  trade status: ${(settled as any).trade?.status ?? settled.status}`);
  console.log(`  [consumer]  txHash: ${settled.txHash}`);

  // -- Done -----------------------------------------------------------------

  banner('Trade Complete!');

  console.log('  The full lifecycle executed successfully:');
  console.log('');
  console.log('    1. Broker announced a weather-data asset');
  console.log('    2. Consumer discovered it via search');
  console.log('    3. Consumer proposed a trade');
  console.log('    4. Broker accepted ($25 < $50 threshold)');
  console.log('    5. Consumer locked escrow (off-chain)');
  console.log('    6. Delivery confirmed, escrow settled');
  console.log('');
  console.log(`  Trade ID  : ${trade.id}`);
  console.log(`  Escrow ID : ${escrow.escrowId}`);
  console.log(`  Asset     : ${assetId}`);
  console.log('');
}

main().catch((err) => {
  console.error('\n[demo] Fatal error:', err);
  process.exit(1);
});

// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
