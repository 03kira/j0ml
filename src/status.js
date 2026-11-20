/**
 * JAVHD.today Database & Catalog Status CLI
 */

import fs from 'node:fs';
import path from 'node:path';
import {
    CATALOG_FILE,
    CATALOG_DIR,
    ENRICHED_DIR,
    CHECKPOINT_PATH
} from './config.js';

export function runStatus() {
    console.log(`\n======================================================`);
    console.log(`         🚀 JAVHD.TODAY SCRAPER DATABASE STATUS       `);
    console.log(`======================================================\n`);

    // 1. Catalog Status
    console.log(`📁 CATALOG INDEX:`);
    let catalogItems = [];
    const catalogFiles = [];

    if (fs.existsSync(CATALOG_DIR)) {
        const files = fs.readdirSync(CATALOG_DIR);
        const partFiles = files
            .filter(f => /^jav_catalog(?:_part\d+)?\.json$/.test(f))
            .sort();

        for (const f of partFiles) {
            const fp = path.join(CATALOG_DIR, f);
            const stat = fs.statSync(fp);
            try {
                const arr = JSON.parse(fs.readFileSync(fp, 'utf8'));
                if (Array.isArray(arr)) {
                    catalogItems.push(...arr);
                    catalogFiles.push({ file: f, count: arr.length, sizeMB: (stat.size / (1024 * 1024)).toFixed(2) });
                }
            } catch {}
        }
    }

    if (catalogFiles.length > 0) {
        for (const cf of catalogFiles) {
            console.log(`  * ${cf.file}: ${cf.count} titles (${cf.sizeMB} MB)`);
        }
        let hdCount = 0;
        const codeCounts = new Map();
        for (const item of catalogItems) {
            if (item.is_hd) hdCount++;
            if (item.code) {
                const prefix = item.code.split('-')[0].toUpperCase();
                codeCounts.set(prefix, (codeCounts.get(prefix) || 0) + 1);
            }
        }
        const topCodes = Array.from(codeCounts.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 6)
            .map(([code, count]) => `${code}: ${count}`)
            .join(', ');

        console.log(`  ----------------------------------------------------`);
        console.log(`  - Total Titles Indexed: ${catalogItems.length}`);
        console.log(`  - HD Videos: ${hdCount} (${catalogItems.length > 0 ? ((hdCount / catalogItems.length) * 100).toFixed(1) : 0}%)`);
        if (topCodes) console.log(`  - Top Labels: ${topCodes}`);
    } else {
        const testPath = path.join(CATALOG_DIR, 'jav_catalog_test.json');
        if (fs.existsSync(testPath)) {
            const stat = fs.statSync(testPath);
            const arr = JSON.parse(fs.readFileSync(testPath, 'utf8'));
            console.log(`  - Test Catalog Present: ${arr.length} items (${(stat.size / (1024 * 1024)).toFixed(2)} MB)`);
        } else {
            console.log(`  - Catalog file not generated yet.`);
        }
        console.log(`  - Run: npm run index:test (or npm run index:all)`);
    }

    console.log(`\n------------------------------------------------------\n`);

    // 2. Enriched Storage Status
    console.log(`📦 ENRICHED STORAGE (85 MB Partitions):`);
    let totalEnriched = 0;
    let totalBytes = 0;
    const partFiles = [];

    if (fs.existsSync(ENRICHED_DIR)) {
        const files = fs.readdirSync(ENRICHED_DIR).filter(f => /^jav_enriched_part\d+\.json$/.test(f));
        files.sort((a, b) => {
            const numA = parseInt(a.match(/\d+/)[0], 10);
            const numB = parseInt(b.match(/\d+/)[0], 10);
            return numA - numB;
        });

        for (const f of files) {
            const fp = path.join(ENRICHED_DIR, f);
            const stat = fs.statSync(fp);
            totalBytes += stat.size;
            try {
                const arr = JSON.parse(fs.readFileSync(fp, 'utf8'));
                const count = Array.isArray(arr) ? arr.length : 0;
                totalEnriched += count;
                partFiles.push({ file: f, count, sizeMB: (stat.size / (1024 * 1024)).toFixed(2) });
            } catch {}
        }
    }

    if (partFiles.length > 0) {
        for (const p of partFiles) {
            console.log(`  * ${p.file}: ${p.count} titles (${p.sizeMB} MB)`);
        }
        console.log(`  ----------------------------------------------------`);
        console.log(`  - Total Enriched Titles: ${totalEnriched}`);
        console.log(`  - Total Data Footprint: ${(totalBytes / (1024 * 1024)).toFixed(2)} MB across ${partFiles.length} file(s)`);
    } else {
        console.log(`  - No enriched partition files yet.`);
    }

    console.log(`\n------------------------------------------------------\n`);

    // 3. Progress & Checkpoint
    console.log(`📊 PROGRESS & COMPLETION:`);
    if (fs.existsSync(CHECKPOINT_PATH)) {
        try {
            const cp = JSON.parse(fs.readFileSync(CHECKPOINT_PATH, 'utf8'));
            const catTotal = cp.catalog?.totalVideos || catalogItems.length || 0;
            const lastPage = cp.catalog?.lastIndexedPage || 0;
            const totalPages = cp.catalog?.totalPages || 13569;
            const enrichTotal = cp.enrichment?.totalEnriched || totalEnriched || 0;

            console.log(`  - Catalog Progress: Page ${lastPage} / ${totalPages} (${((lastPage / totalPages) * 100).toFixed(1)}%)`);
            console.log(`  - Indexed Titles:   ${catTotal}`);
            console.log(`  - Enriched Titles:  ${enrichTotal}`);
            if (catTotal > 0) {
                console.log(`  - Enrichment Done:  ${((enrichTotal / catTotal) * 100).toFixed(1)}%`);
            }
            console.log(`  - Last Checkpoint:  ${cp.enrichment?.lastUpdated || cp.catalog?.updatedAt || 'N/A'}`);
        } catch {}
    } else {
        console.log(`  - No checkpoint file found.`);
    }

    console.log(`\n======================================================\n`);
}

// Auto-run if executed directly via CLI
if (process.argv[1] && process.argv[1].endsWith('status.js')) {
    runStatus();
}
