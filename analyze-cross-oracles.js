const fs = require('fs').promises;
const fsSync = require('fs');
const { ethers } = require('ethers');

// RPC endpoint - you can change this to your preferred provider
const RPC_URL = process.env.RPC_URL || 'https://eth.llamarpc.com';

// Configuration
const PROGRESS_FILE = 'cross-oracle-progress.json';
const MAX_RETRIES = 3;
const BASE_DELAY = 500; // Base delay between requests in ms
const RATE_LIMIT_DELAY = 5000; // Delay when rate limited in ms
const MAX_RATE_LIMIT_RETRIES = 5;

// ABI for the functions we need to call
const CROSS_ORACLE_ABI = [
  'function oracleBaseCross() view returns (address)',
  'function oracleCrossQuote() view returns (address)'
];

const NAME_ABI = [
  'function name() view returns (string)'
];

async function loadProgress() {
  try {
    if (fsSync.existsSync(PROGRESS_FILE)) {
      const data = await fs.readFile(PROGRESS_FILE, 'utf-8');
      const progress = JSON.parse(data);
      console.log(`Found existing progress: ${progress.results.length} oracles analyzed`);
      return progress;
    }
  } catch (error) {
    console.log('No valid progress file found, starting fresh');
  }
  return { results: [], completedAddresses: [], failedAddresses: {} };
}

async function saveProgress(results, completedAddresses, failedAddresses) {
  const progress = {
    results,
    completedAddresses,
    failedAddresses,
    lastUpdated: new Date().toISOString()
  };
  await fs.writeFile(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

function isRateLimitError(error) {
  const errorMsg = error.message.toLowerCase();
  return errorMsg.includes('rate limit') ||
         errorMsg.includes('too many requests') ||
         errorMsg.includes('429') ||
         errorMsg.includes('exceeded');
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getOracleName(provider, address, retryCount = 0) {
  try {
    const contract = new ethers.Contract(address, NAME_ABI, provider);
    const name = await contract.name();
    return name;
  } catch (error) {
    if (isRateLimitError(error) && retryCount < MAX_RATE_LIMIT_RETRIES) {
      const delay = RATE_LIMIT_DELAY * (retryCount + 1);
      console.log(`    Rate limited, waiting ${delay}ms before retry...`);
      await sleep(delay);
      return getOracleName(provider, address, retryCount + 1);
    }
    console.log(`    Warning: Could not get name for ${address}: ${error.message}`);
    return 'Unknown';
  }
}

async function analyzeCrossOracle(provider, address, oracleData, retryCount = 0) {
  console.log(`\n  Analyzing Cross Oracle: ${address}`);
  console.log(`    Base: ${oracleData.base} | Quote: ${oracleData.quote}`);

  try {
    const crossContract = new ethers.Contract(address, CROSS_ORACLE_ABI, provider);

    // Get the two underlying oracle addresses
    console.log('    Fetching oracleBaseCross...');
    const baseCrossAddress = await crossContract.oracleBaseCross();
    console.log(`    → Base Cross Oracle: ${baseCrossAddress}`);

    await sleep(BASE_DELAY);

    console.log('    Fetching oracleCrossQuote...');
    const crossQuoteAddress = await crossContract.oracleCrossQuote();
    console.log(`    → Cross Quote Oracle: ${crossQuoteAddress}`);

    await sleep(BASE_DELAY);

    // Get the names of the underlying oracles
    console.log('    Fetching oracle names...');
    const baseCrossName = await getOracleName(provider, baseCrossAddress);
    await sleep(BASE_DELAY);
    const crossQuoteName = await getOracleName(provider, crossQuoteAddress);

    console.log(`    ✓ Base Cross: ${baseCrossName}`);
    console.log(`    ✓ Cross Quote: ${crossQuoteName}`);

    return {
      crossAddress: address,
      base: oracleData.base,
      quote: oracleData.quote,
      page: oracleData.page,
      baseCrossAddress,
      baseCrossName,
      crossQuoteAddress,
      crossQuoteName,
      resolvedNames: [baseCrossName, crossQuoteName]
    };

  } catch (error) {
    if (isRateLimitError(error) && retryCount < MAX_RETRIES) {
      const delay = RATE_LIMIT_DELAY * (retryCount + 1);
      console.log(`    Rate limited, waiting ${delay}ms before retry (attempt ${retryCount + 1}/${MAX_RETRIES})...`);
      await sleep(delay);
      return analyzeCrossOracle(provider, address, oracleData, retryCount + 1);
    }

    console.error(`    ✗ Error analyzing ${address}:`, error.message);
    return {
      crossAddress: address,
      base: oracleData.base,
      quote: oracleData.quote,
      page: oracleData.page,
      error: error.message,
      resolvedNames: []
    };
  }
}

async function analyzeCrossOracles() {
  console.log('Analyzing Cross Oracles...\n');
  console.log(`Using RPC: ${RPC_URL}\n`);

  // Read the oracle data
  let oracles;
  try {
    const data = await fs.readFile('euler-oracles.json', 'utf-8');
    oracles = JSON.parse(data);
  } catch (error) {
    console.error('Error reading euler-oracles.json:', error.message);
    console.error('Make sure you have run the scraper first: npm run scrape');
    process.exit(1);
  }

  // Filter for Cross oracles and extract full addresses from addressLink
  const crossOracles = oracles.filter(oracle => {
    const providerLower = (oracle.provider || '').toLowerCase();
    return providerLower.includes('cross') && oracle.addressLink;
  }).map(oracle => {
    // Extract full address from addressLink (e.g., "https://etherscan.io/address/0x123...")
    const match = oracle.addressLink.match(/0x[a-fA-F0-9]{40}/);
    return {
      ...oracle,
      fullAddress: match ? match[0] : null
    };
  }).filter(oracle => oracle.fullAddress);

  console.log(`Found ${crossOracles.length} Cross oracles to analyze\n`);

  if (crossOracles.length === 0) {
    console.log('No Cross oracles found. Make sure the data has been scraped and analyzed.');
    process.exit(0);
  }

  // Load existing progress
  const progress = await loadProgress();
  let results = progress.results;
  const completedAddresses = progress.completedAddresses;
  const failedAddresses = progress.failedAddresses;

  // Set up provider
  const provider = new ethers.JsonRpcProvider(RPC_URL);

  // Filter out already completed oracles
  const remainingOracles = crossOracles.filter(oracle =>
    !completedAddresses.includes(oracle.fullAddress)
  );

  console.log(`Remaining oracles to analyze: ${remainingOracles.length}/${crossOracles.length}\n`);

  if (remainingOracles.length === 0) {
    console.log('All oracles have already been analyzed!');
  }

  // Analyze each Cross oracle
  let consecutiveFailures = 0;
  const MAX_CONSECUTIVE_FAILURES = 5;

  for (let i = 0; i < remainingOracles.length; i++) {
    const oracle = remainingOracles[i];
    const address = oracle.fullAddress;
    const totalProcessed = completedAddresses.length + i + 1;

    console.log(`[${totalProcessed}/${crossOracles.length}] Processing ${address}`);

    try {
      const result = await analyzeCrossOracle(provider, address, oracle);

      if (result.error) {
        consecutiveFailures++;
        failedAddresses[address] = {
          error: result.error,
          attempts: (failedAddresses[address]?.attempts || 0) + 1,
          timestamp: new Date().toISOString()
        };

        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          console.error(`\n✗ ${MAX_CONSECUTIVE_FAILURES} consecutive failures detected. Saving progress and stopping.`);
          console.error('This might indicate persistent rate limiting or RPC issues.');
          console.error('Please wait a few minutes and run the script again to continue.\n');

          results.push(result);
          await saveProgress(results, completedAddresses, failedAddresses);

          console.log(`Progress saved. ${completedAddresses.length}/${crossOracles.length} oracles completed.`);
          process.exit(1);
        }
      } else {
        consecutiveFailures = 0; // Reset on success
        completedAddresses.push(address);
      }

      results.push(result);

      // Save progress after each oracle
      await saveProgress(results, completedAddresses, failedAddresses);

    } catch (error) {
      console.error(`\nUnexpected error processing ${address}:`, error.message);
      consecutiveFailures++;

      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        console.error('\nToo many consecutive failures. Saving progress and stopping.\n');
        await saveProgress(results, completedAddresses, failedAddresses);
        process.exit(1);
      }
    }

    // Delay between oracles to avoid rate limiting
    if (i < remainingOracles.length - 1) {
      await sleep(BASE_DELAY);
    }
  }

  // Generate summary statistics
  const nameCounts = {};
  results.forEach(result => {
    if (result.resolvedNames && result.resolvedNames.length > 0) {
      result.resolvedNames.forEach(name => {
        nameCounts[name] = (nameCounts[name] || 0) + 1;
      });
    }
  });

  // Save results
  const output = {
    summary: {
      totalCrossOracles: results.length,
      successful: results.filter(r => !r.error).length,
      failed: results.filter(r => r.error).length,
      analyzedAt: new Date().toISOString(),
      rpcEndpoint: RPC_URL
    },
    underlyingOracleTypes: nameCounts,
    details: results
  };

  await fs.writeFile('cross-oracle-analysis.json', JSON.stringify(output, null, 2));
  console.log('\n✓ Saved detailed results to cross-oracle-analysis.json');

  // Save CSV
  const csvHeader = 'Cross Address,Base,Quote,Page,Base Cross Address,Base Cross Name,Cross Quote Address,Cross Quote Name,Error\n';
  const csvRows = results.map(r => {
    return [
      r.crossAddress,
      r.base,
      r.quote,
      r.page,
      r.baseCrossAddress || '',
      r.baseCrossName || '',
      r.crossQuoteAddress || '',
      r.crossQuoteName || '',
      r.error || ''
    ].map(field => `"${String(field).replace(/"/g, '""')}"`).join(',');
  }).join('\n');

  await fs.writeFile('cross-oracle-analysis.csv', csvHeader + csvRows);
  console.log('✓ Saved to cross-oracle-analysis.csv');

  // Print summary
  console.log('\n--- Cross Oracle Analysis Summary ---');
  console.log(`Total Cross Oracles: ${crossOracles.length}`);
  console.log(`Successfully Analyzed: ${output.summary.successful}`);
  console.log(`Failed: ${output.summary.failed}`);

  console.log('\n--- Underlying Oracle Types ---');
  Object.entries(nameCounts)
    .sort((a, b) => b[1] - a[1])
    .forEach(([name, count]) => {
      const percentage = ((count / (output.summary.successful * 2)) * 100).toFixed(1);
      console.log(`  ${name.padEnd(25)} ${count.toString().padStart(3)} (${percentage}%)`);
    });

  console.log('\n--- Cross Oracle Composition Examples ---');
  results.filter(r => !r.error).slice(0, 5).forEach(r => {
    console.log(`  ${r.base}/${r.quote}: ${r.baseCrossName} + ${r.crossQuoteName}`);
  });

  // Show failed oracles if any
  const failedAddressList = Object.keys(failedAddresses);
  if (failedAddressList.length > 0) {
    console.log('\n--- Failed Oracles ---');
    failedAddressList.slice(0, 10).forEach(addr => {
      const failure = failedAddresses[addr];
      console.log(`  ${addr}: ${failure.error}`);
    });
    if (failedAddressList.length > 10) {
      console.log(`  ... and ${failedAddressList.length - 10} more`);
    }
    console.log('\nRun the script again to retry failed oracles.');
  } else if (completedAddresses.length === crossOracles.length) {
    // All oracles completed successfully, clean up progress file
    console.log('\n✓ All Cross oracles analyzed successfully!');
    try {
      await fs.unlink(PROGRESS_FILE);
      console.log('✓ Progress file cleaned up');
    } catch (e) {
      // Ignore if file doesn't exist
    }
  }
}

// Run the analysis
analyzeCrossOracles()
  .then(() => {
    console.log('\n✓ Cross oracle analysis completed successfully!');
    process.exit(0);
  })
  .catch(error => {
    console.error('\n✗ Analysis failed:', error);
    process.exit(1);
  });
