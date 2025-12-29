import { promises as fs } from "fs";

// Shared type definitions
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
}

export interface Progress {
  routers: Record<string, RouterInfo>;
  vaults: Record<string, VaultInfo>;
  processedRouters: Record<string, number>;
  processedVaults: Record<string, number>;
  lastRouterFactoryBlock?: number;
  lastVaultFactoryBlock?: number;
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

/**
 * Aggregates vault data by vendor and generates analysis output
 * @param progress - The progress object containing vault and router data
 * @param outputFile - Optional output filename (default: "vault-vendor-analysis.json")
 * @param csvFile - Optional CSV filename (default: "vault-vendor-analysis.csv")
 */
export async function groupByVendor(
  progress: Progress,
  outputFile: string = "vault-vendor-analysis.json",
  csvFile: string = "vault-vendor-analysis.csv"
): Promise<void> {
  console.log("\n=== Aggregating by Vendor ===\n");

  const vendorTVL: Record<string, VendorTVLData> = {};
  let totalTVL = 0;

  for (const [vaultAddress, vaultInfo] of Object.entries(progress.vaults)) {
    if (!vaultInfo.usdValue || vaultInfo.usdValue === 0) continue;

    totalTVL += vaultInfo.usdValue;

    vaultInfo.vendors.forEach((vendor) => {
      if (!vendorTVL[vendor]) {
        vendorTVL[vendor] = {
          totalUSD: 0,
          vaultCount: 0,
          vaults: [],
        };
      }

      // Divide value equally if multiple vendors
      const valuePerVendor = vaultInfo.usdValue! / vaultInfo.vendors.length;

      vendorTVL[vendor].totalUSD += valuePerVendor;
      vendorTVL[vendor].vaultCount += 1;
      vendorTVL[vendor].vaults.push({
        address: vaultAddress,
        asset: vaultInfo.symbol!,
        value: valuePerVendor,
      });
    });
  }

  // Calculate total vaults and percentages
  const totalVaults = Object.keys(progress.vaults).length;
  const vendorStats: VendorStat[] = Object.entries(vendorTVL)
    .map(([vendor, data]) => ({
      vendor,
      totalUSD: data.totalUSD,
      percentage: (data.totalUSD / totalTVL) * 100,
      vaultCount: data.vaultCount,
      vaultPercentage: (data.vaultCount / totalVaults) * 100,
      vaults: data.vaults,
    }))
    .sort((a, b) => b.totalUSD - a.totalUSD);

  // Save results
  const output: AnalysisOutput = {
    summary: {
      totalTVL,
      totalVaults: Object.keys(progress.vaults).length,
      analyzedAt: new Date().toISOString(),
    },
    vendorStats,
  };

  await fs.writeFile(outputFile, JSON.stringify(output, null, 2));

  // Save CSV
  const csvHeader = "Vendor,Total USD,TVL %,Vault Count,Vault %\n";
  const csvRows = vendorStats
    .map((stat) =>
      [
        `"${stat.vendor}"`,
        stat.totalUSD.toFixed(2),
        `${stat.percentage.toFixed(2)}%`,
        stat.vaultCount,
        `${stat.vaultPercentage.toFixed(2)}%`,
      ].join(",")
    )
    .join("\n");

  await fs.writeFile(csvFile, csvHeader + csvRows);

  // Print summary
  console.log("--- Vendor TVL Distribution ---");
  console.log(`Total TVL: $${totalTVL.toLocaleString()}`);
  console.log(`Total Vaults: ${totalVaults}\n`);

  console.log("Vendor                TVL (USD)      TVL %   Vaults  Vault %");
  console.log(
    "-------------------------------------------------------------------"
  );
  vendorStats.forEach((stat) => {
    console.log(
      `${stat.vendor.padEnd(20)} $${stat.totalUSD
        .toLocaleString()
        .padStart(15)} ${stat.percentage
        .toFixed(2)
        .padStart(6)}%  ${stat.vaultCount
        .toString()
        .padStart(6)}  ${stat.vaultPercentage.toFixed(2).padStart(6)}%`
    );
  });

  console.log(
    `\n\n \x1b[33m Unknown is a label by the oracles.euler.finance dashboard \x1b[0m`
  );

  console.log(`\n✓ Saved to ${outputFile} and ${csvFile}`);
}
