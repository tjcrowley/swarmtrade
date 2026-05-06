// Protocol package barrel export

export { calculateTrustScore } from './reputation';
export type { Reputation } from './reputation';

export {
  NegotiationService,
  InvalidTransitionError,
  NegotiationNotFoundError,
  QuoteRequiredError,
  TRADE_STATES,
} from './negotiation';

export type {
  TradeState,
  Negotiation,
  QuotePayload,
  CreateNegotiationParams,
  TransitionContext,
  NegotiationRepository,
} from './negotiation';

/** @deprecated Use TradeState from negotiation.ts */
export type NegotiationState = import('./negotiation').TradeState;

export interface TrustScore {
  agent_id: string;
  score: number; // 0.0 to 1.0
  transaction_count: number;
}
