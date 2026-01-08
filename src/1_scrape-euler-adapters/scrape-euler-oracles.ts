import puppeteer, { Browser, Page } from "puppeteer";
import { promises as fs } from "fs";
import { existsSync } from "fs";

// Configuration
const PROGRESS_FILE = "scrape-progress.json";
const MAX_RETRIES = 3;
const TOTAL_PAGES = 29;

// Types
interface OracleData {
  page: number;
  provider: string;
  providerInfo: string;
  base: string;
  quote: string;
  price: string;
  checks: string;
  address: string;
  addressLink: string;
}

interface FailureInfo {
  attempts: number;
  lastError: string;
  timestamp: string;
}

interface Progress {
  oracles: OracleData[];
  completedPages: number[];
  failedPages: Record<number, FailureInfo>;
  lastUpdated?: string;
}

// Progress management
async function loadProgress(): Promise<Progress> {
  try {
    if (existsSync(PROGRESS_FILE)) {
      const data = await fs.readFile(PROGRESS_FILE, "utf-8");
      const progress: Progress = JSON.parse(data);
      console.log(
        `Found existing progress: ${progress.oracles.length} oracles from ${progress.completedPages.length} pages`
      );
      return progress;
    }
  } catch (error) {
    console.log("No valid progress file found, starting fresh");
  }
  return { oracles: [], completedPages: [], failedPages: {} };
}

async function saveProgress(
  oracles: OracleData[],
  completedPages: number[],
  failedPages: Record<number, FailureInfo>
): Promise<void> {
  const progress: Progress = {
    oracles,
    completedPages,
    failedPages,
    lastUpdated: new Date().toISOString(),
  };
  await fs.writeFile(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

// Scraping logic
async function scrapePage(page: Page, pageNum: number): Promise<OracleData[]> {
  const url = `https://oracles.euler.finance/1/?page=${pageNum}`;
  await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });

  // Give the page extra time to render after network is idle
  await page.waitForTimeout(3000);

  // Try to find the table with various selectors
  const selectors = [
    "table tbody tr",
    "table tr",
    '[role="table"]',
    "tbody tr",
    "tr",
  ];

  let foundSelector: string | null = null;
  for (const selector of selectors) {
    try {
      const elements = await page.$$(selector);
      if (elements.length > 0) {
        foundSelector = selector;
        console.log(
          `  Found selector: ${selector} (${elements.length} elements)`
        );
        break;
      }
    } catch (e) {
      continue;
    }
  }

  if (!foundSelector) {
    // Debug: save screenshot and HTML to see what's wrong
    await page.screenshot({ path: `debug-page-${pageNum}-fail.png` });
    const html = await page.content();
    await fs.writeFile(`debug-page-${pageNum}-fail.html`, html);
    console.log(
      `  Saved debug files: debug-page-${pageNum}-fail.png and .html`
    );
    throw new Error("No table selector found on page");
  }

  // Give extra time for all rows to render
  await page.waitForTimeout(2000);

  // Extract data from the table
  const pageData = await page.evaluate((currentPage: number): OracleData[] => {
    const rows = Array.from(
      document.querySelectorAll("table tbody tr")
    ) as HTMLTableRowElement[];

    return rows
      .map((row: HTMLTableRowElement) => {
        const cells = row.querySelectorAll("td");

        // Extract provider name (first column)
        const providerElement = cells[0]?.querySelector(
          '[class*="Provider"], h3, strong'
        );
        const provider =
          providerElement?.textContent?.trim() ||
          cells[0]?.textContent?.trim() ||
          "";

        // Extract additional provider info (the smaller text under provider name)
        const providerInfo =
          cells[0]
            ?.querySelector('p, small, [class*="text-sm"]')
            ?.textContent?.trim() || "";

        // Extract base token (second column)
        const base = cells[1]?.textContent?.trim() || "";

        // Extract quote token (third column)
        const quote = cells[2]?.textContent?.trim() || "";

        // Extract price (fourth column)
        const price = cells[3]?.textContent?.trim() || "";

        // Extract checks (fifth column)
        const checks = cells[4]?.textContent?.trim() || "";

        // Extract address (last column)
        const addressElement = cells[5]?.querySelector(
          "a"
        ) as HTMLAnchorElement | null;
        const address =
          addressElement?.textContent?.trim() ||
          cells[5]?.textContent?.trim() ||
          "";
        const addressLink = addressElement?.href || "";

        return {
          page: currentPage,
          provider,
          providerInfo,
          base,
          quote,
          price,
          checks,
          address,
          addressLink,
        };
      })
      .filter((item) => item.provider || item.base)
      .filter((item) => item.providerInfo != "Provider"); // Filter out empty rows, and header rows
  }, pageNum);

  console.log(`  ✓ Found ${pageData.length} oracles on page ${pageNum}`);
  return pageData;
}

async function scrapeEulerOracles(): Promise<void> {
  console.log("Launching browser...");
  const browser: Browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-features=IsolateOrigins,site-per-process",
      "--disable-web-security",
    ],
  });

  const page: Page = await browser.newPage();

  // Set user agent to avoid detection
  await page.setUserAgent(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  );

  // Remove webdriver property
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", {
      get: () => false,
    });
  });

  await page.setViewport({ width: 1920, height: 1080 });

  // Set a longer timeout for page loads
  page.setDefaultNavigationTimeout(60000);
  page.setDefaultTimeout(60000);

  // Load existing progress
  const progress = await loadProgress();
  const allOracles = progress.oracles;
  const completedPages = progress.completedPages;
  const failedPages = progress.failedPages;

  try {
    for (let pageNum = 1; pageNum <= TOTAL_PAGES; pageNum++) {
      // Skip if already completed
      if (completedPages.includes(pageNum)) {
        console.log(
          `Skipping page ${pageNum}/${TOTAL_PAGES} (already completed)...`
        );
        continue;
      }

      let retries = 0;
      let pageSuccess = false;

      while (retries <= MAX_RETRIES && !pageSuccess) {
        try {
          if (retries > 0) {
            console.log(`  Retry attempt ${retries}/${MAX_RETRIES}...`);
          }

          const pageData = await scrapePage(page, pageNum);
          allOracles.push(...pageData);
          completedPages.push(pageNum);

          // Save progress after each successful page
          await saveProgress(allOracles, completedPages, failedPages);

          pageSuccess = true;

          // Small delay between pages to be respectful
          await page.waitForTimeout(1000);
        } catch (error) {
          retries++;
          const errorMessage =
            error instanceof Error ? error.message : "Unknown error";
          console.error(
            `  ✗ Error on page ${pageNum} (attempt ${retries}/${
              MAX_RETRIES + 1
            }):`,
            errorMessage
          );

          if (retries > MAX_RETRIES) {
            failedPages[pageNum] = {
              attempts: retries,
              lastError: errorMessage,
              timestamp: new Date().toISOString(),
            };
            console.error(
              `  ✗ Failed to scrape page ${pageNum} after ${MAX_RETRIES} retries. Saving progress and stopping.`
            );

            // Save progress before stopping
            await saveProgress(allOracles, completedPages, failedPages);
            throw new Error(
              `Failed to scrape page ${pageNum} after ${MAX_RETRIES} retries`
            );
          }

          // Wait before retrying
          await page.waitForTimeout(2000);
        }
      }
    }

    console.log(`\nTotal oracles scraped: ${allOracles.length}`);
    console.log(`Pages completed: ${completedPages.length}/${TOTAL_PAGES}`);

    // Filter out the specific provider
    const filteredOracles = allOracles.filter(
      (oracle) => oracle.provider !== "ProviderClearChainlinkCrossRedStoneRedStone PullPythChronicleLido FundamentalRate ProviderFixed RateMidasResolvPendleUnknownLidoMEV CapitalIdle"
    );
    console.log(`Filtered out ${allOracles.length - filteredOracles.length} oracles with provider "ProviderClearChainlinkCrossRedStoneRedStone PullPythChronicleLido FundamentalRate ProviderFixed RateMidasResolvPendleUnknownLidoMEV CapitalIdle"`);

    // Save to JSON file
    const jsonOutput = JSON.stringify(filteredOracles, null, 2);
    await fs.writeFile("euler-oracles.json", jsonOutput);
    console.log("✓ Saved to euler-oracles.json");

    // Save to CSV file
    if (filteredOracles.length > 0) {
      const csvHeader =
        "Page,Provider,Provider Info,Base,Quote,Price,Checks,Address,Address Link\n";
      const csvRows = filteredOracles
        .map((oracle) => {
          return [
            oracle.page,
            oracle.provider,
            oracle.providerInfo,
            oracle.base,
            oracle.quote,
            oracle.price,
            oracle.checks,
            oracle.address,
            oracle.addressLink,
          ]
            .map((field) => `"${String(field).replace(/"/g, '""')}"`)
            .join(",");
        })
        .join("\n");

      await fs.writeFile("euler-oracles.csv", csvHeader + csvRows);
      console.log("✓ Saved to euler-oracles.csv");
    }

    // Print summary
    console.log("\n--- Summary ---");
    const providerCounts: Record<string, number> = {};
    filteredOracles.forEach((oracle) => {
      providerCounts[oracle.provider] =
        (providerCounts[oracle.provider] || 0) + 1;
    });
    console.log("Oracles by provider:");
    Object.entries(providerCounts)
      .sort((a, b) => b[1] - a[1])
      .forEach(([provider, count]) => {
        console.log(`  ${provider}: ${count}`);
      });

    // Show failed pages if any
    const failedPageNums = Object.keys(failedPages).map(Number);
    if (failedPageNums.length > 0) {
      console.log("\n--- Failed Pages ---");
      failedPageNums.forEach((pageNum) => {
        const failure = failedPages[pageNum]!;
        console.log(
          `  Page ${pageNum}: ${failure.lastError} (${failure.attempts} attempts)`
        );
      });
      console.log("\nRun the scraper again to retry failed pages.");
    } else if (completedPages.length === TOTAL_PAGES) {
      // All pages completed successfully, clean up progress file
      console.log("\n✓ All pages completed successfully!");
      try {
        await fs.unlink(PROGRESS_FILE);
        console.log("✓ Progress file cleaned up");
      } catch (e) {
        // Ignore if file doesn't exist
      }
    }
  } catch (error) {
    console.error("\nError during scraping:", error);
    console.log(
      "\nProgress has been saved. Run the scraper again to continue from where it left off."
    );
    throw error;
  } finally {
    await browser.close();
    console.log("\nBrowser closed.");
  }
}

// Run the scraper
scrapeEulerOracles()
  .then(() => {
    console.log("\n✓ Scraping completed successfully!");
    process.exit(0);
  })
  .catch((error) => {
    console.error("\n✗ Scraping failed:", error);
    process.exit(1);
  });
