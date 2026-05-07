import { AssetManifest } from '@a2a/types';
import { Trade } from '../protocol/negotiation';

export class SwarmTradeClient {
  constructor(private readonly baseUrl: string, private readonly agentId: string) {}

  private async fetchApi(path: string, options: RequestInit = {}) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        'x-agent-id': this.agentId,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(`API Error ${response.status}: ${JSON.stringify(error)}`);
    }

    return response.json();
  }

  // Registry
  async announce(asset: AssetManifest) {
    return this.fetchApi('/registry/announce', {
      method: 'POST',
      body: JSON.stringify(asset),
    });
  }

  async search(params: { type?: string; status?: string; limit?: number }) {
    const qs = new URLSearchParams(params as any).toString();
    return this.fetchApi(`/registry/search?${qs}`);
  }

  // Negotiation
  async createHandshake(buyerId: string, sellerId: string, assetId: string) {
    return this.fetchApi('/registry/handshake', {
      method: 'POST',
      body: JSON.stringify({ buyer_id: buyerId, seller_id: sellerId, asset_id: assetId }),
    });
  }

  async transition(handshakeId: string, fromVersion: number, nextState: string, quote?: any) {
    return this.fetchApi(`/registry/negotiation/${handshakeId}/transition`, {
      method: 'POST',
      body: JSON.stringify({ fromVersion, nextState, quote }),
    });
  }
}
