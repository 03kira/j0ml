/**
 * JAVHD.today Catalog Indexer
 * Crawls https://javhd.today/releaseday/?ajax=browse_videos&page={p}
 * Builds the complete deduplicated catalog with basic metadata (~380,000 items)
 */

import fs from 'node:fs';
import path from 'node:path';
import { HttpClient } from './client.js';
import { parseVideoCards, parsePagination } from './parser.js';
import {
    CATALOG_DIR,
    CATALOG_FILE,
    CHECKPOINT_PATH,
    DEFAULT_DELAY_MS
} from './config.js';

function parseArgs() {
    const args = process.argv.slice(2);
    const options = {
        isTest: false,
        maxPages: Infinity,
        startPage: 1,
        resume: false,
        delayMs: DEFAULT_DELAY_MS
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
            totalPages: 13569,
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

export async function runIndexer() {
    const opts = parseArgs();
    const client = new HttpClient({ delayMs: opts.delayMs });

    if (!fs.existsSync(CATALOG_DIR)) {
        fs.mkdirSync(CATALOG_DIR, { recursive: true });
    }

    const checkpoint = loadCheckpoint();
    const outputFile = opts.isTest 
        ? path.join(CATALOG_DIR, 'javhd_catalog_test.json') 
        : CATALOG_FILE;

    // Load existing catalog items if file exists
    const catalogMap = new Map();
    if (fs.existsSync(outputFile)) {
        try {
            const existing = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
            if (Array.isArray(existing)) {
                for (const item of existing) {
                    if (item && item.id) {
                        catalogMap.set(String(item.id), item);
                    }
                }
                console.log(`[Indexer] 📂 Loaded ${catalogMap.size} existing items from ${path.basename(outputFile)}`);
            }
        } catch (e) {
            console.warn(`[Indexer] Could not read existing catalog: ${e.message}`);
        }
    }

    let currentPage = opts.startPage;
    if (opts.resume && checkpoint.catalog?.lastIndexedPage && !opts.isTest) {
        currentPage = checkpoint.catalog.lastIndexedPage + 1;
        console.log(`[Indexer] 🔄 Resuming from page ${currentPage}`);
    }

    console.log(`\n======================================================`);
    console.log(`        🚀 JAVHD.TODAY CATALOG INDEXER               `);
    console.log(`======================================================`);
    console.log(`- Mode:       ${opts.isTest ? 'TEST (3 pages)' : 'FULL CRAWL'}`);
    console.log(`- Start Page: ${currentPage}`);
    console.log(`- Max Pages:  ${opts.maxPages === Infinity ? 'All Available' : opts.maxPages}`);
    console.log(`- Delay:      ${opts.delayMs} ms`);
    console.log(`- Output:     ${path.basename(outputFile)}`);
    console.log(`======================================================\n`);

    let totalPages = checkpoint.catalog?.totalPages || 13569;
    let consecutiveEmptyPages = 0;
    let pagesCrawled = 0;
    const startTime = Date.now();

    // Graceful exit handler
    const saveState = (isFinal = false) => {
        const allItems = Array.from(catalogMap.values());
        saveCatalogFile(outputFile, allItems);

        if (!opts.isTest) {
            checkpoint.catalog = {
                totalVideos: allItems.length,
                lastIndexedPage: currentPage - 1,
                totalPages,
                isComplete: isFinal && currentPage > totalPages,
                updatedAt: new Date().toISOString()
            };
            saveCheckpoint(checkpoint);
        }
    };

    process.on('SIGINT', () => {
        console.log('\n\n💾 Interrupted! Saving catalog & checkpoint before exit...');
        saveState(false);
        console.log('✅ Progress saved. You can resume anytime with: node src/indexer.js --resume\n');
        process.exit(0);
    });

    const targetLimit = opts.maxPages === Infinity ? totalPages : Math.min(totalPages, currentPage + opts.maxPages - 1);

    while (currentPage <= targetLimit) {
        const pageStart = Date.now();

        try {
            const data = await client.getCatalogPage(currentPage);

            if (!data || !data.html) {
                consecutiveEmptyPages++;
                console.warn(`[Indexer] ⚠️ Page ${currentPage}: No HTML returned.`);
                if (consecutiveEmptyPages >= 5) {
                    console.log(`[Indexer] Reached 5 consecutive empty pages. Catalog crawl finished!`);
                    break;
                }
                currentPage++;
                continue;
            }

            consecutiveEmptyPages = 0;

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

        } catch (err) {
            console.error(`[Indexer] ❌ Error on page ${currentPage}: ${err.message}`);
        }

        currentPage++;
    }

    // Final save
    saveState(true);

    const totalSeconds = ((Date.now() - startTime) / 1000).toFixed(1);
    const speed = totalSeconds > 0 ? (catalogMap.size / totalSeconds).toFixed(1) : 0;
    const finalSizeMb = (fs.statSync(outputFile).size / (1024 * 1024)).toFixed(2);

    console.log(`\n======================================================`);
    console.log(`[Indexer] 🎉 Catalog Crawl Finished!`);
    console.log(`- Total Titles Indexed: ${catalogMap.size}`);
    console.log(`- Pages Crawled:        ${pagesCrawled}`);
    console.log(`- Catalog File Size:    ${finalSizeMb} MB`);
    console.log(`- Total Elapsed:        ${totalSeconds}s (${speed} titles/sec)`);
    console.log(`- File Saved:           ${outputFile}`);
    console.log(`======================================================\n`);
}

// Auto-run if executed directly via CLI
if (process.argv[1] && process.argv[1].endsWith('indexer.js')) {
    runIndexer().catch(err => {
        console.error('[Indexer] Fatal error:', err);
        process.exit(1);
    });
}
