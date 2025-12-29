import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

interface VaultInfo {
  address: string;
  asset: string;
  value: number;
}

interface VendorStatInput {
  vendor: string;
  totalUSD: number;
  percentage: number;
  vaultCount: number;
  vaultPercentage: number;
  vaults: VaultInfo[];
}

interface InputData {
  summary: {
    totalTVL: number;
    totalVaults: number;
    analyzedAt: string;
  };
  vendorStats: VendorStatInput[];
}

interface VendorStatOutput {
  vendor: string;
  totalUSD: number;
  percentage: number;
  vaultCount: number;
  vaultPercentage: number;
  vaults: VaultInfo[];
}

interface AnalysisResult {
  totalTVL: number;
  uniqueVaults: number;
  vendorStats: VendorStatOutput[];
  filterCriteria: {
    minValueUSD: number;
  };
  generatedAt: string;
}

const INPUT_FILE = "./vault-vendor-analysis.json";
const OUTPUT_FILE = "./vault-vendor-analysis-filtered.json";
const OUTPUT_CSV = "./vault-vendor-analysis-filtered.csv";

// Minimum vault value in USD to include in analysis
const MIN_VAULT_VALUE_USD = 200_000;

async function main() {
  console.log("\n🔍 Vault Vendor Analysis Filter");
  console.log("=".repeat(50));
  console.log(`Minimum vault value: $${MIN_VAULT_VALUE_USD.toLocaleString()}\n`);

  // Check if input file exists
  if (!existsSync(INPUT_FILE)) {
    console.error(`❌ Error: ${INPUT_FILE} not found`);
    console.error("Please run analyze-vault-vendors.ts first to generate the data");
    process.exit(1);
  }

  // Load the vault analysis data
  const rawData = await readFile(INPUT_FILE, "utf-8");
  const data: InputData = JSON.parse(rawData);

  console.log(`📊 Total vaults in original dataset: ${data.summary.totalVaults}`);
  console.log(`📊 Total TVL in original dataset: $${data.summary.totalTVL.toLocaleString()}\n`);

  // Collect all unique vaults with their values
  const uniqueVaults = new Map<string, { asset: string; value: number }>();
  for (const vendorStat of data.vendorStats) {
    for (const vault of vendorStat.vaults) {
      if (!uniqueVaults.has(vault.address)) {
        uniqueVaults.set(vault.address, {
          asset: vault.asset,
          value: vault.value,
        });
      }
    }
  }

  console.log(`📊 Unique vaults found: ${uniqueVaults.size}`);

  // Filter vaults by minimum value
  const filteredVaultAddresses = new Set<string>();
  for (const [address, info] of uniqueVaults.entries()) {
    if (info.value >= MIN_VAULT_VALUE_USD) {
      filteredVaultAddresses.add(address);
    }
  }

  console.log(
    `✅ Vaults above $${MIN_VAULT_VALUE_USD.toLocaleString()}: ${filteredVaultAddresses.size}`
  );
  console.log(
    `❌ Filtered out: ${uniqueVaults.size - filteredVaultAddresses.size} vaults\n`
  );

  // Rebuild vendor stats with filtered vaults only
  const filteredVendorStats: VendorStatOutput[] = [];
  let totalTVL = 0;
  const uniqueFilteredVaults = new Set<string>();

  for (const vendorStat of data.vendorStats) {
    const filteredVaults = vendorStat.vaults.filter((vault) =>
      filteredVaultAddresses.has(vault.address)
    );

    if (filteredVaults.length === 0) {
      continue; // Skip vendors with no vaults after filtering
    }

    const vendorTotalUSD = filteredVaults.reduce(
      (sum, vault) => sum + vault.value,
      0
    );

    filteredVaults.forEach((vault) => uniqueFilteredVaults.add(vault.address));

    filteredVendorStats.push({
      vendor: vendorStat.vendor,
      totalUSD: vendorTotalUSD,
      percentage: 0, // Will calculate after we have total TVL
      vaultCount: filteredVaults.length,
      vaultPercentage: 0, // Will calculate after we have total vault count
      vaults: filteredVaults,
    });
  }

  // Calculate total TVL from unique vaults only (avoid double counting)
  for (const address of uniqueFilteredVaults) {
    const vaultInfo = uniqueVaults.get(address);
    if (vaultInfo) {
      totalTVL += vaultInfo.value;
    }
  }

  const totalVaults = uniqueFilteredVaults.size;

  // Update percentages
  for (const stat of filteredVendorStats) {
    stat.percentage = (stat.totalUSD / totalTVL) * 100;
    stat.vaultPercentage = (stat.vaultCount / totalVaults) * 100;
  }

  // Sort by TVL
  filteredVendorStats.sort((a, b) => b.totalUSD - a.totalUSD);

  const vendorStats = filteredVendorStats;

  // Display results
  console.log("📈 Vendor Distribution:");
  console.log("=".repeat(80));
  console.log(
    `${"Vendor".padEnd(15)} ${"TVL".padStart(18)} ${"TVL %".padStart(
      8
    )} ${"Vaults".padStart(8)} ${"Vault %".padStart(8)}`
  );
  console.log("=".repeat(80));

  for (const stat of vendorStats) {
    console.log(
      `${stat.vendor.padEnd(15)} $${stat.totalUSD
        .toLocaleString(undefined, { minimumFractionDigits: 2 })
        .padStart(16)} ${stat.percentage.toFixed(2).padStart(7)}% ${stat.vaultCount
        .toString()
        .padStart(7)} ${stat.vaultPercentage.toFixed(2).padStart(7)}%`
    );
  }

  console.log("=".repeat(80));
  console.log(
    `${"TOTAL".padEnd(15)} $${totalTVL
      .toLocaleString(undefined, { minimumFractionDigits: 2 })
      .padStart(16)} ${(100).toFixed(2).padStart(7)}% ${totalVaults
      .toString()
      .padStart(7)} ${"-".padStart(8)}`
  );
  console.log("=".repeat(80));

  // Save analysis result
  const result: AnalysisResult = {
    totalTVL,
    uniqueVaults: totalVaults,
    vendorStats,
    filterCriteria: {
      minValueUSD: MIN_VAULT_VALUE_USD,
    },
    generatedAt: new Date().toISOString(),
  };

  await writeFile(OUTPUT_FILE, JSON.stringify(result, null, 2));
  console.log(`\n💾 Saved analysis to ${OUTPUT_FILE}`);

  // Generate CSV
  const csvLines = [
    "Vendor,TVL USD,TVL %,Vault Count,Vault %",
    ...vendorStats.map(
      (stat) =>
        `${stat.vendor},${stat.totalUSD},${stat.percentage.toFixed(
          2
        )},${stat.vaultCount},${stat.vaultPercentage.toFixed(2)}`
    ),
  ];
  await writeFile(OUTPUT_CSV, csvLines.join("\n"));
  console.log(`💾 Saved CSV to ${OUTPUT_CSV}\n`);
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
