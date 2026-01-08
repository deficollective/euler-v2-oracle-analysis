import { promises as fs } from "fs";
import type { LoadedOracleData, OracleData, CrossOracleAnalysis } from "./types.js";
import { loadVaultDeployments } from "./progress.js";

/**
 * Load existing oracle adapter data from previous analysis steps
 */
export async function loadOracleData(): Promise<LoadedOracleData> {
  try {
    const eulerOracles = JSON.parse(
      await fs.readFile("euler-oracles.json", "utf-8")
    ) as OracleData[];
    const crossAnalysis = JSON.parse(
      await fs.readFile("cross-oracle-analysis.json", "utf-8")
    ) as CrossOracleAnalysis;
    const vaultDeployments = await loadVaultDeployments();

    return { eulerOracles, crossAnalysis, vaultDeployments };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Unknown error";
    console.error("Error loading oracle data:", errorMsg);
    console.error(
      "Make sure you have run: npm run scrape && npm run analyze-cross && npm run analyze"
    );
    process.exit(1);
  }
}
