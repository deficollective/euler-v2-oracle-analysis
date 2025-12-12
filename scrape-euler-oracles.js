const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const fsSync = require('fs');

const PROGRESS_FILE = 'scrape-progress.json';
const MAX_RETRIES = 3;

async function loadProgress() {
  try {
    if (fsSync.existsSync(PROGRESS_FILE)) {
      const data = await fs.readFile(PROGRESS_FILE, 'utf-8');
      const progress = JSON.parse(data);
      console.log(`Found existing progress: ${progress.oracles.length} oracles from ${progress.completedPages.length} pages`);
      return progress;
    }
  } catch (error) {
    console.log('No valid progress file found, starting fresh');
  }
  return { oracles: [], completedPages: [], failedPages: {} };
}

async function saveProgress(oracles, completedPages, failedPages) {
  const progress = {
    oracles,
    completedPages,
    failedPages,
    lastUpdated: new Date().toISOString()
  };
  await fs.writeFile(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

async function scrapeEulerOracles() {
  console.log('Launching browser...');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-web-security'
    ]
  });

  const page = await browser.newPage();

  // Set user agent to avoid detection
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  // Remove webdriver property
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', {
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

  const totalPages = 29;

  try {
    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
      // Skip if already completed
      if (completedPages.includes(pageNum)) {
        console.log(`Skipping page ${pageNum}/${totalPages} (already completed)...`);
        continue;
      }

      let retries = 0;
      let pageSuccess = false;

      while (retries <= MAX_RETRIES && !pageSuccess) {
        try {
          if (retries > 0) {
            console.log(`  Retry attempt ${retries}/${MAX_RETRIES}...`);
          }

          const url = `https://oracles.euler.finance/1/?page=${pageNum}`;
          await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

          // Give the page extra time to render after network is idle
          await page.waitForTimeout(3000);

          // Try to find the table with various selectors
          const selectors = [
            'table tbody tr',
            'table tr',
            '[role="table"]',
            'tbody tr',
            'tr'
          ];

          let foundSelector = null;
          for (const selector of selectors) {
            try {
              const elements = await page.$$(selector);
              if (elements.length > 0) {
                foundSelector = selector;
                console.log(`  Found selector: ${selector} (${elements.length} elements)`);
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
            console.log(`  Saved debug files: debug-page-${pageNum}-fail.png and .html`);
            throw new Error('No table selector found on page');
          }

          // Give extra time for all rows to render
          await page.waitForTimeout(2000);

          // Extract data from the table
          const pageData = await page.evaluate((currentPage) => {
            const rows = Array.from(document.querySelectorAll('table tbody tr'));

            return rows.map(row => {
              const cells = row.querySelectorAll('td');

              // Extract provider name (first column)
              const providerElement = cells[0]?.querySelector('[class*="Provider"], h3, strong');
              const provider = providerElement?.textContent?.trim() ||
                              cells[0]?.textContent?.trim() || '';

              // Extract additional provider info (the smaller text under provider name)
              const providerInfo = cells[0]?.querySelector('p, small, [class*="text-sm"]')?.textContent?.trim() || '';

              // Extract base token (second column)
              const base = cells[1]?.textContent?.trim() || '';

              // Extract quote token (third column)
              const quote = cells[2]?.textContent?.trim() || '';

              // Extract price (fourth column)
              const price = cells[3]?.textContent?.trim() || '';

              // Extract checks (fifth column)
              const checks = cells[4]?.textContent?.trim() || '';

              // Extract address (last column)
              const addressElement = cells[5]?.querySelector('a');
              const address = addressElement?.textContent?.trim() ||
                             cells[5]?.textContent?.trim() || '';
              const addressLink = addressElement?.href || '';

              return {
                page: currentPage,
                provider,
                providerInfo,
                base,
                quote,
                price,
                checks,
                address,
                addressLink
              };
            }).filter(item => item.provider || item.base); // Filter out empty rows
          }, pageNum);

          console.log(`  ✓ Found ${pageData.length} oracles on page ${pageNum}`);
          allOracles.push(...pageData);
          completedPages.push(pageNum);

          // Save progress after each successful page
          await saveProgress(allOracles, completedPages, failedPages);

          pageSuccess = true;

          // Small delay between pages to be respectful
          await page.waitForTimeout(1000);

        } catch (error) {
          retries++;
          console.error(`  ✗ Error on page ${pageNum} (attempt ${retries}/${MAX_RETRIES + 1}):`, error.message);

          if (retries > MAX_RETRIES) {
            failedPages[pageNum] = {
              attempts: retries,
              lastError: error.message,
              timestamp: new Date().toISOString()
            };
            console.error(`  ✗ Failed to scrape page ${pageNum} after ${MAX_RETRIES} retries. Saving progress and stopping.`);

            // Save progress before stopping
            await saveProgress(allOracles, completedPages, failedPages);
            throw new Error(`Failed to scrape page ${pageNum} after ${MAX_RETRIES} retries`);
          }

          // Wait before retrying
          await page.waitForTimeout(2000);
        }
      }
    }

    console.log(`\nTotal oracles scraped: ${allOracles.length}`);
    console.log(`Pages completed: ${completedPages.length}/${totalPages}`);

    // Save to JSON file
    const jsonOutput = JSON.stringify(allOracles, null, 2);
    await fs.writeFile('euler-oracles.json', jsonOutput);
    console.log('✓ Saved to euler-oracles.json');

    // Save to CSV file
    if (allOracles.length > 0) {
      const csvHeader = 'Page,Provider,Provider Info,Base,Quote,Price,Checks,Address,Address Link\n';
      const csvRows = allOracles.map(oracle => {
        return [
          oracle.page,
          oracle.provider,
          oracle.providerInfo,
          oracle.base,
          oracle.quote,
          oracle.price,
          oracle.checks,
          oracle.address,
          oracle.addressLink
        ].map(field => `"${String(field).replace(/"/g, '""')}"`).join(',');
      }).join('\n');

      await fs.writeFile('euler-oracles.csv', csvHeader + csvRows);
      console.log('✓ Saved to euler-oracles.csv');
    }

    // Print summary
    console.log('\n--- Summary ---');
    const providerCounts = {};
    allOracles.forEach(oracle => {
      providerCounts[oracle.provider] = (providerCounts[oracle.provider] || 0) + 1;
    });
    console.log('Oracles by provider:');
    Object.entries(providerCounts).sort((a, b) => b[1] - a[1]).forEach(([provider, count]) => {
      console.log(`  ${provider}: ${count}`);
    });

    // Show failed pages if any
    const failedPageNums = Object.keys(failedPages);
    if (failedPageNums.length > 0) {
      console.log('\n--- Failed Pages ---');
      failedPageNums.forEach(pageNum => {
        const failure = failedPages[pageNum];
        console.log(`  Page ${pageNum}: ${failure.lastError} (${failure.attempts} attempts)`);
      });
      console.log('\nRun the scraper again to retry failed pages.');
    } else if (completedPages.length === totalPages) {
      // All pages completed successfully, clean up progress file
      console.log('\n✓ All pages completed successfully!');
      try {
        await fs.unlink(PROGRESS_FILE);
        console.log('✓ Progress file cleaned up');
      } catch (e) {
        // Ignore if file doesn't exist
      }
    }

  } catch (error) {
    console.error('\nError during scraping:', error);
    console.log('\nProgress has been saved. Run the scraper again to continue from where it left off.');
    throw error;
  } finally {
    await browser.close();
    console.log('\nBrowser closed.');
  }
}

// Run the scraper
scrapeEulerOracles()
  .then(() => {
    console.log('\n✓ Scraping completed successfully!');
    process.exit(0);
  })
  .catch(error => {
    console.error('\n✗ Scraping failed:', error);
    process.exit(1);
  });
