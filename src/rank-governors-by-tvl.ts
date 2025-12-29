import { promises as fs } from "fs";
import { existsSync } from "fs";
import type { Progress } from "./aggregate-vendors.js";

const INPUT_FILE = "vault-vendor-and-governor.json";
const OUTPUT_FILE = "governor-tvl-ranking.json";
const OUTPUT_CSV = "governor-tvl-ranking.csv";

interface GovernorTVL {
  address: string;
  name: string;
  totalTVL: number;
  vaultCount: number;
  vaults: {
    address: string;
    asset: string;
    value: number;
  }[];
}

function useAliasIfAvailable(address: string, name: string): string {
  if (address == "0x81ad394C0Fa87e99Ca46E1aca093BEe020f203f4") return "Usual";
  if (address == "0x9453ee262d7C95955e690AE7aBBD82a08B135685") return "Sentora";
  if (address == "0x35400831044167E9E2DE613d26515eeE37e30a1b") return "Euler";
  return name;
}

async function main() {
  console.log("\n📊 Governor TVL Ranking Analysis");
  console.log("=".repeat(80));

  // Check if input file exists
  if (!existsSync(INPUT_FILE)) {
    console.error(`❌ Error: ${INPUT_FILE} not found`);
    console.error("Please run analyze-vault-governors.ts first");
    process.exit(1);
  }

  // Load data
  const rawData = await fs.readFile(INPUT_FILE, "utf-8");
  const progress: Progress = JSON.parse(rawData);

  // Aggregate by governor
  const governorMap = new Map<string, GovernorTVL>();

  let totalVaultsWithNonZeroBalance: number = 0;

  for (const [vaultAddress, vaultInfo] of Object.entries(progress.vaults)) {
    // Skip vaults without USD value or governor info
    if (!vaultInfo.usdValue || vaultInfo.usdValue === 0) continue;
    if (!vaultInfo.governor_address) continue;

    const govAddress = vaultInfo.governor_address.toLowerCase();
    const govName = vaultInfo.governor_name || "Unknown";

    if (!governorMap.has(govAddress)) {
      governorMap.set(govAddress, {
        address: vaultInfo.governor_address,
        name: govName,
        totalTVL: 0,
        vaultCount: 0,
        vaults: [],
      });
    }

    const govData = governorMap.get(govAddress)!;
    govData.totalTVL += vaultInfo.usdValue;
    govData.vaultCount += 1;
    govData.vaults.push({
      address: vaultAddress,
      asset: vaultInfo.symbol || "Unknown",
      value: vaultInfo.usdValue,
    });
    totalVaultsWithNonZeroBalance++;
  }

  // Sort by TVL
  const sortedGovernors = Array.from(governorMap.values()).sort(
    (a, b) => b.totalTVL - a.totalTVL
  );

  // Calculate total TVL
  const totalTVL = sortedGovernors.reduce((sum, gov) => sum + gov.totalTVL, 0);

  // Get top 20
  const top20 = sortedGovernors.slice(0, 20);

  // Display results
  console.log(`\nTotal TVL: $${totalTVL.toLocaleString()}`);
  console.log(`Total Governors: ${sortedGovernors.length}\n`);

  console.log("=".repeat(140));
  console.log(
    `${"Rank".padStart(4)} ${"Governor Address".padEnd(42)} ${"Name".padEnd(
      20
    )} ${"TVL".padStart(20)} ${"TVL %".padStart(8)} ${"Vaults".padStart(
      8
    )} ${"Vault %".padStart(8)}`
  );
  console.log("=".repeat(140));

  top20.forEach((gov, index) => {
    const percentage = (gov.totalTVL / totalTVL) * 100;
    const vaultPercentage =
      (gov.vaultCount / totalVaultsWithNonZeroBalance) * 100;
    const displayName = useAliasIfAvailable(gov.address, gov.name);

    console.log(
      `${(index + 1).toString().padStart(4)} ${gov.address.padEnd(
        42
      )} ${displayName.slice(0, 20).padEnd(20)} $${gov.totalTVL
        .toLocaleString(undefined, { minimumFractionDigits: 2 })
        .padStart(18)} ${percentage.toFixed(2).padStart(7)}% ${gov.vaultCount
        .toString()
        .padStart(7)} ${vaultPercentage.toFixed(2).padStart(7)}%`
    );
  });

  console.log("=".repeat(140));

  // Calculate cumulative percentage for top 20
  const top20TVL = top20.reduce((sum, gov) => sum + gov.totalTVL, 0);
  const top20Percentage = (top20TVL / totalTVL) * 100;
  console.log(
    `\nTop 20 Governors control: $${top20TVL.toLocaleString()} (${top20Percentage.toFixed(
      2
    )}% of total TVL)\n`
  );

  // Save full ranking to JSON
  const output = {
    summary: {
      totalTVL,
      totalGovernors: sortedGovernors.length,
      analyzedAt: new Date().toISOString(),
    },
    rankings: sortedGovernors.map((gov, index) => ({
      rank: index + 1,
      address: gov.address,
      name: gov.name,
      totalTVL: gov.totalTVL,
      percentage: (gov.totalTVL / totalTVL) * 100,
      vaultCount: gov.vaultCount,
      vaults: gov.vaults,
    })),
  };

  await fs.writeFile(OUTPUT_FILE, JSON.stringify(output, null, 2));
  console.log(`💾 Saved full ranking to ${OUTPUT_FILE}`);

  // Save CSV
  const csvLines = [
    "Rank,Governor Address,Governor Name,TVL USD,% of Total,Vault Count",
    ...sortedGovernors.map((gov, index) => {
      const percentage = (gov.totalTVL / totalTVL) * 100;
      return `${index + 1},"${gov.address}","${gov.name}",${
        gov.totalTVL
      },${percentage.toFixed(2)},${gov.vaultCount}`;
    }),
  ];

  await fs.writeFile(OUTPUT_CSV, csvLines.join("\n"));
  console.log(`💾 Saved CSV to ${OUTPUT_CSV}\n`);
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
