export type AssetType = 'physical' | 'service' | 'license' | 'digital_data';

export interface AssetManifest {
  asset_id: string; // sha256
  type: AssetType;
  metadata: Record<string, any>;
  status: 'available' | 'pending' | 'locked' | 'transferred';
  agent_id: string; // DID
  created_at: string;
}

export interface SearchIntent {
  query: string;
  type?: AssetType;
  min_match_score?: number;
}
