const fs = require("fs").promises;

const TARGET_VENDORS = [
  "Chainlink",
  "RedStone",
  "Pyth",
  "Pendle",
  "Chronicle",
  "Midas",
  "MEV Capital",
  "Cross",
  "Fixed Rate",
  "Rate Provider",
  "Lido Fundamental",
];

function normalizeVendorName(provider) {
  if (!provider) return "Unknown";

  const providerLower = provider.toLowerCase();

  // Check each target vendor (order matters - most specific first)
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
  if (providerLower.includes("unkown")) return "Unkown";

  // If not matching any target vendor, return as Other
  return "Other";
}

async function analyzeVendors() {
  console.log("Reading oracle data...");

  // Read the scraped data
  let oracles;
  try {
    const data = await fs.readFile("euler-oracles.json", "utf-8");
    oracles = JSON.parse(data);
  } catch (error) {
    console.error("Error reading euler-oracles.json:", error.message);
    console.error("Make sure you have run the scraper first: npm run scrape");
    process.exit(1);
  }

  console.log(`Found ${oracles.length} total oracle entries`);

  // Read Cross oracle analysis data if available
  let crossOracleData = null;
  try {
    const crossData = await fs.readFile("cross-oracle-analysis.json", "utf-8");
    crossOracleData = JSON.parse(crossData);
    console.log(
      `Found Cross oracle analysis data: ${
        crossOracleData.details?.length || 0
      } Cross oracles analyzed`
    );
  } catch (error) {
    console.log(
      "No Cross oracle analysis data found (run npm run analyze-cross to generate it)"
    );
  }

  // Filter out header rows or invalid entries
  const validOracles = oracles.filter((oracle) => {
    return (
      oracle.provider &&
      oracle.provider !== "Provider" &&
      oracle.provider !==
        "ProviderClearChainlinkCrossRedStoneRedStone PullPythChronicleLido FundamentalRate ProviderFixed RateMidasResolvPendleUnknownLidoMEV CapitalIdle"
    );
  });

  console.log(`Analyzing ${validOracles.length} valid oracle entries`);

  // Count oracles by vendor (direct usage)
  const vendorCounts = {};
  const unknownOracles = [];

  validOracles.forEach((oracle) => {
    const vendor = normalizeVendorName(oracle.provider);
    vendorCounts[vendor] = (vendorCounts[vendor] || 0) + 1;

    // Track unknown/other oracles for investigation
    if (vendor === "Unknown" || vendor === "Other") {
      unknownOracles.push({
        provider: oracle.provider,
        providerInfo: oracle.providerInfo,
        base: oracle.base,
        quote: oracle.quote,
        address: oracle.address,
        addressLink: oracle.addressLink,
        page: oracle.page,
      });
    }
  });

  // Count underlying oracles from Cross adapters (indirect usage)
  const underlyingVendorCounts = {};
  let crossOraclesProcessed = 0;

  if (crossOracleData && crossOracleData.details) {
    crossOracleData.details.forEach((cross) => {
      // Skip entries with errors or missing data
      if (cross.error || !cross.baseCrossName || !cross.crossQuoteName) {
        return;
      }

      crossOraclesProcessed++;

      // Count base cross oracle
      const baseCrossVendor = normalizeVendorName(cross.baseCrossName);
      underlyingVendorCounts[baseCrossVendor] =
        (underlyingVendorCounts[baseCrossVendor] || 0) + 1;

      // Count cross quote oracle
      const crossQuoteVendor = normalizeVendorName(cross.crossQuoteName);
      underlyingVendorCounts[crossQuoteVendor] =
        (underlyingVendorCounts[crossQuoteVendor] || 0) + 1;
    });

    console.log(
      `Processed ${crossOraclesProcessed} Cross oracles with underlying oracle data`
    );
  }

  // Calculate combined vendor counts
  const combinedVendorCounts = {};

  // Add direct counts
  Object.entries(vendorCounts).forEach(([vendor, count]) => {
    combinedVendorCounts[vendor] = {
      direct: count,
      underlying: 0,
      total: count,
    };
  });

  // Add underlying counts
  Object.entries(underlyingVendorCounts).forEach(([vendor, count]) => {
    if (combinedVendorCounts[vendor]) {
      combinedVendorCounts[vendor].underlying = count;
      combinedVendorCounts[vendor].total += count;
    } else {
      combinedVendorCounts[vendor] = {
        direct: 0,
        underlying: count,
        total: count,
      };
    }
  });

  // Calculate percentages and create stats array
  const total = validOracles.length;
  const totalUnderlying = crossOraclesProcessed * 2; // Each cross oracle has 2 underlying oracles
  const crossDirectCount = vendorCounts["Cross"] || 0;
  // Exclude Cross from grand total since they're wrappers, not actual oracles
  const grandTotal = total - crossDirectCount + totalUnderlying;
  const vendorStats = [];

  Object.entries(combinedVendorCounts).forEach(([vendor, counts]) => {
    const directPercentage = ((counts.direct / total) * 100).toFixed(2);
    const underlyingPercentage =
      totalUnderlying > 0
        ? ((counts.underlying / totalUnderlying) * 100).toFixed(2)
        : "0.00";

    // Cross is a wrapper, exclude from combined % calculation
    const isCross = vendor === "Cross";
    const combinedPercentage = isCross
      ? null
      : grandTotal > 0
      ? ((counts.total / grandTotal) * 100).toFixed(2)
      : "0.00";

    vendorStats.push({
      vendor,
      directCount: counts.direct,
      underlyingCount: counts.underlying,
      totalCount: counts.total,
      directPercentage: parseFloat(directPercentage),
      underlyingPercentage: parseFloat(underlyingPercentage),
      combinedPercentage:
        combinedPercentage !== null ? parseFloat(combinedPercentage) : null,
      directPercentageFormatted: `${directPercentage}%`,
      underlyingPercentageFormatted: `${underlyingPercentage}%`,
      combinedPercentageFormatted:
        combinedPercentage !== null ? `${combinedPercentage}%` : "N/A",
    });
  });

  // Sort by total count (descending)
  vendorStats.sort((a, b) => b.totalCount - a.totalCount);

  // Prepare output
  const output = {
    summary: {
      totalOracles: validOracles.length,
      totalCrossOracles: crossOraclesProcessed,
      totalUnderlyingOracles: totalUnderlying,
      uniqueVendors: vendorStats.length,
      includeCrossAnalysis: crossOracleData !== null,
      analyzedAt: new Date().toISOString(),
    },
    vendors: vendorStats,
    targetVendors: vendorStats.filter((stat) =>
      TARGET_VENDORS.includes(stat.vendor)
    ),
  };

  // Save to JSON
  await fs.writeFile("vendor-analysis.json", JSON.stringify(output, null, 2));
  console.log("✓ Saved to vendor-analysis.json");

  // Save to CSV
  const csvHeader =
    "Vendor,Direct Count,Direct %,Underlying Count,Underlying %,Total Count,Combined %\n";
  const csvRows = vendorStats
    .map((stat) => {
      return [
        `"${stat.vendor}"`,
        stat.directCount,
        stat.directPercentageFormatted,
        stat.underlyingCount,
        stat.underlyingPercentageFormatted,
        stat.totalCount,
        stat.combinedPercentageFormatted,
      ].join(",");
    })
    .join("\n");
  await fs.writeFile("vendor-analysis.csv", csvHeader + csvRows);
  console.log("✓ Saved to vendor-analysis.csv");

  // Save unknown oracles list if any
  if (unknownOracles.length > 0) {
    await fs.writeFile(
      "unknown-oracles.json",
      JSON.stringify(unknownOracles, null, 2)
    );
    console.log(
      `✓ Saved ${unknownOracles.length} unknown oracles to unknown-oracles.json`
    );

    // Also save as CSV
    const unknownCsvHeader =
      "Provider,Provider Info,Base,Quote,Address,Address Link,Page\n";
    const unknownCsvRows = unknownOracles
      .map((oracle) => {
        return [
          `"${oracle.provider || ""}"`,
          `"${oracle.providerInfo || ""}"`,
          `"${oracle.base || ""}"`,
          `"${oracle.quote || ""}"`,
          `"${oracle.address || ""}"`,
          `"${oracle.addressLink || ""}"`,
          oracle.page || "",
        ].join(",");
      })
      .join("\n");
    await fs.writeFile(
      "unknown-oracles.csv",
      unknownCsvHeader + unknownCsvRows
    );
    console.log("✓ Saved to unknown-oracles.csv");
  }

  // Print summary
  console.log("\n--- Vendor Market Share ---");
  console.log(`Total Valid Oracles: ${total}`);
  if (crossOracleData) {
    console.log(`Cross Oracles Analyzed: ${crossOraclesProcessed}`);
    console.log(`Total Underlying Oracles: ${totalUnderlying}`);
  }
  console.log("");

  console.log("Target Vendors:");
  console.log(
    `  ${"Vendor".padEnd(17)} ${"Direct".padStart(6)} ${"Underlying".padStart(
      11
    )} ${"Total".padStart(6)} ${"Combined %".padStart(11)}`
  );
  console.log(
    `  ${"-".repeat(17)} ${"-".repeat(6)} ${"-".repeat(11)} ${"-".repeat(
      6
    )} ${"-".repeat(11)}`
  );

  vendorStats
    .filter((stat) => TARGET_VENDORS.includes(stat.vendor))
    .forEach((stat) => {
      const directStr =
        `${stat.directCount} (${stat.directPercentageFormatted})`.padStart(13);
      const underlyingStr =
        `${stat.underlyingCount} (${stat.underlyingPercentageFormatted})`.padStart(
          15
        );
      const totalStr = stat.totalCount.toString().padStart(6);
      const combinedStr = (stat.combinedPercentageFormatted || "N/A").padStart(
        11
      );
      console.log(
        `  ${stat.vendor.padEnd(
          17
        )} ${directStr} ${underlyingStr} ${totalStr} ${combinedStr}`
      );
    });

  const otherStats = vendorStats.filter(
    (stat) => !TARGET_VENDORS.includes(stat.vendor)
  );
  if (otherStats.length > 0) {
    console.log("\nOther Vendors:");
    otherStats.forEach((stat) => {
      const directStr =
        `${stat.directCount} (${stat.directPercentageFormatted})`.padStart(13);
      const underlyingStr =
        `${stat.underlyingCount} (${stat.underlyingPercentageFormatted})`.padStart(
          15
        );
      const totalStr = stat.totalCount.toString().padStart(6);
      const combinedStr = (stat.combinedPercentageFormatted || "N/A").padStart(
        11
      );
      console.log(
        `  ${stat.vendor.padEnd(
          17
        )} ${directStr} ${underlyingStr} ${totalStr} ${combinedStr}`
      );
    });
  }

  // Calculate total for target vendors
  const targetTotalDirect = vendorStats
    .filter((stat) => TARGET_VENDORS.includes(stat.vendor))
    .reduce((sum, stat) => sum + stat.directCount, 0);
  const targetTotalUnderlying = vendorStats
    .filter((stat) => TARGET_VENDORS.includes(stat.vendor))
    .reduce((sum, stat) => sum + stat.underlyingCount, 0);
  const targetPercentage = ((targetTotalDirect / total) * 100).toFixed(2);

  console.log("\n--- Summary ---");
  console.log(
    `Target vendors (direct): ${targetTotalDirect} oracles (${targetPercentage}%)`
  );
  if (crossOracleData) {
    const targetUnderlyingPercentage =
      totalUnderlying > 0
        ? ((targetTotalUnderlying / totalUnderlying) * 100).toFixed(2)
        : "0.00";
    console.log(
      `Target vendors (underlying): ${targetTotalUnderlying} oracles (${targetUnderlyingPercentage}%)`
    );
    console.log(
      `Target vendors (total): ${
        targetTotalDirect + targetTotalUnderlying
      } oracle usages`
    );
  }
  console.log(
    `Other vendors: ${total - targetTotalDirect} oracles (${(
      100 - targetPercentage
    ).toFixed(2)}%)`
  );

  // Show unknown/uncategorized oracles if any
  if (unknownOracles.length > 0) {
    console.log("\n--- Uncategorized Oracles ---");
    console.log(
      `Found ${unknownOracles.length} oracles that couldn't be categorized`
    );
    console.log("Details saved to unknown-oracles.json and unknown-oracles.csv");
    console.log("\nFirst 10 uncategorized oracles:");
    unknownOracles.slice(0, 10).forEach((oracle, idx) => {
      console.log(
        `  ${idx + 1}. ${oracle.provider} (${oracle.base}/${oracle.quote})`
      );
    });
    if (unknownOracles.length > 10) {
      console.log(`  ... and ${unknownOracles.length - 10} more`);
    }
  }
}

// Run the analysis
analyzeVendors()
  .then(() => {
    console.log("\n✓ Analysis completed successfully!");
    process.exit(0);
  })
  .catch((error) => {
    console.error("\n✗ Analysis failed:", error);
    process.exit(1);
  });
