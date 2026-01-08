// Shared type definitions for Euler vault analysis

export interface VaultInfo {
  oracle: string;
  asset: string;
  vendors: string[];
  vendorType: string;
  deploymentBlock: number;
  balance?: string;
  balanceFormatted?: string;
  decimals?: number;
  symbol?: string;
  price?: number;
  usdValue?: number;
  error?: string;
  governor_address?: string;
  governor_name?: string;
}

export interface RouterInfo {
  deploymentBlock: number;
  adapters: string[];
  assetPairs: Record<string, string[]>;
  vendorInfo: Record<string, VendorInfo>;
  configEventsCount: number;
  vaultEventsCount: number;
}

export interface VendorInfo {
  vendor: string;
  underlying: string[];
  vendorType: "external" | "vault" | "no oracle (escrow)" | "error";
}

export interface Progress {
  routers: Record<string, RouterInfo>;
  vaults: Record<string, VaultInfo>;
  processedRouters: Record<string, number>;
  processedVaults: Record<string, number>;
  lastRouterFactoryBlock?: number;
  lastVaultFactoryBlock?: number;
}

export interface RouterDeployment {
  address: string;
  deploymentBlock: number;
}

export interface VaultDeployment {
  address: string;
  deploymentBlock: number;
}

export interface OracleData {
  provider?: string;
  providerInfo?: string;
  addressLink?: string;
}

export interface CrossOracleDetail {
  crossAddress?: string;
  baseCrossName?: string;
  crossQuoteName?: string;
  error?: string;
}

export interface CrossOracleAnalysis {
  details?: CrossOracleDetail[];
}

export interface LoadedOracleData {
  eulerOracles: OracleData[];
  crossAnalysis: CrossOracleAnalysis;
  vaultDeployments: VaultDeployment[];
}

export interface TokenPrices {
  priceCache: Record<string, number>;
}

export interface TokenApiResponse {
  data?: {
    last_update: string;
    last_update_block_num: number;
    last_update_timestamp: number;
    address: string;
    contract: string;
    amount: string;
    name: string;
    symbol: string;
    decimals: number;
    network: string;
  }[];
  pagination?: {
    previous_page: number;
    current_page: number;
  };
  results: number;
  request_time: string;
  duration_ms: number;
}

export interface DiaPriceResponse {
  Symbol: string;
  Name: string;
  Address: string;
  Blockchain: string;
  Price: number;
  PriceYesterday: number;
  VolumeYesterdayUSD: number;
  Time: string;
  Source: string;
  Signature: string;
}

export interface VaultDetail {
  address: string;
  asset: string;
  value: number;
}

export interface VendorTVLData {
  totalUSD: number;
  vaultCount: number;
  vaults: VaultDetail[];
}

export interface VendorStat {
  vendor: string;
  totalUSD: number;
  percentage: number;
  vaultCount: number;
  vaultPercentage: number;
  vaults: VaultDetail[];
}

export interface AnalysisOutput {
  summary: {
    totalTVL: number;
    totalVaults: number;
    analyzedAt: string;
  };
  vendorStats: VendorStat[];
}
