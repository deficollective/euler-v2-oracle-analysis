import "dotenv/config";
import { ethers } from "ethers";
import type {
  Progress,
  RouterDeployment,
  LoadedOracleData,
  VendorInfo,
} from "../lib/types.js";
import {
  loadProgress,
  saveProgress,
  loadRouterDeployments,
  saveRouterDeployments,
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
const ROUTER_FACTORY = "0x70B3f6F61b7Bf237DF04589DdAA842121072326A";
const ROUTER_FACTORY_START_BLOCK = process.env.ROUTER_FACTORY_START_BLOCK
  ? parseInt(process.env.ROUTER_FACTORY_START_BLOCK)
  : null;
const RECHECK_INTERVAL_BLOCKS = process.env.RECHECK_INTERVAL_BLOCKS
  ? parseInt(process.env.RECHECK_INTERVAL_BLOCKS)
  : 50000;

// ABIs
const ROUTER_FACTORY_ABI = [
  "event ContractDeployed(address indexed router, address indexed deployer, uint256 timestamp)",
];

const ROUTER_ABI = [
  "event ConfigSet(address indexed asset0, address indexed asset1, address indexed oracle)",
  "event ResolvedVaultSet(address indexed vault, address indexed asset)",
];

/**
 * Step 1a: Determine if router factory queries are needed
 */
async function evaluateRouterFactoryQuery(
  progress: Progress
): Promise<{ fromBlock: number; shouldQueryFactory: boolean }> {
  const allRouterDeployments = await loadRouterDeployments();
  console.log(
    `Loaded ${allRouterDeployments.length} existing router deployments from file`
  );

  let fromBlock: number;
  let shouldQueryFactory = false;

  if (progress.lastRouterFactoryBlock) {
    fromBlock = progress.lastRouterFactoryBlock + 1;
    const alternativeStart =
      allRouterDeployments[-1]?.deploymentBlock ?? fromBlock;
    fromBlock = alternativeStart > fromBlock ? fromBlock : alternativeStart;

    shouldQueryFactory = true;
    console.log(
      `Resuming factory queries from block ${fromBlock} (last queried: ${progress.lastRouterFactoryBlock})`
    );
  } else if (allRouterDeployments.length > 0) {
    fromBlock = allRouterDeployments[-1]?.deploymentBlock ?? 0;
    console.log(
      `Skipping factory queries - using ${allRouterDeployments.length} cached deployments`
    );
  } else {
    fromBlock = requireStartBlock(
      ROUTER_FACTORY_START_BLOCK,
      ROUTER_FACTORY,
      "ROUTER_FACTORY_START_BLOCK"
    );
    shouldQueryFactory = true;
    console.log(
      `First run - starting from ROUTER_FACTORY_START_BLOCK: ${fromBlock}`
    );
  }

  return { fromBlock, shouldQueryFactory };
}

/**
 * Step 1b: Query router factory for new deployments
 */
async function queryRouterFactory(
  factory: ethers.Contract,
  fromBlock: number,
  currentBlock: number
): Promise<RouterDeployment[]> {
  console.log(
    `\nQuerying factory for new deployments from block ${fromBlock} to ${currentBlock}...`
  );

  const deploymentFilter = factory.filters.ContractDeployed?.();
  if (!deploymentFilter) {
    throw new Error("ContractDeployed filter not found");
  }

  const newDeploymentEvents = await queryEventsInBatches(
    factory,
    deploymentFilter,
    fromBlock,
    currentBlock
  );

  console.log(
    `Found ${newDeploymentEvents.length} NEW router deployment events\n`
  );

  const newDeployments: RouterDeployment[] = newDeploymentEvents
    .filter((event) => event && event.args?.router)
    .map((event) => ({
      address: event.args!.router as string,
      deploymentBlock: event.blockNumber,
    }));

  return newDeployments;
}

/**
 * Step 1c: Process router deployments and extract adapter configurations
 */
async function processRouterDeployments(
  provider: ethers.JsonRpcProvider,
  oracleData: LoadedOracleData,
  allRouterDeployments: RouterDeployment[],
  currentBlock: number,
  progress: Progress
): Promise<Progress> {
  console.log(`\nTotal router deployments: ${allRouterDeployments.length}`);
  console.log(`Processing routers...\n`);

  for (let i = 0; i < allRouterDeployments.length; i++) {
    const deployment = allRouterDeployments[i]!;
    const routerAddress = deployment.address;
    const deploymentBlock = deployment.deploymentBlock;

    const lastProcessedBlock = progress.processedRouters[routerAddress];
    let queryFromBlock: number;
    let isRecheck = false;

    if (lastProcessedBlock !== undefined) {
      const blocksSinceLastCheck = currentBlock - lastProcessedBlock;
      if (blocksSinceLastCheck < RECHECK_INTERVAL_BLOCKS) {
        console.log(
          `[${i + 1}/${
            allRouterDeployments.length
          }] Skipping ${routerAddress} ` +
            `(checked ${blocksSinceLastCheck} blocks ago, recheck at ${RECHECK_INTERVAL_BLOCKS})`
        );
        continue;
      }
      queryFromBlock = lastProcessedBlock + 1;
      isRecheck = true;
      console.log(
        `[${i + 1}/${
          allRouterDeployments.length
        }] Re-checking router ${routerAddress} ` +
          `(from block ${queryFromBlock})`
      );
    } else {
      queryFromBlock = deploymentBlock;
      console.log(
        `[${i + 1}/${
          allRouterDeployments.length
        }] Analyzing router ${routerAddress} ` +
          `(first time, from block ${queryFromBlock})`
      );
    }

    try {
      const router = new ethers.Contract(routerAddress, ROUTER_ABI, provider);

      const configFilter = router.filters.ConfigSet?.();
      if (!configFilter) {
        throw new Error("ConfigSet filter not found");
      }
      const configEvents = await queryEventsInBatches(
        router,
        configFilter,
        queryFromBlock,
        currentBlock
      );

      let existingRouterInfo = progress.routers[routerAddress];
      const adapters =
        isRecheck && existingRouterInfo
          ? new Set(existingRouterInfo.adapters)
          : new Set<string>();
      const assetPairs: Record<string, string[]> =
        isRecheck && existingRouterInfo
          ? { ...existingRouterInfo.assetPairs }
          : {};

      configEvents.forEach((e) => {
        if (!(e instanceof ethers.EventLog)) return;
        const asset0 = e.args.asset0 as string;
        const asset1 = e.args.asset1 as string;
        const oracle = e.args.oracle as string;

        adapters.add(oracle);

        const key = `${asset0}-${asset1}`;
        if (!assetPairs[key]) {
          assetPairs[key] = [];
        }
        assetPairs[key].push(oracle);
      });

      const vendorInfo: Record<string, VendorInfo> = {};
      for (const adapter of adapters) {
        const info = getVendorForOracle(adapter, oracleData);
        vendorInfo[adapter] = info;
      }

      const totalConfigEvents =
        isRecheck && existingRouterInfo
          ? existingRouterInfo.configEventsCount + configEvents.length
          : configEvents.length;

      progress.routers[routerAddress] = {
        deploymentBlock,
        adapters: Array.from(adapters),
        assetPairs,
        vendorInfo,
        configEventsCount: totalConfigEvents,
        vaultEventsCount: 0,
      };

      progress.processedRouters[routerAddress] = currentBlock;
      await saveProgress(progress);

      if (isRecheck) {
        console.log(
          `  ✓ Found ${configEvents.length} new config events (total: ${totalConfigEvents})`
        );
      } else {
        console.log(
          `  ✓ Found ${adapters.size} adapters, ${configEvents.length} configs`
        );
      }

      await sleep(200);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Unknown error";
      console.error(`  ✗ Error analyzing router: ${errorMsg}`);
    }
  }

  progress.lastRouterFactoryBlock = currentBlock;
  await saveProgress(progress);

  console.log(`\n✓ Analyzed ${Object.keys(progress.routers).length} routers`);
  console.log(`✓ Saved progress - last router factory block: ${currentBlock}`);
  return progress;
}

/**
 * Main function: Scrape and analyze router deployments
 */
export async function fetchRouters(
  provider: ethers.JsonRpcProvider,
  oracleData: LoadedOracleData,
  progress: Progress
): Promise<Progress> {
  console.log("\n=== Step 1: Scraping Routers ===\n");

  const factory = new ethers.Contract(
    ROUTER_FACTORY,
    ROUTER_FACTORY_ABI,
    provider
  );

  const currentBlock = await provider.getBlockNumber();
  console.log(`Current block: ${currentBlock}`);

  // 1a. Evaluate if we need to query the factory
  const { fromBlock, shouldQueryFactory } = await evaluateRouterFactoryQuery(
    progress
  );

  // 1b. Query factory for new deployments if needed
  let allRouterDeployments = await loadRouterDeployments();

  if (shouldQueryFactory) {
    const newDeployments = await queryRouterFactory(
      factory,
      fromBlock,
      currentBlock
    );

    const existingAddresses = new Set(
      allRouterDeployments.map((d) => d.address.toLowerCase())
    );
    for (const newDep of newDeployments) {
      if (!existingAddresses.has(newDep.address.toLowerCase())) {
        allRouterDeployments.push(newDep);
      }
    }

    if (newDeployments.length > 0) {
      await saveRouterDeployments(allRouterDeployments);
    }
  }

  // 1c. Process all router deployments
  progress = await processRouterDeployments(
    provider,
    oracleData,
    allRouterDeployments,
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

  progress = await fetchRouters(provider, oracleData, progress);

  console.log("\n✓ Router scraping completed successfully!");
  process.exit(0);
}
