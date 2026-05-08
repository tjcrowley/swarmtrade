
type TradeStatus = 'proposed' | 'accepted';
interface TradeProposed {
  status: 'proposed';
  id: string;
}

const trade: TradeProposed = {
  status: 'proposed',
  id: 'test'
};

console.log('Trade Status:', trade.status);
if (trade.status === 'proposed') {
    console.log('Handshake test passed!');
}
