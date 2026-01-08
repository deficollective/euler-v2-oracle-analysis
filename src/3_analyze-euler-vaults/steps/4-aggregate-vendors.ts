import { promises as fs } from "fs";
import type {
  Progress,
  VendorTVLData,
  VendorStat,
  AnalysisOutput,
} from "../lib/types.js";
import { loadProgress } from "../lib/progress.js";

// Output paths
const OUTPUT_DIR = "src/analyze-euler-vaults/output";
const OUTPUT_JSON = `${OUTPUT_DIR}/vault-vendor-analysis.json`;
const OUTPUT_CSV = `${OUTPUT_DIR}/vault-vendor-analysis.csv`;

/**
 * Aggregates vault data by vendor and generates analysis output
 */
export async function aggregateVendors(
  progress: Progress,
  outputFile: string = OUTPUT_JSON,
  csvFile: string = OUTPUT_CSV
): Promise<void> {
  console.log("\n=== Step 4: Aggregating by Vendor ===\n");

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

// Allow running this step independently
if (import.meta.url === `file://${process.argv[1]}`) {
  const progress = await loadProgress();

  await aggregateVendors(progress);

  console.log("\n✓ Vendor aggregation completed successfully!");
  process.exit(0);
}
