import { ethers } from "ethers";

/**
 * Sleep for a specified number of milliseconds
 */
export async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Require start block from .env - exit if not provided
 */
export function requireStartBlock(
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

/**
 * Helper function to query events in batches to avoid rate limits
 */
export async function queryEventsInBatches(
  contract: ethers.Contract,
  filter: ethers.ContractEventName | ethers.DeferredTopicFilter,
  fromBlock: number,
  toBlock: number,
  batchSize: number = 10000
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
