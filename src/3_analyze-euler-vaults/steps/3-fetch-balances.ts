import "dotenv/config";
import { ethers } from "ethers";
import type {
  Progress,
  TokenPrices,
  TokenApiResponse,
  DiaPriceResponse,
} from "../lib/types.js";
import { loadProgress, saveProgress } from "../lib/progress.js";
import { sleep } from "../lib/utils.js";

// Configuration
const RPC_URL = process.env.RPC_URL || "https://eth.llamarpc.com";
const GRAPH_TOKEN_API = "https://token-api.thegraph.com/v1/evm/balances";
const GRAPH_TOKEN_JWT = process.env.GRAPH_TOKEN_JWT || "";
const DIA_PRICE_API = "https://api.diadata.org/v1/assetQuotation/Ethereum";

// ABIs
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

/**
 * Initialize token price cache
 */
function getTokenPrices(): TokenPrices {
  console.log("Initializing token price cache...");
  return { priceCache: {} };
}

/**
 * Get token price from DIA API
 */
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

/**
 * Get vault balance from Graph Token API and price from DIA
 */
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

      const usdValue = price * parseFloat(balanceFormatted);
      console.log(`  USD Value: $${usdValue.toFixed(2)}`);

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

/**
 * Fallback price lookup if Token API fails
 */
function getTokenPrice(
  address: string,
  symbol: string,
  tokenPrices: TokenPrices
): number {
  const { priceCache } = tokenPrices;

  const addressLower = address.toLowerCase();
  if (priceCache[addressLower]) {
    return priceCache[addressLower];
  }

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

/**
 * Main function: Fetch vault balances and USD values
 */
export async function fetchBalances(
  provider: ethers.JsonRpcProvider,
  progress: Progress
): Promise<Progress> {
  console.log("\n=== Step 3: Fetching Vault Balances ===\n");

  const tokenPrices = getTokenPrices();

  for (const [vaultAddress, vaultInfo] of Object.entries(progress.vaults)) {
    if (vaultInfo.balance !== undefined) {
      console.log(`Skipping ${vaultAddress} (already has balance)`);
      continue;
    }

    console.log(`\nProcessing vault ${vaultAddress}`);

    try {
      const apiResult = await getVaultBalanceAndValue(
        vaultAddress,
        vaultInfo.asset
      );

      if (apiResult) {
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

        const price = getTokenPrice(vaultInfo.asset, symbol, tokenPrices);
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

// Allow running this step independently
if (import.meta.url === `file://${process.argv[1]}`) {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  let progress = await loadProgress();

  progress = await fetchBalances(provider, progress);

  console.log("\n✓ Balance fetching completed successfully!");
  process.exit(0);
}
