/**
 * JAVHD.today Catalog Indexer
 * Crawls https://javhd.today/releaseday/?ajax=browse_videos&page={p}
 * Builds the complete deduplicated catalog with basic metadata (~380,000 items)
 * Automatically partitions output into <75 MB files (javhd_catalog_part1.json, etc.)
 * Resilient retry mechanism: NEVER skips failed pages without retrying, and only marks
 * truly completed pages in checkpoint.
 * Automatically halts and enters 10-15m cooldown on Cloudflare rate limits.
 */

import fs from 'node:fs';
import path from 'node:path';
import { HttpClient } from './client.js';
import { parseVideoCards, parsePagination } from './parser.js';
import {
    CATALOG_DIR,
    CATALOG_FILE,
    CHECKPOINT_PATH,
    DEFAULT_DELAY_MS,
    DEFAULT_COOLDOWN_MS
} from './config.js';

function parseArgs() {
    const args = process.argv.slice(2);
    const options = {
        isTest: false,
        maxPages: Infinity,
        startPage: 1,
        resume: false,
        delayMs: DEFAULT_DELAY_MS,
        cooldownMs: DEFAULT_COOLDOWN_MS
    };

    let explicitPages = false;
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--test') {
            options.isTest = true;
            if (!explicitPages) options.maxPages = 3;
        } else if (args[i] === '--all') {
            options.maxPages = Infinity;
        } else if (args[i] === '--pages' && args[i + 1]) {
            options.maxPages = parseInt(args[i + 1], 10);
            explicitPages = true;
            i++;
        } else if (args[i] === '--start' && args[i + 1]) {
            options.startPage = parseInt(args[i + 1], 10);
            i++;
        } else if (args[i] === '--resume') {
            options.resume = true;
        } else if (args[i] === '--delay' && args[i + 1]) {
            options.delayMs = parseInt(args[i + 1], 10);
            i++;
        } else if (args[i] === '--cooldown' && args[i + 1]) {
            const mins = parseFloat(args[i + 1]);
            if (!isNaN(mins) && mins > 0) {
                options.cooldownMs = mins * 60 * 1000;
            }
            i++;
        }
    }

    return options;
}

function loadCheckpoint() {
    if (fs.existsSync(CHECKPOINT_PATH)) {
        try {
            return JSON.parse(fs.readFileSync(CHECKPOINT_PATH, 'utf8'));
        } catch {}
    }
    return {
        catalog: {
            totalVideos: 0,
            lastIndexedPage: 0,
            failedPages: [],
            totalPages: 13571,
            isComplete: false,
            updatedAt: null
        }
    };
}

function saveCheckpoint(state) {
    if (!fs.existsSync(path.dirname(CHECKPOINT_PATH))) {
        fs.mkdirSync(path.dirname(CHECKPOINT_PATH), { recursive: true });
    }
    const tempPath = `${CHECKPOINT_PATH}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tempPath, CHECKPOINT_PATH);
}

function saveCatalogFile(filePath, items) {
    if (!fs.existsSync(path.dirname(filePath))) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
    }
    const tempPath = `${filePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(items, null, 2), 'utf8');
    fs.renameSync(tempPath, filePath);
}

/**
 * Splits and saves items across partition files strictly under 75 MB (~50,000 items each).
 */
export function saveCatalogPartitions(catalogDir, allItems) {
    const ITEMS_PER_PART = 50000;
    const numParts = Math.ceil(allItems.length / ITEMS_PER_PART) || 1;

    for (let p = 1; p <= numParts; p++) {
        const start = (p - 1) * ITEMS_PER_PART;
        const end = Math.min(start + ITEMS_PER_PART, allItems.length);
        const partItems = allItems.slice(start, end);
        const partFile = path.join(catalogDir, `javhd_catalog_part${p}.json`);
        saveCatalogFile(partFile, partItems);
    }

    // Delete single oversized legacy file if it exists so git won't exceed GitHub's 100MB limit
    const singleFile = path.join(catalogDir, 'javhd_catalog.json');
    if (fs.existsSync(singleFile)) {
        try { fs.unlinkSync(singleFile); } catch {}
    }
}

export async function runIndexer() {
    const opts = parseArgs();
    const client = new HttpClient({ delayMs: opts.delayMs, cooldownMs: opts.cooldownMs });

    if (!fs.existsSync(CATALOG_DIR)) {
        fs.mkdirSync(CATALOG_DIR, { recursive: true });
    }

    const checkpoint = loadCheckpoint();
    const testOutputFile = path.join(CATALOG_DIR, 'javhd_catalog_test.json');

    // Load existing catalog items from test file, partitioned files, or legacy single file
    const catalogMap = new Map();
    if (opts.isTest) {
        if (fs.existsSync(testOutputFile)) {
            try {
                const existing = JSON.parse(fs.readFileSync(testOutputFile, 'utf8'));
                if (Array.isArray(existing)) {
                    for (const item of existing) if (item && item.id) catalogMap.set(String(item.id), item);
                }
            } catch {}
        }
    } else {
        const files = fs.readdirSync(CATALOG_DIR);
        const partFiles = files
            .filter(f => /^javhd_catalog_part\d+\.json$/.test(f))
            .sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10));

        if (partFiles.length > 0) {
            for (const pf of partFiles) {
                try {
                    const items = JSON.parse(fs.readFileSync(path.join(CATALOG_DIR, pf), 'utf8'));
                    if (Array.isArray(items)) {
                        for (const item of items) if (item && item.id) catalogMap.set(String(item.id), item);
                    }
                } catch {}
            }
            console.log(`[Indexer] 📂 Loaded ${catalogMap.size} existing items across ${partFiles.length} catalog partition(s)`);
        } else if (fs.existsSync(CATALOG_FILE)) {
            try {
                const existing = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));
                if (Array.isArray(existing)) {
                    for (const item of existing) if (item && item.id) catalogMap.set(String(item.id), item);
                }
                console.log(`[Indexer] 📂 Loaded ${catalogMap.size} existing items from ${path.basename(CATALOG_FILE)}`);
            } catch {}
        }
    }

    const failedPages = new Set(checkpoint.catalog?.failedPages || []);
    let lastSuccessfulPage = checkpoint.catalog?.lastIndexedPage || 0;

    let currentPage = opts.startPage;
    if (opts.resume && lastSuccessfulPage > 0 && !opts.isTest) {
        currentPage = lastSuccessfulPage + 1;
        console.log(`[Indexer] 🔄 Resuming from page ${currentPage} (last fully completed page was ${lastSuccessfulPage})`);
    }

    let totalPages = checkpoint.catalog?.totalPages || 13571;
    const targetLimit = opts.maxPages === Infinity ? totalPages : Math.min(totalPages, currentPage + opts.maxPages - 1);

    console.log(`\n======================================================`);
    console.log(`        🚀 JAVHD.TODAY CATALOG INDEXER               `);
    console.log(`======================================================`);
    console.log(`- Mode:       ${opts.isTest ? 'TEST (3 pages)' : 'FULL CRAWL'}`);
    console.log(`- Start Page: ${currentPage}`);
    console.log(`- Max Pages:  ${opts.maxPages === Infinity ? 'All Available' : opts.maxPages}`);
    console.log(`- Delay:      ${opts.delayMs} ms`);
    console.log(`- Cooldown:   ${(opts.cooldownMs / 60000).toFixed(1)} mins (on Cloudflare rate limit)`);
    console.log(`- Storage:    ${opts.isTest ? 'javhd_catalog_test.json' : 'Auto-partitioned (<75 MB)'}`);
    console.log(`======================================================\n`);

    let pagesCrawled = 0;
    const startTime = Date.now();

    // Graceful exit & auto-save handler (saves ONLY actually successful page index!)
    const saveState = (isFinal = false) => {
        const allItems = Array.from(catalogMap.values());
        if (opts.isTest) {
            saveCatalogFile(testOutputFile, allItems);
        } else {
            saveCatalogPartitions(CATALOG_DIR, allItems);
        }

        if (!opts.isTest) {
            checkpoint.catalog = {
                totalVideos: allItems.length,
                lastIndexedPage: lastSuccessfulPage,
                failedPages: Array.from(failedPages),
                totalPages,
                isComplete: isFinal && currentPage > totalPages && failedPages.size === 0,
                updatedAt: new Date().toISOString()
            };
            saveCheckpoint(checkpoint);
        }
    };

    process.on('SIGINT', () => {
        console.log('\n\n💾 Interrupted! Saving catalog & checkpoint before exit...');
        saveState(false);
        console.log(`✅ Progress saved. Last completed page: ${lastSuccessfulPage}.`);
        console.log(`Next resume will start at page ${lastSuccessfulPage + 1}.\n`);
        process.exit(0);
    });

    while (currentPage <= targetLimit) {
        const pageStart = Date.now();
        let pageSuccess = false;
        let retryAttempt = 0;
        const MAX_RETRIES = 3;

        while (!pageSuccess && retryAttempt < MAX_RETRIES) {
            try {
                const data = await client.getCatalogPage(currentPage);

                if (data && data.html) {
                    // Update total pages from pagination metadata if present
                    if (data.pagination) {
                        const pag = parsePagination(data.pagination, totalPages);
                        if (pag.totalPages > totalPages) {
                            totalPages = pag.totalPages;
                        }
                    }

                    const cards = parseVideoCards(data.html);

                    let newOnPage = 0;
                    for (const card of cards) {
                        if (!catalogMap.has(String(card.id))) {
                            catalogMap.set(String(card.id), card);
                            newOnPage++;
                        }
                    }

                    pagesCrawled++;
                    lastSuccessfulPage = Math.max(lastSuccessfulPage, currentPage);
                    failedPages.delete(currentPage);
                    pageSuccess = true;

                    const pageElapsed = ((Date.now() - pageStart) / 1000).toFixed(2);
                    const totalElapsed = (Date.now() - startTime) / 1000;
                    const avgSecPerPage = totalElapsed / pagesCrawled;
                    const pagesRemaining = targetLimit - currentPage;
                    const etaMins = Math.ceil((pagesRemaining * avgSecPerPage) / 60);
                    const pct = (((currentPage) / targetLimit) * 100).toFixed(1);

                    console.log(`[Page ${currentPage}/${targetLimit} (${pct}%)] ✅ +${cards.length} cards (${newOnPage} new, Total: ${catalogMap.size}) | ${pageElapsed}s | ETA: ~${etaMins}m`);

                    // Periodic auto-save every 25 pages
                    if (pagesCrawled % 25 === 0) {
                        saveState(false);
                    }
                    break;
                } else {
                    retryAttempt++;
                    const waitSec = retryAttempt * 5;
                    console.warn(`[Indexer] ⚠️ Page ${currentPage}: Empty response. Pausing ${waitSec}s (retry ${retryAttempt}/${MAX_RETRIES})...`);
                    await new Promise(r => setTimeout(r, waitSec * 1000));
                }
            } catch (err) {
                // If Cloudflare persisted after full cooldowns, avoid rapid hammering
                if (err.message && err.message.includes('Cloudflare challenge persisted')) {
                    console.error(`[Indexer] 🛑 Persistent Cloudflare challenge on page ${currentPage}.`);
                    break;
                }
                retryAttempt++;
                const waitSec = retryAttempt * 5;
                console.warn(`[Indexer] ⚠️ Page ${currentPage} error: ${err.message}. Pausing ${waitSec}s (retry ${retryAttempt}/${MAX_RETRIES})...`);
                await new Promise(r => setTimeout(r, waitSec * 1000));
            }
        }

        // If page failed completely after all retries, record it so it won't be lost!
        if (!pageSuccess) {
            console.error(`[Indexer] ❌ Page ${currentPage} FAILED after ${MAX_RETRIES} attempts. Recorded in checkpoint failedPages.`);
            failedPages.add(currentPage);
        }

        currentPage++;
    }

    // Final save
    saveState(true);

    const totalSeconds = ((Date.now() - startTime) / 1000).toFixed(1);
    const speed = totalSeconds > 0 ? (catalogMap.size / totalSeconds).toFixed(1) : 0;

    console.log(`\n======================================================`);
    console.log(`[Indexer] 🎉 Catalog Crawl Finished!`);
    console.log(`- Total Titles Indexed: ${catalogMap.size}`);
    console.log(`- Pages Crawled:        ${pagesCrawled}`);
    console.log(`- Failed Pages:         ${failedPages.size}`);
    console.log(`- Last Successful Page: ${lastSuccessfulPage}`);
    console.log(`- Total Elapsed:        ${totalSeconds}s (${speed} titles/sec)`);
    console.log(`======================================================\n`);
}

// Auto-run if executed directly via CLI
if (process.argv[1] && process.argv[1].endsWith('indexer.js')) {
    runIndexer().catch(err => {
        console.error('[Indexer] Fatal error:', err);
        process.exit(1);
    });
}
