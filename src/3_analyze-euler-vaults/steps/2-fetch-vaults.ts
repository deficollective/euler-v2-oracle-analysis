import "dotenv/config";
import { ethers } from "ethers";
import type {
  Progress,
  VaultDeployment,
  LoadedOracleData,
} from "../lib/types.js";
import {
  loadProgress,
  saveProgress,
  loadVaultDeployments,
  saveVaultDeployments,
} from "../lib/progress.js";
import { loadOracleData } from "../lib/oracle-data.js";
import {
  queryEventsInBatches,
  sleep,
  requireStartBlock,
} from "../lib/utils.js";
import { getVendorForOracle } from "../lib/oracle-vendor-mapping.js";

// Configuration
const RPC_URL = process.env.RPC_URL || "https://eth.llamarpc.com";
const EVAULT_FACTORY = "0x29a56a1b8214D9Cf7c5561811750D5cBDb45CC8e";
const EVAULT_FACTORY_START_BLOCK = process.env.EVAULT_FACTORY_START_BLOCK
  ? parseInt(process.env.EVAULT_FACTORY_START_BLOCK)
  : null;
const RECHECK_INTERVAL_BLOCKS = process.env.RECHECK_INTERVAL_BLOCKS
  ? parseInt(process.env.RECHECK_INTERVAL_BLOCKS)
  : 50000;

// ABIs
const EVAULT_FACTORY_ABI = [
  "event ProxyCreated(address indexed proxy, bool upgradeable, address implementation, bytes trailingData)",
];

const EVAULT_ABI = [
  "function oracle() external view returns (address)",
  "function asset() external view returns (address)",
  "function totalAssets() external view returns (uint256)",
  "function balanceOf(address account) external view returns (uint256)",
];

/**
 * Step 2a: Determine if vault factory queries are needed
 */
async function evaluateVaultFactoryQuery(
  progress: Progress,
  currentBlock: number
): Promise<{ fromBlock: number; shouldQueryFactory: boolean }> {
  const allVaultDeployments = await loadVaultDeployments();
  console.log(
    `Loaded ${allVaultDeployments.length} existing vault deployments from file`
  );

  let fromBlock: number;
  let shouldQueryFactory = false;

  if (progress.lastVaultFactoryBlock) {
    fromBlock = progress.lastVaultFactoryBlock + 1;
    shouldQueryFactory = true;
    console.log(
      `Resuming factory queries from block ${fromBlock} (last queried: ${progress.lastVaultFactoryBlock})`
    );
  } else if (allVaultDeployments.length > 0) {
    fromBlock = Math.max(currentBlock - 10000, 0);
    shouldQueryFactory = true;
    console.log(
      `Found cached deployments but no checkpoint - only checking recent blocks from ${fromBlock}`
    );
  } else {
    fromBlock = requireStartBlock(
      EVAULT_FACTORY_START_BLOCK,
      EVAULT_FACTORY,
      "EVAULT_FACTORY_START_BLOCK"
    );
    shouldQueryFactory = true;
    console.log(
      `First run - starting from EVAULT_FACTORY_START_BLOCK: ${fromBlock}`
    );
  }

  return { fromBlock, shouldQueryFactory };
}

/**
 * Step 2b: Query vault factory for new deployments
 */
async function queryVaultFactory(
  factory: ethers.Contract,
  fromBlock: number,
  currentBlock: number
): Promise<VaultDeployment[]> {
  console.log(
    `\nQuerying factory for new deployments from block ${fromBlock} to ${currentBlock}...`
  );

  const proxyFilter = factory.filters.ProxyCreated?.();
  if (!proxyFilter) {
    throw new Error("ProxyCreated filter not found");
  }

  const newProxyEvents = await queryEventsInBatches(
    factory,
    proxyFilter,
    fromBlock,
    currentBlock
  );

  console.log(`Found ${newProxyEvents.length} NEW vault deployment events\n`);

  const newDeployments: VaultDeployment[] = newProxyEvents
    .filter((event) => event && event.args?.proxy)
    .map((event) => ({
      address: event.args!.proxy as string,
      deploymentBlock: event.blockNumber,
    }));

  return newDeployments;
}

/**
 * Step 2c: Process vault deployments and map to oracle vendors
 */
async function processVaultDeployments(
  provider: ethers.JsonRpcProvider,
  oracleData: LoadedOracleData,
  allVaultDeployments: VaultDeployment[],
  currentBlock: number,
  progress: Progress
): Promise<Progress> {
  console.log(`\nTotal vault deployments: ${allVaultDeployments.length}`);
  console.log(`Processing vaults...\n`);

  for (let i = 0; i < allVaultDeployments.length; i++) {
    const deployment = allVaultDeployments[i]!;
    const vaultAddress = deployment.address;

    const lastProcessedBlock = progress.processedVaults[vaultAddress];
    let shouldRequeryRpc = false;
    let isRecheck = false;

    if (lastProcessedBlock !== undefined) {
      const blocksSinceLastCheck = currentBlock - lastProcessedBlock;
      if (blocksSinceLastCheck < RECHECK_INTERVAL_BLOCKS) {
        console.log(
          `[${i + 1}/${allVaultDeployments.length}] Updating ${vaultAddress} ` +
            `(last RPC query ${blocksSinceLastCheck} blocks ago)`
        );
        shouldRequeryRpc = false;
        isRecheck = true;
      } else {
        shouldRequeryRpc = true;
        isRecheck = true;
        console.log(
          `[${i + 1}/${
            allVaultDeployments.length
          }] Re-querying vault ${vaultAddress} (from RPC)`
        );
      }
    } else {
      shouldRequeryRpc = true;
      console.log(
        `[${i + 1}/${
          allVaultDeployments.length
        }] Analyzing vault ${vaultAddress} (first time)`
      );
    }

    try {
      let routerAddress: string;
      let assetAddress: string;

      const existingVaultInfo = progress.vaults[vaultAddress];

      if (
        !shouldRequeryRpc &&
        existingVaultInfo?.oracle &&
        existingVaultInfo?.asset
      ) {
        routerAddress = existingVaultInfo.oracle;
        assetAddress = existingVaultInfo.asset;
        console.log(`  Using cached oracle and asset from progress`);
      } else {
        const vault = new ethers.Contract(vaultAddress, EVAULT_ABI, provider);

        [routerAddress, assetAddress] = await Promise.all([
          vault.oracle?.() as Promise<string>,
          vault.asset?.() as Promise<string>,
        ]);

        if (!routerAddress || !assetAddress) {
          throw new Error("Failed to get oracle or asset address");
        }
        console.log(`  Fetched oracle and asset from RPC`);
      }

      console.log(`  RouterAddress: ${routerAddress}`);
      console.log(`  Asset: ${assetAddress}`);

      const routerInfo = progress.routers[routerAddress];

      let vendors: string[] = [];
      let vendorType = "Unknown";

      if (routerInfo) {
        const vendorSet = new Set<string>();

        Object.entries(routerInfo.assetPairs).forEach(([pairKey, adapters]) => {
          const [asset0, asset1] = pairKey.split("-");

          const assetLower = assetAddress.toLowerCase();
          const matchesAsset0 = asset0?.toLowerCase() === assetLower;
          const matchesAsset1 = asset1?.toLowerCase() === assetLower;

          if (matchesAsset0 || matchesAsset1) {
            adapters.forEach((adapterAddress) => {
              const vendorInfo = routerInfo.vendorInfo[adapterAddress];
              if (vendorInfo) {
                if (
                  vendorInfo.vendor === "Cross" &&
                  vendorInfo.underlying.length > 0
                ) {
                  vendorInfo.underlying.forEach((v) => vendorSet.add(v));
                } else {
                  vendorSet.add(vendorInfo.vendor);
                }
              }
            });
          }
        });
        vendors = Array.from(vendorSet);
        vendorType =
          vendors.length === 1 ? vendors[0] ?? "Unknown" : "Multiple";
      } else {
        const info = getVendorForOracle(routerAddress, oracleData);
        if (info.vendor === "Cross" && info.underlying.length > 0) {
          vendors = info.underlying;
          vendorType = "Cross";
        } else {
          vendors = [info.vendor];
          vendorType = info.vendor;
        }
      }

      progress.vaults[vaultAddress] = {
        oracle: routerAddress,
        asset: assetAddress,
        vendors,
        vendorType,
        deploymentBlock: deployment.deploymentBlock,
      };

      progress.processedVaults[vaultAddress] = currentBlock;
      await saveProgress(progress);

      if (isRecheck) {
        console.log(`  ✓ Rechecked - Vendors: ${vendors.join(", ")}`);
      } else {
        console.log(`  ✓ Vendors: ${vendors.join(", ")}`);
      }

      await sleep(200);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Unknown error";
      console.error(`  ✗ Error analyzing vault: ${errorMsg}`);
    }
  }

  progress.lastVaultFactoryBlock = currentBlock;
  await saveProgress(progress);

  console.log(`\n✓ Analyzed ${Object.keys(progress.vaults).length} vaults`);
  console.log(`✓ Saved progress - last vault factory block: ${currentBlock}`);
  return progress;
}

/**
 * Main function: Scrape and analyze vault deployments
 */
export async function fetchVaults(
  provider: ethers.JsonRpcProvider,
  oracleData: LoadedOracleData,
  progress: Progress
): Promise<Progress> {
  console.log("\n=== Step 2: Scraping Vaults ===\n");

  const factory = new ethers.Contract(
    EVAULT_FACTORY,
    EVAULT_FACTORY_ABI,
    provider
  );

  const currentBlock = await provider.getBlockNumber();
  console.log(`Current block: ${currentBlock}`);

  // 2a. Evaluate if we need to query the factory
  const { fromBlock, shouldQueryFactory } = await evaluateVaultFactoryQuery(
    progress,
    currentBlock
  );

  // 2b. Query factory for new deployments if needed
  let allVaultDeployments = await loadVaultDeployments();

  if (shouldQueryFactory) {
    const newDeployments = await queryVaultFactory(
      factory,
      fromBlock,
      currentBlock
    );

    const existingAddresses = new Set(
      allVaultDeployments.map((d) => d.address.toLowerCase())
    );
    for (const newDep of newDeployments) {
      if (!existingAddresses.has(newDep.address.toLowerCase())) {
        allVaultDeployments.push(newDep);
      }
    }

    if (newDeployments.length > 0) {
      await saveVaultDeployments(allVaultDeployments);
    }
  } else {
    console.log(
      `Skipping factory queries - using ${allVaultDeployments.length} cached deployments`
    );
  }

  // 2c. Process all vault deployments
  progress = await processVaultDeployments(
    provider,
    oracleData,
    allVaultDeployments,
    currentBlock,
    progress
  );

  return progress;
}

// Allow running this step independently
if (import.meta.url === `file://${process.argv[1]}`) {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const oracleData = await loadOracleData();
  let progress = await loadProgress();

  progress = await fetchVaults(provider, oracleData, progress);

  console.log("\n✓ Vault scraping completed successfully!");
  process.exit(0);
}
