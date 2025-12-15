# Euler Oracle Dashboard

A comprehensive data pipeline for scraping, analyzing, and understanding the Euler Finance oracle ecosystem on Ethereum.

## Overview

This project consists of three main components:

1. **Web Scraper** - Extracts oracle data from Euler Finance's oracle directory
2. **Vendor Analyzer** - Categorizes and calculates market share of oracle providers
3. **Cross Oracle Analyzer** - Deep-dives into Cross oracles to identify their underlying oracle composition

## Installation

```bash
npm install
```

## Pipeline Workflow

### 1. Scrape Oracle Data

Scrapes all oracle data from the Euler Finance oracle directory (29 pages, ~580 oracles).

```bash
npm run scrape
```

**Features:**
- Scrapes oracle provider, base/quote tokens, price, checks, and contract addresses
- Progress tracking - automatically resumes if interrupted
- Retry logic - attempts failed pages up to 3 times
- Headless browser detection avoidance

**Outputs:**
- `euler-oracles.json` - Complete oracle data in JSON format
- `euler-oracles.csv` - Spreadsheet-friendly CSV format
- `scrape-progress.json` - Progress tracking (auto-deleted on completion)

**What's captured:**
- Page number
- Provider name
- Base token
- Quote token
- Price
- Number of checks
- Contract address
- Etherscan link

---

### 2. Analyze Vendor Distribution

Analyzes the scraped data to calculate market share of different oracle providers.

```bash
npm run analyze
```

**Tracked Vendors:**
- Chainlink
- RedStone (includes RedStone Pull)
- Pyth
- Pendle
- Chronicle
- Midas
- MEV Capital
- Cross (wrapper - excluded from combined %)
- Fixed Rate
- Rate Provider
- Lido Fundamental
- Resolv
- Idle
- Other (uncategorized oracles)

**Outputs:**
- `vendor-analysis.json` - Detailed statistics and breakdowns
- `vendor-analysis.csv` - Market share table with direct, underlying, and combined percentages
- `unknown-oracles.json` - List of uncategorized oracles (if any)
- `unknown-oracles.csv` - Spreadsheet format of uncategorized oracles

**Features:**
- **Direct Usage**: Counts oracles used directly in the system
- **Underlying Usage**: Counts oracle providers used within Cross adapters
- **Combined %**: Total market share excluding Cross (which is a wrapper)
- **Uncategorized Tracking**: Automatically exports oracles that couldn't be categorized

**Example Output:**
```
--- Vendor Market Share ---
Total Valid Oracles: 580
Cross Oracles Analyzed: 148
Total Underlying Oracles: 296

Target Vendors:
  Vendor             Direct   Underlying  Total Combined %
  ----------------- ------   ----------- ------ -----------
  Chainlink         87 (15.00%)   124 (41.89%)    211      29.07%
  Pendle            94 (16.21%)    69 (23.31%)    163      22.45%
  Cross            150 (25.86%)     9 (3.04%)     159         N/A
  Pyth              89 (15.34%)    33 (11.15%)    122      16.80%
  ...

--- Uncategorized Oracles ---
Found 5 oracles that couldn't be categorized
Details saved to unknown-oracles.json
```

**Understanding the Metrics:**

1. **Direct Count**: Number of times this oracle provider is used directly
2. **Direct %**: Percentage out of all direct oracles (580 total)
3. **Underlying Count**: Number of times used as underlying oracle in Cross adapters
4. **Underlying %**: Percentage out of all underlying oracle calls (296 total)
5. **Total Count**: Direct + Underlying
6. **Combined %**: Total share of actual oracle usage (Cross excluded from calculation)

**Why Cross Shows N/A:**
- Cross is a wrapper/adapter, not an actual oracle provider
- It's excluded from combined % to show true oracle provider market share
- The underlying oracles (Chainlink, Pyth, etc.) get the attribution instead

---

### 3. Analyze Cross Oracle Composition

Deep analysis of Cross oracles via RPC calls to identify their underlying oracle types.

```bash
npm run analyze-cross
```

**What it does:**
For each Cross oracle:
1. Calls `oracleBaseCross()` to get the first underlying oracle address
2. Calls `oracleCrossQuote()` to get the second underlying oracle address
3. Calls `name()` on each underlying oracle to identify its type
4. Stores the composition (e.g., "ChainlinkOracle + FixedRate")

**Features:**
- Rate limiting protection with automatic retries
- Progress tracking - resumes from where it stopped
- Exponential backoff for rate-limited requests
- Saves progress after each oracle analyzed
- Stops after 5 consecutive failures to prevent wasting time

**Configuration:**
```bash
# Use custom RPC endpoint
RPC_URL=https://your-rpc-endpoint npm run analyze-cross

# Default: https://eth.llamarpc.com
```

**Outputs:**
- `cross-oracle-analysis.json` - Detailed composition of all Cross oracles
- `cross-oracle-analysis.csv` - Spreadsheet format
- `cross-oracle-progress.json` - Progress tracking (auto-deleted on completion)

**Example Output:**
```
--- Cross Oracle Analysis Summary ---
Total Cross Oracles: 150
Successfully Analyzed: 148
Failed: 2

--- Underlying Oracle Types ---
  ChainlinkOracle           89  (30.1%)
  FixedRate                 67  (22.6%)
  PythOracle                45  (15.2%)
  ...

--- Cross Oracle Composition Examples ---
  WETH/USD: ChainlinkOracle + FixedRate
  wstETH/USD: CrossOracle + ChainlinkOracle
  ...
```

---

## Complete Workflow

Run the entire pipeline:

```bash
# Step 1: Scrape oracle data
npm run scrape

# Step 2: Analyze vendor distribution
npm run analyze

# Step 3: Analyze Cross oracle composition
npm run analyze-cross
```

## Output Files

| File | Description | Format |
|------|-------------|--------|
| `euler-oracles.json` | Complete scraped oracle data | JSON |
| `euler-oracles.csv` | Complete scraped oracle data | CSV |
| `vendor-analysis.json` | Vendor market share with direct/underlying/combined stats | JSON |
| `vendor-analysis.csv` | Vendor market share table (Direct %, Underlying %, Combined %) | CSV |
| `cross-oracle-analysis.json` | Cross oracle composition details | JSON |
| `cross-oracle-analysis.csv` | Cross oracle composition table | CSV |
| `unknown-oracles.json` | Uncategorized oracles needing classification | JSON |
| `unknown-oracles.csv` | Uncategorized oracles for review | CSV |

## Progress & Resume

All scripts support automatic resume:

**If scraping is interrupted:**
- Progress is saved in `scrape-progress.json`
- Run `npm run scrape` again to continue

**If Cross analysis hits rate limits:**
- Progress is saved in `cross-oracle-progress.json`
- Wait a few minutes
- Run `npm run analyze-cross` again to resume

Progress files are automatically deleted when the task completes successfully.

## Error Handling

### Scraping Errors
- Retries failed pages up to 3 times
- Saves progress before stopping
- Debug screenshots saved on failure

### Rate Limiting (Cross Analysis)
- Automatic detection of rate limit errors
- Exponential backoff: 5s → 10s → 15s → 20s → 25s
- Up to 5 retry attempts per request
- Stops after 5 consecutive failures
- Resume by running the script again

## Adding New Vendor Categories

When you run `npm run analyze`, uncategorized oracles are saved to `unknown-oracles.json/csv`. To add them to the analysis:

1. **Review uncategorized oracles:**
   ```bash
   cat unknown-oracles.json
   # or open unknown-oracles.csv in Excel/Sheets
   ```

2. **Add to vendor normalization:**
   Edit `analyze-vendors.js` and add to the `normalizeVendorName()` function:
   ```javascript
   if (providerLower.includes('newvendor')) return 'NewVendor';
   ```

3. **Add to target vendors list:**
   Add the vendor to `TARGET_VENDORS` array at the top of `analyze-vendors.js`

4. **Re-run analysis:**
   ```bash
   npm run analyze
   ```

The newly categorized oracles will now appear in the vendor analysis with their market share!

## Configuration

### RPC Endpoint
Set a custom RPC endpoint for Cross oracle analysis:
```bash
export RPC_URL=https://mainnet.infura.io/v3/YOUR_KEY
npm run analyze-cross
```

### Rate Limiting
Edit `analyze-cross-oracles.js` to adjust:
- `BASE_DELAY` - Delay between requests (default: 500ms)
- `RATE_LIMIT_DELAY` - Delay when rate limited (default: 5000ms)
- `MAX_RETRIES` - Max retries per oracle (default: 3)
- `MAX_CONSECUTIVE_FAILURES` - Stop after N failures (default: 5)

## Data Structure

### Oracle Entry
```json
{
  "page": 1,
  "provider": "Chainlink",
  "providerInfo": "Chainlink",
  "base": "WETH",
  "quote": "USD",
  "price": "$3,500.00",
  "checks": "(7)",
  "address": "0x1067...d84E1D",
  "addressLink": "https://etherscan.io/address/0x10674C8C1aE2072d4a75FE83f1E159425fd84E1D"
}
```

### Cross Oracle Analysis Entry
```json
{
  "crossAddress": "0x02dd...9528D7",
  "base": "wstETH",
  "quote": "USD",
  "page": 1,
  "baseCrossAddress": "0x1234...5678",
  "baseCrossName": "ChainlinkOracle",
  "crossQuoteAddress": "0xabcd...ef01",
  "crossQuoteName": "FixedRate",
  "resolvedNames": ["ChainlinkOracle", "FixedRate"]
}
```

## Requirements

- Node.js 16+
- npm or yarn
- Internet connection for scraping
- Ethereum RPC endpoint for Cross analysis (free public RPC included)

## Troubleshooting

**Scraper timing out:**
- The site may be blocking headless browsers
- Check `debug-page-*.png` and `debug-page-*.html` for clues
- Try increasing timeouts in `scrape-euler-oracles.js`

**Cross analysis failing:**
- Check RPC endpoint is working
- Try using a different RPC (Infura, Alchemy, etc.)
- Reduce `BASE_DELAY` if using a rate-limited RPC

**Out of memory:**
- Reduce batch sizes
- Process data in chunks
- Use streaming for large files

## License

MIT

## Contributing

Pull requests welcome! Please ensure all scripts maintain:
- Progress tracking and resume functionality
- Proper error handling
- Clear console output
- CSV + JSON output formats
