
export type TradeStatus = 'proposed' | 'accepted';

export interface TradeProposed {
  status: 'proposed';
  id: string;
}

export interface TradeAccepted {
  status: 'accepted';
  id: string;
}

export type Trade = TradeProposed | TradeAccepted;
