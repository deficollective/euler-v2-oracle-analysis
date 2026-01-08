import "dotenv/config";
import { promises as fs } from "fs";
import { existsSync } from "fs";
import { ethers } from "ethers";
import {
  groupByVendor,
  Progress,
} from "../4_filter-vault-analysis/aggregate-vendors.js";

// Configuration
const RPC_URL = process.env.RPC_URL || "https://eth.llamarpc.com";
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || "";
const INPUT_FILE =
  "src/3_analyze-euler-vaults/output/vault-vendor-progress.json";
const OUTPUT_FILE = "./data/vault-vendor-and-governor.json";

// Router ABI - only need governor() function
const ROUTER_ABI = ["function governor() external view returns (address)"];

interface EtherscanResponse {
  status: string;
  message: string;
  result:
    | string
    | {
        ContractName?: string;
        SourceCode?: string;
      }[];
}

/**
 * Checks if an address is an EOA or contract using Etherscan API
 * @param address - The address to check
 * @returns The contract name or "EOA" if it's an externally owned account
 */
async function getAddressInfo(address: string): Promise<string> {
  if (!ETHERSCAN_API_KEY) {
    console.log(
      `  ⚠️  No Etherscan API key - skipping contract name lookup for ${address}`
    );
    return "Unknown";
  }

  try {
    const url = `https://api.etherscan.io/v2/api?chainid=1&module=contract&action=getsourcecode&address=${address}&apikey=${ETHERSCAN_API_KEY}`;
    const response = await fetch(url);

    if (!response.ok) {
      console.log(
        `  ⚠️  HTTP Error: ${response.status} ${response.statusText}`
      );
      return "Unknown";
    }

    const data = (await response.json()) as EtherscanResponse;

    if (data.status !== "1") {
      console.log(`  ⚠️  Etherscan API error:`);
      console.log(`      Status: ${data.status}`);
      console.log(`      Message: ${data.message}`);
      console.log(
        `      Result: ${
          typeof data.result === "string"
            ? data.result
            : JSON.stringify(data.result)
        }`
      );

      // Check for rate limiting
      if (data.message && data.message.toLowerCase().includes("rate limit")) {
        console.log(`      → Rate limit exceeded, consider increasing delay`);
      }

      return "Unknown";
    }

    if (!Array.isArray(data.result)) {
      console.log(
        `  ⚠️  Unexpected result format: ${JSON.stringify(data.result)}`
      );
      return "Unknown";
    }

    const result = data.result[0];
    if (!result) {
      console.log(`  ⚠️  Empty result array`);
      return "Unknown";
    }

    // Check if it has source code (is a contract)
    if (result.SourceCode && result.SourceCode !== "") {
      return result.ContractName || "Contract (No Name)";
    }

    // No source code means it's an EOA
    return "EOA";
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Unknown error";
    console.log(`  ⚠️  Error checking address: ${errorMsg}`);
    if (error instanceof Error && error.stack) {
      console.log(`      Stack: ${error.stack.split("\n")[0]}`);
    }
    return "Unknown";
  }
}

/**
 * Loads the vault-vendor-progress.json file
 */
async function loadProgress(): Promise<Progress> {
  if (!existsSync(INPUT_FILE)) {
    throw new Error(
      `${INPUT_FILE} not found. Please run analyze-vault-vendors.ts first.`
    );
  }

  const data = await fs.readFile(INPUT_FILE, "utf-8");
  return JSON.parse(data) as Progress;
}

/**
 * Saves the progress with governor data
 */
async function saveProgress(progress: Progress): Promise<void> {
  await fs.writeFile(OUTPUT_FILE, JSON.stringify(progress, null, 2));
}

async function main(): Promise<void> {
  console.log("=== Euler Vault Governor Analysis ===");
  console.log(`Using RPC: ${RPC_URL}\n`);

  if (!ETHERSCAN_API_KEY) {
    console.log(
      "⚠️  Warning: No ETHERSCAN_API_KEY found in .env - contract name lookup will be skipped\n"
    );
  }

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  let progress = await loadProgress();

  const vaults = Object.entries(progress.vaults);
  const totalVaults = vaults.length;

  console.log(`Found ${totalVaults} vaults to analyze\n`);

  // Track unique governors
  const governorCache = new Map<string, string>();
  let processed = 0;
  let errors = 0;

  for (const [vaultAddress, vaultInfo] of vaults) {
    processed++;
    const router = vaultInfo.oracle;

    if (router === "0x0000000000000000000000000000000000000000") {
      vaultInfo.governor_address = "No Oracle Router (Escrow Vault)";
      vaultInfo.governor_name = "No Oracle Router (Escrow Vault)";
      continue;
    }

    console.log(
      `[${processed}/${totalVaults}] Processing vault ${vaultAddress} :`
    );
    console.log(`  Router: ${router}`);

    try {
      // Call governor() on the router
      const routerContract = new ethers.Contract(router, ROUTER_ABI, provider);
      const governorAddress = routerContract.governor
        ? ((await routerContract.governor()) as string)
        : "Unknown Governor Address";

      // error in case router not adhering to the standard (manually verified that this can be the case)
      console.log(`  Governor: ${governorAddress}`);

      // Store governor address
      vaultInfo.governor_address = governorAddress;

      // Check if we already looked up this governor
      let governorName: string;
      if (governorCache.has(governorAddress.toLowerCase())) {
        governorName = governorCache.get(governorAddress.toLowerCase())!;
        console.log(`  Governor name (cached): ${governorName}`);
      } else {
        // Look up on Etherscan
        governorName = await getAddressInfo(governorAddress);
        governorCache.set(governorAddress.toLowerCase(), governorName);
        console.log(`  Governor name: ${governorName}`);

        // Rate limit Etherscan API (5 requests per second)
        await new Promise((resolve) => setTimeout(resolve, 250));
      }

      vaultInfo.governor_name = governorName;
    } catch (error) {
      // Check if this is a CALL_EXCEPTION (function doesn't exist or execution reverted)
      if (
        error instanceof Error &&
        (error.message.includes("CALL_EXCEPTION") ||
          error.message.includes("execution reverted"))
      ) {
        console.log(`  ✗ Router does not implement governor() interface`);
        vaultInfo.governor_address =
          "Oracle Router does not comply with interface";
        vaultInfo.governor_name =
          "Oracle Router does not comply with interface";
      } else {
        const errorMsg =
          error instanceof Error ? error.message : "Unknown error";
        console.log(`  ✗ Error: ${errorMsg}`);
        vaultInfo.governor_address = "Error";
        vaultInfo.governor_name = `Error: ${errorMsg}`;
      }
      errors++;
    }

    console.log("");
  }

  // Save enhanced progress
  await saveProgress(progress);
  console.log(`✓ Saved enhanced data to ${OUTPUT_FILE}`);

  // Print summary
  console.log("\n=== Summary ===");
  console.log(`Total vaults: ${totalVaults}`);
  console.log(`Successfully processed: ${processed - errors}`);
  console.log(`Errors: ${errors}`);
  console.log(`Unique governors found: ${governorCache.size}\n`);

  // Print governor distribution
  const governorCounts = new Map<string, number>();
  for (const vaultInfo of Object.values(progress.vaults)) {
    const govName = vaultInfo.governor_name || "Unknown";
    governorCounts.set(govName, (governorCounts.get(govName) || 0) + 1);
  }

  console.log("--- Governor Distribution ---");
  const sortedGovs = Array.from(governorCounts.entries()).sort(
    (a, b) => b[1] - a[1]
  );
  for (const [name, count] of sortedGovs) {
    const percentage = ((count / totalVaults) * 100).toFixed(2);
    console.log(
      `${name.padEnd(40)} ${count.toString().padStart(4)} (${percentage}%)`
    );
  }

  // Run vendor aggregation
  console.log("\n");
  await groupByVendor(
    progress,
    "./data/vault-vendor-and-governor-analysis.json",
    "./data/vault-vendor-and-governor-analysis.csv"
  );
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
