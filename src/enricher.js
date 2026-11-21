/**
 * JAVHD.today Detail Enrichment Engine
 * Reads indexed catalog, fetches full video details & streaming server embeds,
 * and writes to partitioned JSON files (split at 85 MB to stay strictly under GitHub's 100 MB limit).
 * Halts and pauses for 10-15m on Cloudflare challenge or rate limits.
 */

import fs from 'node:fs';
import path from 'node:path';
import { HttpClient } from './client.js';
import { PartitionManager } from './partition.js';
import { parseVideoDetail } from './parser.js';
import {
    CATALOG_FILE,
    CATALOG_DIR,
    CHECKPOINT_PATH,
    DEFAULT_DELAY_MS,
    DEFAULT_COOLDOWN_MS,
    BASE_URL
} from './config.js';

function parseArgs() {
    const args = process.argv.slice(2);
    const options = {
        isTest: false,
        limit: Infinity,
        batchSize: Infinity,
        delayMs: DEFAULT_DELAY_MS,
        cooldownMs: DEFAULT_COOLDOWN_MS,
        maxMinutes: 270, // 4.5 hours safe cutoff for GitHub Actions
        maxPartMb: 85,
        targetId: null,
        targetUrl: null,
        direction: 'desc' // 'desc' (newest first) or 'asc' (oldest first)
    };

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--test') {
            options.isTest = true;
            options.limit = 5;
        } else if (args[i] === '--limit' && args[i + 1]) {
            const parsed = parseInt(args[i + 1], 10);
            options.limit = parsed > 0 ? parsed : Infinity;
            i++;
        } else if (args[i] === '--direction' && args[i + 1]) {
            options.direction = args[i + 1].toLowerCase();
            i++;
        } else if (args[i] === '--batch' && args[i + 1]) {
            const parsed = parseInt(args[i + 1], 10);
            options.batchSize = parsed > 0 ? parsed : Infinity;
            i++;
        } else if (args[i] === '--delay' && args[i + 1]) {
            options.delayMs = parseInt(args[i + 1], 10);
            i++;
        } else if (args[i] === '--cooldown' && args[i + 1]) {
            const mins = parseFloat(args[i + 1]);
            if (!isNaN(mins) && mins > 0) {
                options.cooldownMs = mins * 60 * 1000;
            }
            i++;
        } else if (args[i] === '--max-minutes' && args[i + 1]) {
            options.maxMinutes = parseFloat(args[i + 1]);
            i++;
        } else if (args[i] === '--max-part-mb' && args[i + 1]) {
            options.maxPartMb = parseFloat(args[i + 1]);
            i++;
        } else if (args[i] === '--id' && args[i + 1]) {
            options.targetId = args[i + 1];
            i++;
        } else if (args[i] === '--url' && args[i + 1]) {
            options.targetUrl = args[i + 1];
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
        catalog: {},
        enrichment: {
            totalEnriched: 0,
            failedItems: {},
            lastUpdated: null
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

/**
 * Loads catalog items from either test file, single catalog file, or partitioned catalog files.
 */
export function loadAllCatalogItems(isTest = false) {
    if (isTest) {
        const testPath = path.join(CATALOG_DIR, 'javhd_catalog_test.json');
        if (fs.existsSync(testPath)) {
            return JSON.parse(fs.readFileSync(testPath, 'utf8'));
        }
    }

    if (!fs.existsSync(CATALOG_DIR)) return [];

    const files = fs.readdirSync(CATALOG_DIR);
    const partFiles = files
        .filter(f => /^javhd_catalog_part\d+\.json$/.test(f))
        .sort((a, b) => {
            const numA = parseInt(a.match(/\d+/)[0], 10);
            const numB = parseInt(b.match(/\d+/)[0], 10);
            return numA - numB;
        });

    if (partFiles.length > 0) {
        const allItems = [];
        for (const pf of partFiles) {
            const pPath = path.join(CATALOG_DIR, pf);
            try {
                const items = JSON.parse(fs.readFileSync(pPath, 'utf8'));
                if (Array.isArray(items)) allItems.push(...items);
            } catch (err) {
                console.error(`[Enricher] Error reading ${pf}: ${err.message}`);
            }
        }
        return allItems;
    }

    if (fs.existsSync(CATALOG_FILE)) {
        try {
            return JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));
        } catch (err) {
            console.error(`[Enricher] Error reading ${path.basename(CATALOG_FILE)}: ${err.message}`);
        }
    }

    return [];
}

export async function runEnricher() {
    const opts = parseArgs();
    const client = new HttpClient({ delayMs: opts.delayMs, cooldownMs: opts.cooldownMs });
    const maxPartSizeBytes = opts.maxPartMb * 1024 * 1024;
    const partitionManager = new PartitionManager(undefined, maxPartSizeBytes);
    const checkpoint = loadCheckpoint();
    const maxDurationMs = opts.maxMinutes * 60 * 1000;

    if (!checkpoint.enrichment) {
        checkpoint.enrichment = {
            totalEnriched: 0,
            failedItems: {},
            lastUpdated: null
        };
    }

    // 1. Single Video Mode
    if (opts.targetId || opts.targetUrl) {
        const target = opts.targetUrl || opts.targetId;
        console.log(`[Enricher] 🎯 Single target requested: ${target}`);
        const html = await client.getVideoHtml(target);
        if (!html) {
            console.error(`[Enricher] ❌ Could not fetch HTML for: ${target}`);
            return;
        }
        const ogUrlMatch = html.match(/property=["']og:url["'][^>]*content=["']([^"']+)["']/i) ||
                           html.match(/content=["']([^"']+)["'][^>]*property=["']og:url["']/i);
        const canonicalUrl = ogUrlMatch ? ogUrlMatch[1] : (String(target).startsWith('http') ? target : `${BASE_URL}/${target}/`);
        const idMatch = canonicalUrl.match(/\/(\d+)\//);
        const id = idMatch ? parseInt(idMatch[1], 10) : null;

        let downloadHtml = null;
        let relatedJson = null;
        try {
            const [dlRes, relRes] = await Promise.allSettled([
                client.getDownloadHtml(id),
                client.getRelatedVideos(canonicalUrl)
            ]);
            if (dlRes.status === 'fulfilled') downloadHtml = dlRes.value;
            if (relRes.status === 'fulfilled') relatedJson = relRes.value;
        } catch {}

        const parsed = parseVideoDetail(html, canonicalUrl, {}, {
            downloadHtml,
            relatedHtml: relatedJson?.html
        });
        console.log(JSON.stringify(parsed, null, 2));
        return;
    }

    // 2. Load Catalog Items
    const catalog = loadAllCatalogItems(opts.isTest);
    if (!catalog || catalog.length === 0) {
        console.error(`[Enricher] ❌ No catalog items found in ${CATALOG_DIR}!`);
        console.error(`Please run indexer first: npm run index:test (or npm run index:all)`);
        process.exit(1);
    }

    console.log(`[Enricher] 📂 Loaded ${catalog.length} titles from catalog.`);

    // 3. Filter Pending Items (not yet in PartitionManager)
    const pendingItems = [];
    for (const item of catalog) {
        if (!partitionManager.has(item.id, item.code, item.slug)) {
            pendingItems.push(item);
        }
    }

    console.log(`[Enricher] 📊 Status: ${partitionManager.allIds.size} already enriched, ${pendingItems.length} pending.`);

    if (pendingItems.length === 0) {
        console.log(`[Enricher] 🎉 All catalog titles are already fully enriched! Nothing to do.`);
        return;
    }

    if (opts.direction === 'asc') {
        pendingItems.reverse();
    }

    const maxToProcess = Math.min(pendingItems.length, opts.limit, opts.batchSize);

    console.log(`\n======================================================`);
    console.log(`         🚀 JAVHD.TODAY ENRICHMENT WORKER             `);
    console.log(`======================================================`);
    console.log(`- Mode:       ${opts.isTest ? 'TEST (5 items)' : 'PRODUCTION'}`);
    console.log(`- Direction:  ${opts.direction === 'asc' ? 'ASCENDING (Oldest first)' : 'DESCENDING (Newest first)'}`);
    console.log(`- Batch Size: ${maxToProcess}`);
    console.log(`- Delay:      ${opts.delayMs} ms`);
    console.log(`- Cooldown:   ${(opts.cooldownMs / 60000).toFixed(1)} mins (on Cloudflare rate limit)`);
    console.log(`- Timeout:    ${opts.maxMinutes} mins`);
    console.log(`- Max Part:   ${opts.maxPartMb} MB`);
    console.log(`======================================================\n`);

    let processedCount = 0;
    let successCount = 0;
    let failedCount = 0;
    const startTime = Date.now();

    // Graceful interrupt handling (SIGINT, SIGTERM)
    const gracefulShutdown = (signal) => {
        console.log(`\n\n💾 ${signal} received! Flushing dataset & checkpoint before exit...`);
        partitionManager.flush();
        checkpoint.enrichment.totalEnriched = partitionManager.allIds.size;
        checkpoint.enrichment.lastUpdated = new Date().toISOString();
        saveCheckpoint(checkpoint);
        console.log('✅ Progress safely saved. You can resume anytime.\n');
        process.exit(0);
    };

    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

    for (const item of pendingItems) {
        if (processedCount >= maxToProcess) break;

        // Safety timeout check
        if (Date.now() - startTime >= maxDurationMs) {
            console.log(`\n⏳ Safety time limit reached (${opts.maxMinutes} mins). Stopping gracefully to commit & push...`);
            break;
        }

        const identifier = item.id || item.code || item.slug;
        const pageUrl = item.url || `${BASE_URL}/${item.id}/${item.slug ? `${item.slug}/` : ''}`;

        try {
            const html = await client.getVideoHtml(pageUrl);

            if (!html) {
                console.warn(`[Enricher] ⚠️ Video #${item.id} (${item.code || 'NO-CODE'}): 404 or empty HTML.`);
                checkpoint.enrichment.failedItems[String(identifier)] = 'Empty / 404';
                failedCount++;
            } else {
                // Fetch download page HTML & related videos in parallel
                let downloadHtml = null;
                let relatedJson = null;
                try {
                    const [dlRes, relRes] = await Promise.allSettled([
                        client.getDownloadHtml(item.id),
                        client.getRelatedVideos(pageUrl)
                    ]);
                    if (dlRes.status === 'fulfilled') downloadHtml = dlRes.value;
                    if (relRes.status === 'fulfilled') relatedJson = relRes.value;
                } catch {}

                const enriched = parseVideoDetail(html, pageUrl, item, {
                    downloadHtml,
                    relatedHtml: relatedJson?.html
                });

                partitionManager.add(enriched);
                delete checkpoint.enrichment.failedItems[String(identifier)];
                successCount++;

                const code = enriched.code || 'NO-CODE';
                const serversCount = (enriched.streams?.embed_sources || enriched.servers || []).length;
                const dlCount = (enriched.streams?.download_sources || enriched.downloads || []).length;
                const relCount = (enriched.related_videos || []).length;

                console.log(`[${processedCount + 1}/${maxToProcess}] ✅ Enriched #${item.id} [${code}]: "${enriched.title?.slice(0, 35)}..." (${serversCount} embeds, ${dlCount} dl, ${relCount} rel)`);
            }
        } catch (err) {
            console.error(`[Enricher] ❌ Error on video #${item.id}: ${err.message}`);
            checkpoint.enrichment.failedItems[String(identifier)] = err.message;
            failedCount++;
        }

        processedCount++;

        // Periodic checkpoint: immediately on items 1, 5, 10, then every 20 items
        if (processedCount === 1 || processedCount === 5 || processedCount === 10 || processedCount % 20 === 0) {
            partitionManager.flush();
            checkpoint.enrichment.totalEnriched = partitionManager.allIds.size;
            checkpoint.enrichment.lastUpdated = new Date().toISOString();
            saveCheckpoint(checkpoint);
        }
    }

    // Final flush & save
    partitionManager.flush();
    checkpoint.enrichment.totalEnriched = partitionManager.allIds.size;
    checkpoint.enrichment.lastUpdated = new Date().toISOString();
    saveCheckpoint(checkpoint);

    const totalSec = ((Date.now() - startTime) / 1000).toFixed(1);
    const avgRate = totalSec > 0 ? (processedCount / totalSec).toFixed(2) : 0;

    console.log(`\n======================================================`);
    console.log(`[Enricher] 🎉 Batch Completed!`);
    console.log(`- Processed Items:  ${processedCount}`);
    console.log(`- Success:          ${successCount}`);
    console.log(`- Failed / Skipped: ${failedCount}`);
    console.log(`- Total Enriched:   ${partitionManager.allIds.size}`);
    console.log(`- Total Partitions: ${partitionManager.parts?.length || 1}`);
    console.log(`- Elapsed:          ${totalSec}s (${avgRate} items/sec)`);
    console.log(`======================================================\n`);
}

if (process.argv[1] && process.argv[1].endsWith('enricher.js')) {
    runEnricher().catch(err => {
        console.error('[Enricher] Fatal error:', err);
        process.exit(1);
    });
}
