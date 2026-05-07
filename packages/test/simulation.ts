import { SwarmTradeClient } from '../client/index';

async function simulateTrade() {
  const seller = new SwarmTradeClient('http://localhost:8080/api', 'agent-seller');
  const buyer = new SwarmTradeClient('http://localhost:8080/api', 'agent-buyer');

  console.log('--- Simulation Starting ---');

  // 1. Announce Asset
  await seller.announce({
    asset_id: 'asset-123',
    type: 'physical',
    metadata: { name: 'High-Performance GPU' },
    agent_card: { id: 'agent-seller', name: 'SellerBot', capabilities: ['sell'], description: 'Sales Agent', metadata: {} }
  });
  console.log('Asset announced by Seller.');

  // 2. Search
  const assets = await buyer.search({ type: 'physical' });
  console.log('Buyer found assets:', assets);

  // 3. Initiate Trade
  const handshake = await buyer.createHandshake('agent-buyer', 'agent-seller', 'asset-123');
  console.log('Handshake initiated:', handshake.id);

  // 4. Propose (Transition to QUOTE)
  const trade = await seller.transition(handshake.id, 1, 'QUOTE', { amount: 100, currency: 'USD' });
  console.log('Seller proposed quote:', trade.version);

  // 5. Accept (Transition to ACCEPTED)
  const accepted = await buyer.transition(trade.id, trade.version, 'ACCEPTED');
  console.log('Buyer accepted trade, version:', accepted.version);

  console.log('--- Simulation Success ---');
}

simulateTrade().catch(console.error);
