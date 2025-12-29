import "dotenv/config";
import { promises as fs } from "fs";
import { existsSync } from "fs";
import { ethers } from "ethers";
import {
  groupByVendor,
  type Progress,
  type VendorInfo,
} from "./aggregate-vendors.js";

// Configuration
const RPC_URL = process.env.RPC_URL || "https://eth.llamarpc.com";
const PROGRESS_FILE = "vault-vendor-progress.json";
const ROUTER_DEPLOYMENTS_FILE = "router-deployments.json";
const VAULT_DEPLOYMENTS_FILE = "vault-deployments.json";
const GRAPH_TOKEN_API = "https://token-api.thegraph.com/v1/evm/balances";
const GRAPH_TOKEN_JWT = process.env.GRAPH_TOKEN_JWT || "";
const DIA_PRICE_API = "https://api.diadata.org/v1/assetQuotation/Ethereum";

// Contract addresses
const ROUTER_FACTORY = "0x70B3f6F61b7Bf237DF04589DdAA842121072326A";
const EVAULT_FACTORY = "0x29a56a1b8214D9Cf7c5561811750D5cBDb45CC8e";

// Start blocks from .env or defaults
const ROUTER_FACTORY_START_BLOCK = process.env.ROUTER_FACTORY_START_BLOCK
  ? parseInt(process.env.ROUTER_FACTORY_START_BLOCK)
  : null;
const EVAULT_FACTORY_START_BLOCK = process.env.EVAULT_FACTORY_START_BLOCK
  ? parseInt(process.env.EVAULT_FACTORY_START_BLOCK)
  : null;

// Recheck interval from .env (default: 50000 blocks ~7 days)
const RECHECK_INTERVAL_BLOCKS = process.env.RECHECK_INTERVAL_BLOCKS
  ? parseInt(process.env.RECHECK_INTERVAL_BLOCKS)
  : 50000;

// ABIs
const ROUTER_FACTORY_ABI = [
  "event ContractDeployed(address indexed router, address indexed deployer, uint256 timestamp)",
];

const EVAULT_FACTORY_ABI = [
  "event ProxyCreated(address indexed proxy, bool upgradeable, address implementation, bytes trailingData)",
];

const ROUTER_ABI = [
  "event ConfigSet(address indexed asset0, address indexed asset1, address indexed oracle)",
  "event ResolvedVaultSet(address indexed vault, address indexed asset)",
];

const EVAULT_ABI = [
  "function oracle() external view returns (address)",
  "function asset() external view returns (address)",
  "function totalAssets() external view returns (uint256)",
  "function balanceOf(address account) external view returns (uint256)",
];

const ERC20_ABI = [
  "function decimals() external view returns (uint8)",
  "function symbol() external view returns (string)",
  "function balanceOf(address account) external view returns (uint256)",
];

// Interfaces
interface OracleData {
  provider?: string;
  providerInfo?: string;
  addressLink?: string;
}

interface CrossOracleDetail {
  crossAddress?: string;
  baseCrossName?: string;
  crossQuoteName?: string;
  error?: string;
}

interface CrossOracleAnalysis {
  details?: CrossOracleDetail[];
}

interface LoadedOracleData {
  eulerOracles: OracleData[];
  crossAnalysis: CrossOracleAnalysis;
}

// Types imported from aggregate-vendors.ts:
// Progress, VaultInfo, RouterInfo, VendorInfo, VaultDetail, VendorTVLData, VendorStat, AnalysisOutput

interface RouterDeployment {
  address: string;
  deploymentBlock: number;
}

interface VaultDeployment {
  address: string;
  deploymentBlock: number;
}

interface TokenPrices {
  priceCache: Record<string, number>;
}

interface TokenApiResponse {
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

interface DiaPriceResponse {
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

// Progress tracking
async function loadProgress(): Promise<Progress> {
  try {
    if (existsSync(PROGRESS_FILE)) {
      const data = await fs.readFile(PROGRESS_FILE, "utf-8");
      return JSON.parse(data) as Progress;
    }
  } catch (error) {
    console.log("No valid progress file found, starting fresh");
  }
  return {
    routers: {},
    vaults: {},
    processedRouters: {},
    processedVaults: {},
  };
}

async function saveProgress(progress: Progress): Promise<void> {
  // Custom replacer to handle BigInt serialization
  const replacer = (_key: string, value: unknown) => {
    if (typeof value === "bigint") {
      return value.toString();
    }
    return value;
  };

  await fs.writeFile(PROGRESS_FILE, JSON.stringify(progress, replacer, 2));
}

// Save/load router deployments
async function saveRouterDeployments(
  deployments: RouterDeployment[]
): Promise<void> {
  await fs.writeFile(
    ROUTER_DEPLOYMENTS_FILE,
    JSON.stringify(deployments, null, 2)
  );
  console.log(
    `✓ Saved ${deployments.length} router deployments to ${ROUTER_DEPLOYMENTS_FILE}`
  );
}

async function loadRouterDeployments(): Promise<RouterDeployment[]> {
  try {
    if (existsSync(ROUTER_DEPLOYMENTS_FILE)) {
      const data = await fs.readFile(ROUTER_DEPLOYMENTS_FILE, "utf-8");
      return JSON.parse(data) as RouterDeployment[];
    }
  } catch (error) {
    console.log("No router deployments file found");
  }
  return [];
}

// Save/load vault deployments
async function saveVaultDeployments(
  deployments: VaultDeployment[]
): Promise<void> {
  await fs.writeFile(
    VAULT_DEPLOYMENTS_FILE,
    JSON.stringify(deployments, null, 2)
  );
  console.log(
    `✓ Saved ${deployments.length} vault deployments to ${VAULT_DEPLOYMENTS_FILE}`
  );
}

async function loadVaultDeployments(): Promise<VaultDeployment[]> {
  try {
    if (existsSync(VAULT_DEPLOYMENTS_FILE)) {
      const data = await fs.readFile(VAULT_DEPLOYMENTS_FILE, "utf-8");
      return JSON.parse(data) as VaultDeployment[];
    }
  } catch (error) {
    console.log("No vault deployments file found");
  }
  return [];
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Load existing oracle adapter data
async function loadOracleData(): Promise<LoadedOracleData> {
  try {
    const eulerOracles = JSON.parse(
      await fs.readFile("euler-oracles.json", "utf-8")
    ) as OracleData[];
    const crossAnalysis = JSON.parse(
      await fs.readFile("cross-oracle-analysis.json", "utf-8")
    ) as CrossOracleAnalysis;

    return { eulerOracles, crossAnalysis };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Unknown error";
    console.error("Error loading oracle data:", errorMsg);
    console.error(
      "Make sure you have run: npm run scrape && npm run analyze-cross && npm run analyze"
    );
    process.exit(1);
  }
}

// Get vendor for an oracle address
function getVendorForOracle(
  adapterAddress: string,
  oracleData: LoadedOracleData
): VendorInfo {
  const { eulerOracles, crossAnalysis } = oracleData;

  // Find oracle in euler-oracles.json
  const oracle = eulerOracles.find((el) => {
    const fullAddress = el.addressLink?.match(/0x[a-fA-F0-9]{40}/)?.[0];
    return fullAddress?.toLowerCase() === adapterAddress.toLowerCase();
  });

  if (!oracle) {
    return { vendor: "Unknown", underlying: [] };
  }

  const vendor = normalizeVendorName(oracle.providerInfo);

  // If it's a Cross oracle, get underlying vendors
  if (vendor === "Cross") {
    const crossOracle = crossAnalysis.details?.find(
      (c) => c.crossAddress?.toLowerCase() === adapterAddress.toLowerCase()
    );

    if (crossOracle && !crossOracle.error) {
      return {
        vendor: "Cross",
        underlying: [
          normalizeVendorName(crossOracle.baseCrossName),
          normalizeVendorName(crossOracle.crossQuoteName),
        ],
      };
    }
  }

  return { vendor, underlying: [] };
}

function normalizeVendorName(provider?: string): string {
  if (!provider) return "Unknown";
  const providerLower = provider.toLowerCase();

  if (providerLower.includes("chainlink")) return "Chainlink";
  if (providerLower.includes("redstone") || providerLower.includes("red stone"))
    return "RedStone";
  if (providerLower.includes("pyth")) return "Pyth";
  if (providerLower.includes("pendle")) return "Pendle";
  if (providerLower.includes("chronicle")) return "Chronicle";
  if (providerLower.includes("midas")) return "Midas";
  if (providerLower.includes("resolv")) return "Resolv";
  if (providerLower.includes("idle")) return "Idle";
  if (providerLower.includes("mev capital")) return "MEV Capital";
  if (providerLower.includes("cross")) return "Cross";
  if (providerLower.includes("fixed rate")) return "Fixed Rate";
  if (providerLower.includes("rate provider")) return "Rate Provider";
  if (providerLower.includes("lido fundamental")) return "Lido Fundamental";

  return "Other";
}

// Require start block from .env - exit if not provided
function requireStartBlock(
  blockVar: number | null,
  factoryName: string,
  envVarName: string
): number {
  if (!blockVar) {
    console.error(`\n✗ ERROR: ${envVarName} is not set in .env file`);
    console.error(`\nPlease add to your .env file:`);
    console.error(`${envVarName}=<deployment_block>`);
    console.error(`\nFactory: ${factoryName}`);
    console.error(`You can find deployment blocks on Etherscan.`);
    console.error(`\nExample:`);
    console.error(`ROUTER_FACTORY_START_BLOCK=19400000`);
    console.error(`EVAULT_FACTORY_START_BLOCK=19400000`);
    process.exit(1);
  }
  return blockVar;
}

// Helper function to query events in batches
async function queryEventsInBatches(
  contract: ethers.Contract,
  filter: ethers.ContractEventName | ethers.DeferredTopicFilter,
  fromBlock: number,
  toBlock: number,
  batchSize: number = 10000 // when using infura go back to 10_000
): Promise<ethers.EventLog[]> {
  const allEvents: ethers.EventLog[] = [];
  let currentBlock = fromBlock;

  while (currentBlock <= toBlock) {
    const endBlock = Math.min(currentBlock + batchSize - 1, toBlock);

    try {
      console.log(`  Querying blocks ${currentBlock} to ${endBlock}...`);
      const events = await contract.queryFilter(filter, currentBlock, endBlock);
      const eventLogs = events.filter(
        (e): e is ethers.EventLog => e instanceof ethers.EventLog
      );
      allEvents.push(...eventLogs);
      console.log(`  Found ${eventLogs.length} events`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Unknown error";
      console.error(
        `  Error querying blocks ${currentBlock}-${endBlock}: ${errorMsg}`
      );
      // Try with smaller batch if it fails
      if (batchSize > 1000) {
        console.log(`  Retrying with smaller batch size...`);
        const smallerBatch = await queryEventsInBatches(
          contract,
          filter,
          currentBlock,
          endBlock,
          Math.floor(batchSize / 2)
        );
        allEvents.push(...smallerBatch);
      }
    }

    currentBlock = endBlock + 1;
    await sleep(200); // Rate limit protection
  }

  return allEvents;
}

// Step 1a: Determine if router factory queries are needed
async function evaluateRouterFactoryQuery(
  progress: Progress,
  currentBlock: number
): Promise<{ fromBlock: number; shouldQueryFactory: boolean }> {
  // Load existing router deployments from file FIRST
  const allRouterDeployments = await loadRouterDeployments();
  console.log(
    `Loaded ${allRouterDeployments.length} existing router deployments from file`
  );

  let fromBlock: number;
  let shouldQueryFactory = false;

  if (progress.lastRouterFactoryBlock) {
    // We have a checkpoint - query from there
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
    // First run ever - need to query from start
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

// Step 1b: Query router factory for new deployments
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

  // Convert events to RouterDeployment objects
  const newDeployments: RouterDeployment[] = newDeploymentEvents
    .filter((event) => event && event.args?.router)
    .map((event) => ({
      address: event.args!.router as string,
      deploymentBlock: event.blockNumber,
    }));

  return newDeployments;
}

// Step 1c: Process router deployments and extract adapter configurations
async function processRouterDeployments(
  provider: ethers.JsonRpcProvider,
  oracleData: LoadedOracleData,
  allRouterDeployments: RouterDeployment[],
  currentBlock: number,
  progress: Progress
): Promise<Progress> {
  console.log(`\nTotal router deployments: ${allRouterDeployments.length}`);
  console.log(`Processing routers...\n`);

  // Process each router deployment
  for (let i = 0; i < allRouterDeployments.length; i++) {
    const deployment = allRouterDeployments[i]!;
    const routerAddress = deployment.address;
    const deploymentBlock = deployment.deploymentBlock;

    // Check if router needs processing or recheck
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
      // Time to recheck - query from last processed block + 1
      queryFromBlock = lastProcessedBlock + 1;
      isRecheck = true;
      console.log(
        `[${i + 1}/${
          allRouterDeployments.length
        }] Re-checking router ${routerAddress} ` +
          `(from block ${queryFromBlock})`
      );
    } else {
      // First time processing - query from deployment block
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

      // Get ConfigSet events from queryFromBlock (using batches to avoid rate limits)
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

      // Merge new events with existing data if this is a recheck
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

      // Map adapters to vendors
      const vendorInfo: Record<string, VendorInfo> = {};
      for (const adapter of adapters) {
        const info = getVendorForOracle(adapter, oracleData);
        vendorInfo[adapter] = info;
      }

      // Update router info
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

      // Mark as processed at current block
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

  // Save the current block as last queried block for router factory
  progress.lastRouterFactoryBlock = currentBlock;
  await saveProgress(progress);

  console.log(`\n✓ Analyzed ${Object.keys(progress.routers).length} routers`);
  console.log(`✓ Saved progress - last router factory block: ${currentBlock}`);
  return progress;
}

// Step 1: Orchestrate router analysis (wrapper function)
async function analyzeRouters(
  provider: ethers.JsonRpcProvider,
  oracleData: LoadedOracleData,
  progress: Progress
): Promise<Progress> {
  console.log("\n=== Step 1: Analyzing Routers ===\n");

  const factory = new ethers.Contract(
    ROUTER_FACTORY,
    ROUTER_FACTORY_ABI,
    provider
  );

  const currentBlock = await provider.getBlockNumber();
  console.log(`Current block: ${currentBlock}`);

  // 1a. Evaluate if we need to query the factory
  const { fromBlock, shouldQueryFactory } = await evaluateRouterFactoryQuery(
    progress,
    currentBlock
  );

  // 1b. Query factory for new deployments if needed
  let allRouterDeployments = await loadRouterDeployments();

  if (shouldQueryFactory) {
    const newDeployments = await queryRouterFactory(
      factory,
      fromBlock,
      currentBlock
    );

    // Merge new deployments with existing ones (avoid duplicates)
    const existingAddresses = new Set(
      allRouterDeployments.map((d) => d.address.toLowerCase())
    );
    for (const newDep of newDeployments) {
      if (!existingAddresses.has(newDep.address.toLowerCase())) {
        allRouterDeployments.push(newDep);
      }
    }

    // Save the complete list to file if we found new ones
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

// Step 2a: Determine if vault factory queries are needed
async function evaluateVaultFactoryQuery(
  progress: Progress,
  currentBlock: number
): Promise<{ fromBlock: number; shouldQueryFactory: boolean }> {
  // Load existing vault deployments from file FIRST
  const allVaultDeployments = await loadVaultDeployments();
  console.log(
    `Loaded ${allVaultDeployments.length} existing vault deployments from file`
  );

  let fromBlock: number;
  let shouldQueryFactory = false;

  if (progress.lastVaultFactoryBlock) {
    // We have a checkpoint - query from there
    fromBlock = progress.lastVaultFactoryBlock + 1;
    shouldQueryFactory = true;
    console.log(
      `Resuming factory queries from block ${fromBlock} (last queried: ${progress.lastVaultFactoryBlock})`
    );
  } else if (allVaultDeployments.length > 0) {
    // We have cached deployments but no checkpoint - only check recent blocks (last 10k)
    fromBlock = Math.max(currentBlock - 10000, 0);
    shouldQueryFactory = true;
    console.log(
      `Found cached deployments but no checkpoint - only checking recent blocks from ${fromBlock}`
    );
  } else {
    // First run ever - need to query from start
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

// Step 2b: Query vault factory for new deployments
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

  // Convert events to VaultDeployment objects
  const newDeployments: VaultDeployment[] = newProxyEvents
    .filter((event) => event && event.args?.proxy)
    .map((event) => ({
      address: event.args!.proxy as string,
      deploymentBlock: event.blockNumber,
    }));

  return newDeployments;
}

// Step 2c: Process vault deployments and map to oracle vendors
async function processVaultDeployments(
  provider: ethers.JsonRpcProvider,
  oracleData: LoadedOracleData,
  allVaultDeployments: VaultDeployment[],
  currentBlock: number,
  progress: Progress
): Promise<Progress> {
  console.log(`\nTotal vault deployments: ${allVaultDeployments.length}`);
  console.log(`Processing vaults...\n`);

  // Process each vault deployment
  for (let i = 0; i < allVaultDeployments.length; i++) {
    const deployment = allVaultDeployments[i]!;
    const vaultAddress = deployment.address;

    // Check if vault needs RPC requery based on interval
    const lastProcessedBlock = progress.processedVaults[vaultAddress];
    let shouldRequeryRpc = false;
    let isRecheck = false;

    if (lastProcessedBlock !== undefined) {
      const blocksSinceLastCheck = currentBlock - lastProcessedBlock;
      if (blocksSinceLastCheck < RECHECK_INTERVAL_BLOCKS) {
        // Don't requery RPC, but still update vendor logic
        console.log(
          `[${i + 1}/${allVaultDeployments.length}] Updating ${vaultAddress} ` +
            `(last RPC query ${blocksSinceLastCheck} blocks ago)`
        );
        shouldRequeryRpc = false;
        isRecheck = true;
      } else {
        // Time to requery RPC
        shouldRequeryRpc = true;
        isRecheck = true;
        console.log(
          `[${i + 1}/${
            allVaultDeployments.length
          }] Re-querying vault ${vaultAddress} (from RPC)`
        );
      }
    } else {
      // First time processing - need to query RPC
      shouldRequeryRpc = true;
      console.log(
        `[${i + 1}/${
          allVaultDeployments.length
        }] Analyzing vault ${vaultAddress} (first time)`
      );
    }

    try {
      // Get oracle and asset - either from cache or RPC
      let routerAddress: string;
      let assetAddress: string;

      const existingVaultInfo = progress.vaults[vaultAddress];

      if (
        !shouldRequeryRpc &&
        existingVaultInfo?.oracle &&
        existingVaultInfo?.asset
      ) {
        // Use cached data from progress (no RPC call needed)
        routerAddress = existingVaultInfo.oracle;
        assetAddress = existingVaultInfo.asset;
        console.log(`  Using cached oracle and asset from progress`);
      } else {
        // Fetch from RPC (first time or recheck interval passed)
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

      // Find the router this vault uses
      const routerInfo = progress.routers[routerAddress];

      let vendors: string[] = [];
      let vendorType = "Unknown";

      if (routerInfo) {
        // Get vendor info from router's adapters
        const vendorSet = new Set<string>();

        // Find asset pairs that include this vault's asset
        Object.entries(routerInfo.assetPairs).forEach(([pairKey, adapters]) => {
          // Split the pair key to get asset0 and asset1
          const [asset0, asset1] = pairKey.split("-");

          // Check if vault's asset matches either asset0 or asset1 (case-insensitive)
          const assetLower = assetAddress.toLowerCase();
          const matchesAsset0 = asset0?.toLowerCase() === assetLower;
          const matchesAsset1 = asset1?.toLowerCase() === assetLower;

          if (matchesAsset0 || matchesAsset1) {
            // This pair includes the vault's asset - get vendor info for each adapter
            adapters.forEach((adapterAddress) => {
              const vendorInfo = routerInfo.vendorInfo[adapterAddress];
              if (vendorInfo) {
                if (
                  vendorInfo.vendor === "Cross" &&
                  vendorInfo.underlying.length > 0
                ) {
                  // For Cross oracles, add underlying vendors
                  vendorInfo.underlying.forEach((v) => vendorSet.add(v));
                } else {
                  // Add the vendor directly
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
        // Try to get vendor directly from oracle address
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

      // Mark as processed at current block
      progress.processedVaults[vaultAddress] = currentBlock;
      // TODO: only save to file every X vaults
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

  // Save the current block as last queried block for vault factory
  progress.lastVaultFactoryBlock = currentBlock;
  await saveProgress(progress);

  console.log(`\n✓ Analyzed ${Object.keys(progress.vaults).length} vaults`);
  console.log(`✓ Saved progress - last vault factory block: ${currentBlock}`);
  return progress;
}

// Step 2: Orchestrate vault analysis (wrapper function)
async function analyzeVaults(
  provider: ethers.JsonRpcProvider,
  oracleData: LoadedOracleData,
  progress: Progress
): Promise<Progress> {
  console.log("\n=== Step 2: Analyzing Vaults ===\n");

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

    // Merge new deployments with existing ones (avoid duplicates)
    const existingAddresses = new Set(
      allVaultDeployments.map((d) => d.address.toLowerCase())
    );
    for (const newDep of newDeployments) {
      if (!existingAddresses.has(newDep.address.toLowerCase())) {
        allVaultDeployments.push(newDep);
      }
    }

    // Save the complete list to file if we found new ones
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

// Step 3: Get vault balances and USD values
async function getVaultBalances(
  provider: ethers.JsonRpcProvider,
  progress: Progress
): Promise<Progress> {
  console.log("\n=== Step 3: Getting Vault Balances ===\n");

  // Initialize token prices cache for fallback
  // TODO: remove this overengineered shit
  const tokenPrices = await getTokenPrices();

  for (const [vaultAddress, vaultInfo] of Object.entries(progress.vaults)) {
    if (vaultInfo.balance !== undefined) {
      console.log(`Skipping ${vaultAddress} (already has balance)`);
      continue;
    }

    console.log(`\nProcessing vault ${vaultAddress}`);

    try {
      // gets balance + USD value from Token API + DIA
      const apiResult = await getVaultBalanceAndValue(
        vaultAddress,
        vaultInfo.asset
      );

      if (apiResult) {
        // Success - use API data (balance from Graph + price from DIA)
        vaultInfo.balance = apiResult.balance;
        vaultInfo.balanceFormatted = apiResult.balanceFormatted;
        vaultInfo.decimals = apiResult.decimals;
        vaultInfo.symbol = apiResult.symbol;
        vaultInfo.price = apiResult.price;
        vaultInfo.usdValue = apiResult.usdValue;

        console.log(`  Symbol: ${apiResult.symbol}`);
        console.log(`  Balance: ${apiResult.balanceFormatted}`);
        console.log(`  Price: $${apiResult.price.toFixed(2)}`);
        console.log(`  USD Value: $${apiResult.usdValue.toLocaleString()}`);
      } else {
        // TODO: moves this into getVaultBalanceAndValue bc there is already a fallback there which can be merged
        // Fallback to RPC calls if Token API fails
        console.log(`  Token API failed, falling back to RPC...`);

        const vault = new ethers.Contract(vaultAddress, EVAULT_ABI, provider);
        const asset = new ethers.Contract(vaultInfo.asset, ERC20_ABI, provider);

        const [balance, decimals, symbol] = await Promise.all([
          vault.totalAssets?.() as Promise<bigint>,
          asset.decimals?.() as Promise<number>,
          asset.symbol?.() as Promise<string>,
        ]);

        if (balance === undefined || decimals === undefined || !symbol) {
          throw new Error(
            "Failed to get vault balance, asset decimals, or symbol"
          );
        }

        const balanceFormatted = ethers.formatUnits(balance, decimals);

        // Get USD value using fallback price method
        const price = await getTokenPrice(vaultInfo.asset, symbol, tokenPrices);
        const usdValue = price * parseFloat(balanceFormatted);

        vaultInfo.balance = balance.toString();
        vaultInfo.balanceFormatted = balanceFormatted;
        vaultInfo.decimals = decimals;
        vaultInfo.symbol = symbol;
        vaultInfo.price = price;
        vaultInfo.usdValue = usdValue;

        console.log(`  Symbol: ${symbol}`);
        console.log(`  Balance: ${balanceFormatted}`);
        console.log(`  Price: $${price.toFixed(2)}`);
        console.log(`  USD Value: $${usdValue.toLocaleString()}`);
      }

      await saveProgress(progress);
      await sleep(200);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Unknown error";
      console.error(`  ✗ Error getting balance: ${errorMsg}`);
      vaultInfo.error = errorMsg;
    }
  }

  console.log("\n✓ Retrieved vault balances");
  return progress;
}

// Get token prices using The Graph Token API
async function getTokenPrices(): Promise<TokenPrices> {
  console.log("Initializing token price cache with The Graph API...");

  // Cache for storing fetched prices
  const priceCache: Record<string, number> = {};

  return { priceCache };
}

// Get vault balance and USD value from Token API
// Get token price from DIA API
async function getTokenPriceFromDia(
  assetAddress: string
): Promise<number | null> {
  try {
    console.log(`  Fetching price from DIA API...`);

    const url = `${DIA_PRICE_API}/${assetAddress}`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const result = (await response.json()) as DiaPriceResponse;

    if (result.Price) {
      console.log(`  ✓ Price: $${result.Price.toFixed(4)}`);
      return result.Price;
    }

    console.log(`  No price data returned from DIA API`);
    return null;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Unknown error";
    console.error(`  ✗ Error fetching price from DIA API: ${errorMsg}`);
    return null;
  }
}

// Get vault balance from Graph Token API and price from DIA
async function getVaultBalanceAndValue(
  vaultAddress: string,
  assetAddress: string
): Promise<{
  balance: string;
  balanceFormatted: string;
  decimals: number;
  symbol: string;
  price: number;
  usdValue: number;
} | null> {
  try {
    if (!GRAPH_TOKEN_JWT) {
      throw new Error("GRAPH_TOKEN_JWT not set in .env");
    }

    console.log(`  Fetching balance from Token API...`);

    const url = new URL(GRAPH_TOKEN_API);
    url.searchParams.set("network", "mainnet");
    url.searchParams.set("address", vaultAddress.toLowerCase());
    url.searchParams.set("contract", assetAddress.toLowerCase());
    url.searchParams.set("include_null_balances", "false");
    url.searchParams.set("limit", "10");
    url.searchParams.set("page", "1");

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${GRAPH_TOKEN_JWT}`,
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const result = (await response.json()) as TokenApiResponse;

    if (result.data && result.data.length > 0 && result.data[0]) {
      const tokenData = result.data[0];
      const balanceFormatted = (
        parseFloat(tokenData.amount) /
        10 ** tokenData.decimals
      ).toFixed(6);

      console.log(`  ✓ Balance: ${balanceFormatted} ${tokenData.symbol}`);

      // Get price from DIA API
      const price = await getTokenPriceFromDia(assetAddress);

      if (price === null) {
        console.log(`  Using fallback price calculation...`);
        // Fallback to stablecoin assumption
        const stablecoins = [
          "USDC",
          "USDT",
          "USDe",
          "DAI",
          "FRAX",
          "LUSD",
          "USDS",
          "PYUSD",
          "FDUSD",
        ];
        const fallbackPrice = stablecoins.includes(
          tokenData.symbol.toUpperCase()
        )
          ? 1
          : 0;

        const usdValue = fallbackPrice * parseFloat(balanceFormatted);

        console.log(`  USD Value: $${usdValue.toFixed(2)}`);

        // Minimal rate limit protection
        await sleep(100);

        return {
          balance: tokenData.amount,
          balanceFormatted,
          decimals: tokenData.decimals,
          symbol: tokenData.symbol,
          price: fallbackPrice,
          usdValue,
        };
      }

      // Calculate USD value
      const usdValue = price * parseFloat(balanceFormatted);
      console.log(`  USD Value: $${usdValue.toFixed(2)}`);

      // Minimal rate limit protection
      await sleep(100);

      return {
        balance: tokenData.amount,
        balanceFormatted,
        decimals: tokenData.decimals,
        symbol: tokenData.symbol,
        price,
        usdValue,
      };
    }

    console.log(`  No balance data returned from Token API`);
    return null;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Unknown error";
    console.error(`  ✗ Error fetching balance and price: ${errorMsg}`);
    return null;
  }
}

// fallback if Token API fails
function getTokenPrice(
  address: string,
  symbol: string,
  tokenPrices: TokenPrices
): number {
  const { priceCache } = tokenPrices;

  // Check cache first
  const addressLower = address.toLowerCase();
  if (priceCache[addressLower]) {
    return priceCache[addressLower];
  }

  // Fallback to stablecoin assumption
  const stablecoins = [
    "USDC",
    "USDT",
    "USDe",
    "DAI",
    "FRAX",
    "LUSD",
    "USDS",
    "PYUSD",
    "FDUSD",
  ];
  if (stablecoins.includes(symbol.toUpperCase())) {
    console.log(`  Using $1 for stablecoin ${symbol}`);
    priceCache[addressLower] = 1;
    return 1;
  }

  return 0;
}

// Main function
async function main(): Promise<void> {
  console.log("=== Euler Vault-Vendor Analysis ===");
  console.log(`Using RPC: ${RPC_URL}\n`);

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const oracleData = await loadOracleData();
  let progress = await loadProgress();

  // Step 1: Analyze routers
  progress = await analyzeRouters(provider, oracleData, progress);

  // Step 2: Analyze vaults
  progress = await analyzeVaults(provider, oracleData, progress);

  // Step 3: Get balances and USD values
  progress = await getVaultBalances(provider, progress);

  // Step 4: Aggregate by vendor
  await groupByVendor(progress);

  // Clean up progress file
  try {
    // await fs.unlink(PROGRESS_FILE);
    // console.log("✓ Progress file cleaned up");
  } catch (e) {
    // Ignore
  }

  console.log("\n✓ Analysis completed successfully!");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\n✗ Analysis failed:", error);
    process.exit(1);
  });
