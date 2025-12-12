const fs = require('fs').promises;

const TARGET_VENDORS = [
  'Chainlink',
  'RedStone',
  'Pyth',
  'Pendle',
  'Chronicle',
  'Midas',
  'MEV Capital',
  'Cross',
  'Fixed Rate',
  'Rate Provider',
  'Lido Fundamental'
];

function normalizeVendorName(provider) {
  if (!provider) return 'Unknown';

  const providerLower = provider.toLowerCase();

  // Check each target vendor (order matters - most specific first)
  if (providerLower.includes('chainlink')) return 'Chainlink';
  if (providerLower.includes('redstone') || providerLower.includes('red stone')) return 'RedStone';
  if (providerLower.includes('pyth')) return 'Pyth';
  if (providerLower.includes('pendle')) return 'Pendle';
  if (providerLower.includes('chronicle')) return 'Chronicle';
  if (providerLower.includes('midas')) return 'Midas';
  if (providerLower.includes('mev capital')) return 'MEV Capital';
  if (providerLower.includes('cross')) return 'Cross';
  if (providerLower.includes('fixed rate')) return 'Fixed Rate';
  if (providerLower.includes('rate provider')) return 'Rate Provider';
  if (providerLower.includes('lido fundamental')) return 'Lido Fundamental';

  // If not matching any target vendor, return as Other
  return 'Other';
}

async function analyzeVendors() {
  console.log('Reading oracle data...');

  // Read the scraped data
  let oracles;
  try {
    const data = await fs.readFile('euler-oracles.json', 'utf-8');
    oracles = JSON.parse(data);
  } catch (error) {
    console.error('Error reading euler-oracles.json:', error.message);
    console.error('Make sure you have run the scraper first: npm run scrape');
    process.exit(1);
  }

  console.log(`Found ${oracles.length} total oracle entries`);

  // Filter out header rows or invalid entries
  const validOracles = oracles.filter(oracle => {
    return oracle.provider &&
           oracle.provider !== 'Provider' &&
           oracle.provider !== 'ProviderClearChainlinkCrossRedStoneRedStone PullPythChronicleLido FundamentalRate ProviderFixed RateMidasResolvPendleUnknownLidoMEV CapitalIdle';
  });

  console.log(`Analyzing ${validOracles.length} valid oracle entries`);

  // Count oracles by vendor
  const vendorCounts = {};

  validOracles.forEach(oracle => {
    const vendor = normalizeVendorName(oracle.provider);
    vendorCounts[vendor] = (vendorCounts[vendor] || 0) + 1;
  });

  // Calculate percentages
  const total = validOracles.length;
  const vendorStats = [];

  Object.entries(vendorCounts).forEach(([vendor, count]) => {
    const percentage = ((count / total) * 100).toFixed(2);
    vendorStats.push({
      vendor,
      count,
      percentage: parseFloat(percentage),
      percentageFormatted: `${percentage}%`
    });
  });

  // Sort by count (descending)
  vendorStats.sort((a, b) => b.count - a.count);

  // Prepare output
  const output = {
    summary: {
      totalOracles: validOracles.length,
      uniqueVendors: vendorStats.length,
      analyzedAt: new Date().toISOString()
    },
    vendors: vendorStats,
    targetVendors: vendorStats.filter(stat => TARGET_VENDORS.includes(stat.vendor))
  };

  // Save to JSON
  await fs.writeFile('vendor-analysis.json', JSON.stringify(output, null, 2));
  console.log('✓ Saved to vendor-analysis.json');

  // Save to CSV
  const csvHeader = 'Vendor,Count,Percentage\n';
  const csvRows = vendorStats.map(stat => {
    return `"${stat.vendor}",${stat.count},${stat.percentage}%`;
  }).join('\n');
  await fs.writeFile('vendor-analysis.csv', csvHeader + csvRows);
  console.log('✓ Saved to vendor-analysis.csv');

  // Print summary
  console.log('\n--- Vendor Market Share ---');
  console.log(`Total Valid Oracles: ${total}\n`);

  console.log('Target Vendors:');
  vendorStats
    .filter(stat => TARGET_VENDORS.includes(stat.vendor))
    .forEach(stat => {
      const bar = '█'.repeat(Math.round(stat.percentage / 2));
      console.log(`  ${stat.vendor.padEnd(15)} ${stat.count.toString().padStart(4)} (${stat.percentageFormatted.padStart(6)}) ${bar}`);
    });

  const otherStats = vendorStats.filter(stat => !TARGET_VENDORS.includes(stat.vendor));
  if (otherStats.length > 0) {
    console.log('\nOther Vendors:');
    otherStats.forEach(stat => {
      const bar = '█'.repeat(Math.round(stat.percentage / 2));
      console.log(`  ${stat.vendor.padEnd(15)} ${stat.count.toString().padStart(4)} (${stat.percentageFormatted.padStart(6)}) ${bar}`);
    });
  }

  // Calculate total for target vendors
  const targetTotal = vendorStats
    .filter(stat => TARGET_VENDORS.includes(stat.vendor))
    .reduce((sum, stat) => sum + stat.count, 0);
  const targetPercentage = ((targetTotal / total) * 100).toFixed(2);

  console.log('\n--- Summary ---');
  console.log(`Target vendors: ${targetTotal} oracles (${targetPercentage}%)`);
  console.log(`Other vendors: ${total - targetTotal} oracles (${(100 - targetPercentage).toFixed(2)}%)`);
}

// Run the analysis
analyzeVendors()
  .then(() => {
    console.log('\n✓ Analysis completed successfully!');
    process.exit(0);
  })
  .catch(error => {
    console.error('\n✗ Analysis failed:', error);
    process.exit(1);
  });
