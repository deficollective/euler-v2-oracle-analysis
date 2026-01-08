import "dotenv/config";
import { ethers } from "ethers";
import { loadProgress } from "./lib/progress.js";
import { loadOracleData } from "./lib/oracle-data.js";
import { fetchRouters } from "./steps/1-fetch-routers.js";
import { fetchVaults } from "./steps/2-fetch-vaults.js";
import { fetchBalances } from "./steps/3-fetch-balances.js";
import { aggregateVendors } from "./steps/4-aggregate-vendors.js";

// Configuration
const RPC_URL = process.env.RPC_URL || "https://eth.llamarpc.com";

/**
 * Main orchestrator: Runs all analysis steps in sequence
 */
async function main(): Promise<void> {
  console.log("=== Euler Vault-Vendor Analysis ===");
  console.log(`Using RPC: ${RPC_URL}\n`);

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const oracleData = await loadOracleData();
  let progress = await loadProgress();

  // Step 1: fetch router deployments and configured price feed adapters
  progress = await fetchRouters(provider, oracleData, progress);

  // Step 2: fetch vault deployments and map price feed adapter to vault
  progress = await fetchVaults(provider, oracleData, progress);

  // Step 3: Fetch vault balances and USD values
  progress = await fetchBalances(provider, progress);

  // Step 4: Aggregate TVL by vendor
  await aggregateVendors(progress);

  console.log("\n✓ Analysis completed successfully!");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\n✗ Analysis failed:", error);
    process.exit(1);
  });
