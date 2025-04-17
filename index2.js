require('dotenv').config();
const puppeteer = require('puppeteer');
const fs = require('fs');
const { Parser } = require('json2csv');

/**
 * SearchFunder Scraper
 * This script logs into searchfunder.com and scrapes user data from the directory
 * based on provided search parameters.
 */
async function scrapeSearchFunder(directoryUrl) {
    console.log('Starting scraper...');

    // Launch browser with stealth mode to avoid detection
    const browser = await puppeteer.launch({
        headless: false, // Set to true for production
        defaultViewport: null,
        args: ['--start-maximized']
    });

    try {
        const page = await browser.newPage();

        // Set realistic user agent
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36');

        // Login process
        console.log('Navigating to login page...');
        await page.goto('https://searchfunder.com/login', { waitUntil: 'networkidle2' });

        // Check if already logged in
        const currentUrl = page.url();
        if (!currentUrl.includes('login')) {
            console.log('Already logged in, proceeding...');
        } else {
            console.log('Logging in...');

            // Get credentials from .env file
            const email = process.env.SEARCHFUNDER_EMAIL;
            const password = process.env.SEARCHFUNDER_PASSWORD;

            if (!email || !password) {
                throw new Error('Login credentials not found in .env file');
            }

            // Fill login form
            await page.type('input[type="email"]', email);
            await page.type('input[type="password"]', password);

            // Click login button and wait for navigation
            await Promise.all([
                page.click('button[type="submit"]'),
                page.waitForNavigation({ waitUntil: 'networkidle2' })
            ]);

            // Verify login success
            if (page.url().includes('login')) {
                throw new Error('Login failed. Please check credentials.');
            }
            console.log('Login successful');
        }

        // Navigate to directory with provided URL parameters
        console.log(`Navigating to directory: ${directoryUrl}`);
        await page.goto(directoryUrl, { waitUntil: 'networkidle2' });

        // Wait for directory results to load
        await page.waitForSelector('#directory-results', { timeout: 30000 });

        // Check if notification popup appears and close it
        try {
            const notificationButtonSelector = 'button:contains("Allow"), button:contains("Block"), .notification-button, button.btn-primary';
            const hasNotification = await page.evaluate((selector) => {
                const button = document.querySelector(selector) ||
                    Array.from(document.querySelectorAll('button')).find(el => el.textContent.includes('Allow') || el.textContent.includes('Block'));
                if (button) {
                    button.click();
                    return true;
                }
                return false;
            }, notificationButtonSelector);

            if (hasNotification) {
                console.log('Notification popup detected and closed');
                await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 1000)));
            }
        } catch (error) {
            console.log('No notification popup or error handling it:', error.message);
        }

        // Begin incremental scroll, scrape, and save
        console.log('Beginning incremental scroll, scrape, and save...');

        // Create CSV file with headers first
        const csvFilename = createCsvWithHeaders();

        // Perform the incremental scraping
        const totalProfilesCount = await scrollScrapeAndSave(page, csvFilename);

        console.log(`Scraping completed successfully! Total profiles scraped: ${totalProfilesCount}`);
    } catch (error) {
        console.error('An error occurred:', error);
    } finally {
        await browser.close();
    }
}

/**
 * Creates a CSV file with headers
 */
function createCsvWithHeaders() {
    const fields = ['name', 'occupation', 'location', 'uni_name', 'linkedIn_url', 'website_url'];
    const parser = new Parser({ fields });
    const csv = parser.parse([]);  // Empty array to just get headers

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `searchfunder_results_${timestamp}.csv`;

    fs.writeFileSync(filename, csv);
    console.log(`CSV file created: ${filename}`);

    return filename;
}

/**
 * Appends scraped profile data to the CSV file
 */
function appendToCsv(filename, data) {
    if (!data || data.length === 0) return;

    try {
        const fields = ['name', 'occupation', 'location', 'uni_name', 'linkedIn_url', 'website_url'];
        const parser = new Parser({ fields, header: false, nullValue: '' }); // No headers for append, empty string for null values
        const csv = parser.parse(data);

        fs.appendFileSync(filename, '\n' + csv);
        console.log(`Appended ${data.length} profiles to ${filename}`);
    } catch (error) {
        console.error('Error appending to CSV:', error);
    }
}

/**
 * Scrolls through the directory page, scrapes profiles, and saves incrementally
 */
async function scrollScrapeAndSave(page, csvFilename) {
    // Using the original selector for profile cards
    const profileSelector = '#directory-results > div > div';
    let processedProfileIndices = new Set(); // Keep track of already processed profiles

    let previousHeight;
    let scrollCount = 0;
    let noChangeCount = 0;
    const maxNoChangeCount = 5; // Stop if content doesn't change after 5 attempts

    console.log('Starting incremental scroll, scrape, and save...');

    // Scroll, scrape, and save until no new content loads
    while (noChangeCount < maxNoChangeCount) {
        // Get current profile elements
        const currentProfiles = await page.evaluate((selector) => {
            const elements = Array.from(document.querySelectorAll(selector));
            return elements.map((_, index) => index);
        }, profileSelector);

        // Find new profiles that haven't been processed yet
        const newProfiles = currentProfiles.filter(index => !processedProfileIndices.has(index));

        console.log(`Found ${newProfiles.length} new profiles to scrape in this batch`);

        // Extract data from new profiles
        if (newProfiles.length > 0) {
            const batchData = await extractProfileBatch(newProfiles, page, profileSelector);

            // Immediately save this batch to CSV
            appendToCsv(csvFilename, batchData);

            // Mark these profiles as processed
            newProfiles.forEach(index => processedProfileIndices.add(index));

            console.log(`Total profiles collected so far: ${processedProfileIndices.size}`);
        }

        // Get current scroll height
        previousHeight = await page.evaluate('document.body.scrollHeight');

        // Scroll to load more content
        await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');

        // Wait for potential new content to load
        await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 2000)));

        scrollCount++;
        console.log(`Scroll #${scrollCount}, Total profiles processed: ${processedProfileIndices.size}`);

        // Check if height changed
        const newHeight = await page.evaluate('document.body.scrollHeight');
        if (newHeight === previousHeight && newProfiles.length === 0) {
            noChangeCount++;
            console.log(`No new content loaded (${noChangeCount}/${maxNoChangeCount})`);
        } else {
            noChangeCount = 0; // Reset if content changed or new profiles found
        }

        // Add a short random delay
        await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 1000 + Math.floor(Math.random() * 500))));
    }

    return processedProfileIndices.size;
}

/**
 * Extracts data from a batch of profiles
 */
async function extractProfileBatch(profileIndices, page, profileSelector) {
    const batchData = [];

    for (let i = 0; i < profileIndices.length; i++) {
        const index = profileIndices[i];

        try {
            // Extract data from the specific profile element using its index
            const data = await page.evaluate((selector, idx) => {
                const profileEl = document.querySelectorAll(selector)[idx];
                if (!profileEl) return null;

                // Helper function to get text content and trim whitespace
                const getTextContent = (element) => {
                    return element ? element.textContent.trim() : null;
                };

                // Helper function to get href attribute
                const getHref = (element) => {
                    return element ? element.href : null;
                };

                // Use original selectors but make sure we're finding elements within this profileEl

                // Name selector
                const nameEl = profileEl.querySelector('div > div > span[data-profilecard]');
                const name = getTextContent(nameEl);

                // Occupation selector - the 3rd div inside the flex column container
                const occupationEl = profileEl.querySelector('div > div:nth-child(3)');
                const occupation = getTextContent(occupationEl);

                // Location selector - the 4th div inside the flex column container
                const locationEl = profileEl.querySelector('div > div:nth-child(4)');
                const location = getTextContent(locationEl);

                // University container - the 5th div inside the flex column container
                const uniContainerEl = profileEl.querySelector('div > div:nth-child(5)');

                // Then to get all university divs inside
                let uni_name = null;
                if (uniContainerEl) {
                    const uniDivs = Array.from(uniContainerEl.querySelectorAll('div'));
                    if (uniDivs.length > 0) {
                        uni_name = uniDivs.map(div => getTextContent(div)).join('; ');
                    }
                }

                // Look for links only within this specific profile element
                // LinkedIn URL selector - using a very specific path
                const linkedInEl = profileEl.querySelector('div:nth-child(2) > a[href*="linkedin.com"]');
                const linkedIn_url = getHref(linkedInEl);

                // Website URL selector - using a very specific path
                const websiteEl = profileEl.querySelector('div:nth-child(2) > a:not([href*="linkedin.com"]):not([href*="searchfunder.com"])');
                const website_url = getHref(websiteEl);

                return {
                    name: name || null,
                    occupation: occupation || null,
                    location: location || null,
                    uni_name: uni_name || null,
                    linkedIn_url: linkedIn_url || null,
                    website_url: website_url || null
                };
            }, profileSelector, index);

            if (data) {
                batchData.push(data);
            } else {
                console.error(`Could not extract data from profile at index ${index}`);
                batchData.push({
                    name: `Error_Profile_${index}`,
                    occupation: null,
                    location: null,
                    uni_name: null,
                    linkedIn_url: null,
                    website_url: null
                });
            }

            // Log progress for larger batches
            if (profileIndices.length > 10 && (i + 1) % 5 === 0) {
                console.log(`Processed ${i + 1}/${profileIndices.length} profiles in current batch`);
            }
        } catch (error) {
            console.error(`Error extracting data from profile at index ${index}:`, error);
            batchData.push({
                name: `Error_Profile_${index}`,
                occupation: null,
                location: null,
                uni_name: null,
                linkedIn_url: null,
                website_url: null
            });
        }
    }

    return batchData;
}

/**
 * Main execution function
 */
async function main() {
    const directoryUrl = process.env.DIRECTORY_URL ||
        'https://searchfunder.com/directory?roles_arr=searcher&city=New%20York%20City,%20NY,%20USA&lat=40.7127753&lng=-74.0059728&regions_arr=United%20States';

    await scrapeSearchFunder(directoryUrl);
}

// Run the script
main().catch(console.error);