export interface Reputation {
  agent_id: string;
  total_trades: number;
  successful_trades: number;
  disputes: number;
  score: number; // 0.0 - 1.0
}

export function calculateTrustScore(reputation: Reputation): number {
  if (reputation.total_trades === 0) return 0.5;
  const successRate = reputation.successful_trades / reputation.total_trades;
  const disputePenalty = reputation.disputes * 0.1;
  return Math.max(0, Math.min(1, successRate - disputePenalty));
}
