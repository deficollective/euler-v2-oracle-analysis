# Analyze Euler Vaults

This module scrapes and analyzes Euler vault deployments, mapping them to oracle vendors and calculating TVL distribution.

## Structure

```
analyze-euler-vaults/
├── steps/                    # Individual analysis steps
│   ├── 1-scrape-routers.ts   # Scrape router deployments and ConfigSet events
│   ├── 2-scrape-vaults.ts    # Scrape vault deployments and map to vendors
│   ├── 3-fetch-balances.ts   # Fetch vault balances and USD values
│   └── 4-aggregate-vendors.ts # Aggregate TVL by vendor
├── lib/                      # Shared utilities
│   ├── types.ts              # TypeScript interfaces
│   ├── utils.ts              # Helper functions (queryEventsInBatches, sleep, etc.)
│   ├── oracle-vendor-mapping.ts # Vendor name normalization and mapping
│   ├── oracle-data.ts        # Load oracle data from previous analysis
│   └── progress.ts           # Load/save progress and deployment files
├── output/                   # Output files (gitignored)
│   ├── vault-vendor-progress.json        # Checkpoint file with all analyzed data
│   ├── router-deployments.json           # Cached router deployments
│   ├── vault-deployments.json            # Cached vault deployments
│   ├── vault-vendor-analysis.json        # Final aggregated TVL by vendor
│   └── vault-vendor-analysis.csv         # CSV export of vendor analysis
└── index.ts                  # Main orchestrator (runs all steps)
```

## Usage

### Run Full Pipeline

```bash
bun run analyze-vaults
# or
bun run src/analyze-euler-vaults/index.ts
```

This runs all 4 steps in sequence:
1. Scrape router deployments
2. Scrape vault deployments
3. Fetch vault balances
4. Aggregate by vendor

### Run Individual Steps

You can run individual steps independently:

```bash
# Step 1: Scrape routers only
bun run src/analyze-euler-vaults/steps/1-scrape-routers.ts

# Step 2: Scrape vaults only
bun run src/analyze-euler-vaults/steps/2-scrape-vaults.ts

# Step 3: Fetch balances only
bun run src/analyze-euler-vaults/steps/3-fetch-balances.ts

# Step 4: Aggregate by vendor only
bun run src/analyze-euler-vaults/steps/4-aggregate-vendors.ts
```

## How It Works

### Step 1: Scrape Routers

- Queries the Router Factory for `ContractDeployed` events
- For each router, queries `ConfigSet` events to get oracle adapters
- Maps each adapter to its vendor (Chainlink, RedStone, Pyth, etc.)
- Caches router deployments to `output/router-deployments.json`
- Uses checkpoint system to avoid re-querying the blockchain

### Step 2: Scrape Vaults

- Queries the Vault Factory for `ProxyCreated` events
- For each vault, calls `oracle()` and `asset()` to get router and asset addresses
- Maps vaults to vendors by matching asset addresses with router asset pairs
- Caches vault deployments to `output/vault-deployments.json`
- Uses checkpoint system to minimize RPC calls

### Step 3: Fetch Balances

- Fetches vault balances using Graph Token API (faster)
- Fetches asset prices using DIA API
- Falls back to direct RPC calls if APIs fail
- Calculates USD value for each vault
- Stores balance, decimals, symbol, price, and USD value

### Step 4: Aggregate by Vendor

- Groups vaults by vendor
- Calculates total TVL per vendor
- Generates percentage distribution
- Outputs JSON and CSV files

## Configuration

Set these environment variables in `.env`:

```bash
# RPC endpoint
RPC_URL=https://eth.llamarpc.com

# Factory deployment blocks (required for first run)
ROUTER_FACTORY_START_BLOCK=19400000
EVAULT_FACTORY_START_BLOCK=19400000

# Recheck interval (default: 50000 blocks ~7 days)
RECHECK_INTERVAL_BLOCKS=50000

# API keys (optional but recommended)
GRAPH_TOKEN_JWT=your_graph_token_jwt
```

## Output Files

All output files are stored in `output/` folder:

- **vault-vendor-progress.json**: Complete checkpoint file with all scraped data
- **router-deployments.json**: List of all router deployments (cached)
- **vault-deployments.json**: List of all vault deployments (cached)
- **vault-vendor-analysis.json**: Aggregated TVL by vendor with vault details
- **vault-vendor-analysis.csv**: CSV export for spreadsheet analysis

## Smart Caching

The module uses a smart caching system:

1. **Deployment caching**: Router and vault deployments are cached to avoid re-querying factory events
2. **Progress checkpoints**: Tracks last processed block for each router/vault
3. **Recheck intervals**: Only re-queries entities after N blocks have passed
4. **Balance caching**: Skips balance fetching if already stored

This makes subsequent runs much faster!

## Dependencies

This module depends on previous analysis steps:

- `euler-oracles.json` - from `bun run scrape`
- `cross-oracle-analysis.json` - from `bun run analyze-cross`

Make sure to run these first:

```bash
bun run scrape
bun run analyze-cross
bun run analyze-vaults
```
