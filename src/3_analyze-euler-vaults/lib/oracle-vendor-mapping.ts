import type { LoadedOracleData, VendorInfo } from "./types.js";

/**
 * Normalize vendor names to consistent format
 */
export function normalizeVendorName(providerInfo?: string): string {
  if (!providerInfo) return "no oracle (escrow)";
  const providerLower = providerInfo.toLowerCase();

  if (providerLower.includes("euler vault")) return "Euler Vault";
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

/**
 * Get vendor information for an oracle adapter address
 */
export function getVendorForOracle(
  adapterAddress: string,
  oracleData: LoadedOracleData
): VendorInfo {
  const { eulerOracles, crossAnalysis, vaultDeployments } = oracleData;

  // First check if this address matches an Euler vault
  const matchingVault = vaultDeployments.find(
    (vault) => vault.address.toLowerCase() === adapterAddress.toLowerCase()
  );

  if (matchingVault) {
    return {
      vendor: "Euler Vault",
      underlying: [],
      vendorType: "vault",
    };
  }

  // Find oracle in euler-oracles.json
  const oracle = eulerOracles.find((el) => {
    const fullAddress = el.addressLink?.match(/0x[a-fA-F0-9]{40}/)?.[0];
    if (fullAddress === undefined) {
      return false;
    } else if (fullAddress === "0x0000000000000000000000000000000000000000") {
      return false;
    }
    return fullAddress?.toLowerCase() === adapterAddress.toLowerCase();
  });

  // Handle no oracle found
  if (!oracle) {
    return { vendor: "oracle not known", underlying: [], vendorType: "error" };
  }

  // Check for zero address (escrow)
  const fullAddress = oracle.addressLink?.match(/0x[a-fA-F0-9]{40}/)?.[0];
  if (fullAddress === "0x0000000000000000000000000000000000000000") {
    return {
      vendor: "no oracle (escrow)",
      underlying: [],
      vendorType: "no oracle (escrow)",
    };
  }

  // Handle undefined address
  if (!fullAddress) {
    return {
      vendor: "no oracle address stored",
      underlying: [],
      vendorType: "error",
    };
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
        vendorType: "external",
      };
    }
  }

  return { vendor, underlying: [], vendorType: "external" };
}
