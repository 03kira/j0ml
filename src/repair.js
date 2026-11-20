/**
 * JAVHD.today Catalog Gap Repair Tool
 * Recovers missing pages that were skipped during transient Cloudflare challenge blocks.
 * Automatically inserts missing titles into partitioned catalog storage.
 * Halts and pauses for 10-15m when encountering Cloudflare rate limits.
 */

import fs from 'node:fs';
import path from 'node:path';
import { HttpClient } from './client.js';
import { parseVideoCards } from './parser.js';
import { saveCatalogPartitions } from './indexer.js';
import {
    CATALOG_DIR,
    CHECKPOINT_PATH,
    DEFAULT_DELAY_MS,
    DEFAULT_COOLDOWN_MS
} from './config.js';

// Pre-identified gap ranges where earlier crawls were interrupted by Cloudflare blocks
const DEFAULT_GAP_RANGES = [
    { start: 420, end: 860, name: 'Range 1 (Pages 420 - 860)' },
    { start: 1750, end: 2200, name: 'Range 2 (Pages 1750 - 2200)' },
    { start: 4850, end: 6000, name: 'Range 3 (Pages 4850 - 6000)' },
    { start: 8256, end: 8415, name: 'Range 4 (Pages 8256 - 8415)' },
    { start: 9520, end: 9520, name: 'Range 5 (Page 9520)' }
];

function parseArgs() {
    const args = process.argv.slice(2);
    const options = {
        customRanges: [],
        delayMs: DEFAULT_DELAY_MS,
        cooldownMs: DEFAULT_COOLDOWN_MS,
        maxPages: Infinity
    };

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--range' && args[i + 1]) {
            const parts = args[i + 1].split('-').map(n => parseInt(n.trim(), 10));
            if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
                options.customRanges.push({ start: parts[0], end: parts[1], name: `Custom Range (${parts[0]} - ${parts[1]})` });
            }
            i++;
        } else if (args[i] === '--page' && args[i + 1]) {
            const p = parseInt(args[i + 1], 10);
            if (!isNaN(p)) {
                options.customRanges.push({ start: p, end: p, name: `Single Page (${p})` });
            }
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
        } else if (args[i] === '--max' && args[i + 1]) {
            options.maxPages = parseInt(args[i + 1], 10);
            i++;
        }
    }

    if (options.customRanges.length === 0) {
        options.customRanges = DEFAULT_GAP_RANGES;
    }

    return options;
}

export async function runRepair() {
    const opts = parseArgs();
    const client = new HttpClient({ delayMs: opts.delayMs, cooldownMs: opts.cooldownMs });

    // 1. Load all existing catalog items
    const catalogMap = new Map();
    const files = fs.readdirSync(CATALOG_DIR)
        .filter(f => /^javhd_catalog_part\d+\.json$/.test(f))
        .sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10));

    for (const pf of files) {
        try {
            const items = JSON.parse(fs.readFileSync(path.join(CATALOG_DIR, pf), 'utf8'));
            if (Array.isArray(items)) {
                for (const item of items) if (item && item.id) catalogMap.set(String(item.id), item);
            }
        } catch {}
    }

    const initialCount = catalogMap.size;

    console.log(`\n======================================================`);
    console.log(`        🔧 JAVHD.TODAY CATALOG GAP REPAIR TOOL        `);
    console.log(`======================================================`);
    console.log(`- Loaded Catalog Titles: ${initialCount} across ${files.length} partition(s)`);
    console.log(`- Delay:                 ${opts.delayMs} ms`);
    console.log(`- Cooldown:              ${(opts.cooldownMs / 60000).toFixed(1)} mins (on Cloudflare rate limit)`);
    console.log(`- Ranges to Inspect:     ${opts.customRanges.map(r => `${r.start}-${r.end}`).join(', ')}`);
    console.log(`======================================================\n`);

    let totalRecovered = 0;
    let totalCheckedPages = 0;
    const startTime = Date.now();

    const saveState = () => {
        const allItems = Array.from(catalogMap.values());
        saveCatalogPartitions(CATALOG_DIR, allItems);
        if (fs.existsSync(CHECKPOINT_PATH)) {
            try {
                const ck = JSON.parse(fs.readFileSync(CHECKPOINT_PATH, 'utf8'));
                if (ck.catalog) {
                    ck.catalog.totalVideos = allItems.length;
                    ck.catalog.updatedAt = new Date().toISOString();
                    fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify(ck, null, 2), 'utf8');
                }
            } catch {}
        }
    };

    process.on('SIGINT', () => {
        console.log('\n\n💾 Interrupted! Saving repaired titles before exit...');
        saveState();
        console.log(`✅ Progress saved. Recovered ${totalRecovered} missing titles before exit.\n`);
        process.exit(0);
    });

    for (const range of opts.customRanges) {
        console.log(`\n▶️ Checking ${range.name}...`);
        let rangeNew = 0;

        for (let p = range.start; p <= range.end; p++) {
            if (totalCheckedPages >= opts.maxPages) break;

            let pageSuccess = false;
            let retryAttempt = 0;
            const MAX_RETRIES = 3;

            while (!pageSuccess && retryAttempt < MAX_RETRIES) {
                try {
                    const data = await client.getCatalogPage(p);
                    if (data && data.html) {
                        const cards = parseVideoCards(data.html);
                        let pageNew = 0;
                        for (const c of cards) {
                            if (!catalogMap.has(String(c.id))) {
                                catalogMap.set(String(c.id), c);
                                pageNew++;
                            }
                        }

                        totalCheckedPages++;
                        totalRecovered += pageNew;
                        rangeNew += pageNew;
                        pageSuccess = true;

                        if (pageNew > 0) {
                            console.log(`  [Page ${p}] 🟢 Recovered +${pageNew} missing titles (Catalog Total: ${catalogMap.size})`);
                        } else {
                            // Page was already completely present
                            process.stdout.write(`  [Page ${p}] ⚪ Already complete (0 new)\r`);
                        }
                        break;
                    } else {
                        retryAttempt++;
                        const waitSec = retryAttempt * 4;
                        console.warn(`  [Page ${p}] ⚠️ Empty response. Waiting ${waitSec}s (retry ${retryAttempt}/${MAX_RETRIES})...`);
                        await new Promise(r => setTimeout(r, waitSec * 1000));
                    }
                } catch (err) {
                    if (err.message && err.message.includes('Cloudflare challenge persisted')) {
                        console.error(`  [Page ${p}] 🛑 Cloudflare challenge persisted after cooldown.`);
                        break;
                    }
                    retryAttempt++;
                    const waitSec = retryAttempt * 4;
                    console.warn(`  [Page ${p}] ⚠️ Error: ${err.message}. Waiting ${waitSec}s (retry ${retryAttempt}/${MAX_RETRIES})...`);
                    await new Promise(r => setTimeout(r, waitSec * 1000));
                }
            }

            // Periodic save every 20 pages
            if (totalCheckedPages % 20 === 0) {
                saveState();
            }
        }

        console.log(`\n✅ Completed ${range.name}: Recovered +${rangeNew} missing titles.`);
    }

    // Final save
    saveState();

    const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n======================================================`);
    console.log(`[Repair] 🎉 Gap Repair Complete!`);
    console.log(`- Pages Checked:         ${totalCheckedPages}`);
    console.log(`- Missing Titles Found:  +${totalRecovered}`);
    console.log(`- New Catalog Size:      ${catalogMap.size} titles`);
    console.log(`- Total Time:            ${elapsedSec}s`);
    console.log(`======================================================\n`);
}

if (process.argv[1] && process.argv[1].endsWith('repair.js')) {
    runRepair().catch(err => {
        console.error('[Repair] Fatal error:', err);
        process.exit(1);
    });
}
