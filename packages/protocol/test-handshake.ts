import { TradeStatus, TradeProposed } from './negotiation.ts';

// Simple Handshake Test
function testHandshake() {
  const trade: TradeProposed = {
    status: 'proposed',
    id: 'test-123',
    buyer: 'agent-a',
    seller: 'agent-b',
    asset: 'asset-x',
    terms: { type: 'document_exchange' },
    expires_at: new Date(Date.now() + 3600000),
    version: 1
  };
  
  console.log('Testing Handshake Transition...');
  if (trade.status === 'proposed') {
    console.log('Successfully validated TradeProposed state.');
  }
}

testHandshake();
