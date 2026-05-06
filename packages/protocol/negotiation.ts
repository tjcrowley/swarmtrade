// ---------------------------------------------------------------------------
// NegotiationService — state machine for agent-to-agent trades
// ---------------------------------------------------------------------------
// Decoupled from persistence via NegotiationRepository interface.
// Consumers inject their own implementation (pg, in-memory, etc.).
// ---------------------------------------------------------------------------

/** Canonical trade states. */
export const TRADE_STATES = ['INIT', 'QUOTE', 'ACCEPTED', 'REJECTED', 'COMPLETED'] as const;
export type TradeState = (typeof TRADE_STATES)[number];

/** A single negotiation between two agents over one asset. */
export interface Negotiation {
  handshake_id: string;
  buyer_id: string;
  seller_id: string;
  asset_id: string;
  state: TradeState;
  /** Optional quote payload (set when transitioning to QUOTE). */
  quote?: QuotePayload;
  created_at: string;
  updated_at: string;
}

/** Seller-provided quote details attached during the QUOTE transition. */
export interface QuotePayload {
  amount: number;
  currency: string;
  expires_at?: string;
  terms?: Record<string, unknown>;
}

/** Parameters required to open a new negotiation. */
export interface CreateNegotiationParams {
  buyer_id: string;
  seller_id: string;
  asset_id: string;
}

/** Context passed alongside a state transition. */
export interface TransitionContext {
  /** Required when transitioning to QUOTE. */
  quote?: QuotePayload;
  /** Free-form metadata the caller may attach (audit trail, reason, etc.). */
  meta?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Repository contract — implement this for your persistence layer
// ---------------------------------------------------------------------------

export interface NegotiationRepository {
  /** Persist a new negotiation in INIT state and return it with generated ID. */
  create(params: CreateNegotiationParams): Promise<Negotiation>;
  /** Retrieve a negotiation by ID. Returns null if not found. */
  findById(handshakeId: string): Promise<Negotiation | null>;
  /** Atomically update state (and optional quote). Return the updated record. */
  updateState(
    handshakeId: string,
    state: TradeState,
    quote?: QuotePayload,
  ): Promise<Negotiation>;
}

// ---------------------------------------------------------------------------
// Transition rules
// ---------------------------------------------------------------------------

const VALID_TRANSITIONS: Record<TradeState, readonly TradeState[]> = {
  INIT:     ['QUOTE'],
  QUOTE:    ['ACCEPTED', 'REJECTED'],
  ACCEPTED: ['COMPLETED'],
  REJECTED: [],           // terminal
  COMPLETED: [],          // terminal
};

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: TradeState,
    public readonly to: TradeState,
  ) {
    super(`Invalid transition: ${from} → ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export class NegotiationNotFoundError extends Error {
  constructor(public readonly handshakeId: string) {
    super(`Negotiation not found: ${handshakeId}`);
    this.name = 'NegotiationNotFoundError';
  }
}

export class QuoteRequiredError extends Error {
  constructor() {
    super('A QuotePayload is required when transitioning to QUOTE');
    this.name = 'QuoteRequiredError';
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class NegotiationService {
  constructor(private readonly repo: NegotiationRepository) {}

  /** Open a new negotiation between buyer and seller for a given asset. */
  async create(params: CreateNegotiationParams): Promise<Negotiation> {
    return this.repo.create(params);
  }

  /** Retrieve a negotiation or throw if missing. */
  async get(handshakeId: string): Promise<Negotiation> {
    const neg = await this.repo.findById(handshakeId);
    if (!neg) throw new NegotiationNotFoundError(handshakeId);
    return neg;
  }

  /**
   * Advance the negotiation to `nextState`.
   *
   * Validates:
   * 1. The negotiation exists.
   * 2. The transition is legal per the state machine.
   * 3. A QuotePayload is provided when moving to QUOTE.
   */
  async transition(
    handshakeId: string,
    nextState: TradeState,
    ctx: TransitionContext = {},
  ): Promise<Negotiation> {
    const neg = await this.get(handshakeId);

    // Validate transition legality
    const allowed = VALID_TRANSITIONS[neg.state];
    if (!allowed.includes(nextState)) {
      throw new InvalidTransitionError(neg.state, nextState);
    }

    // Require quote payload when entering QUOTE
    if (nextState === 'QUOTE' && !ctx.quote) {
      throw new QuoteRequiredError();
    }

    return this.repo.updateState(handshakeId, nextState, ctx.quote);
  }

  /** Check whether a given transition would be legal without executing it. */
  canTransition(currentState: TradeState, nextState: TradeState): boolean {
    return VALID_TRANSITIONS[currentState]?.includes(nextState) ?? false;
  }

  /** Return the set of states reachable from `state`. */
  allowedTransitions(state: TradeState): readonly TradeState[] {
    return VALID_TRANSITIONS[state] ?? [];
  }
}
