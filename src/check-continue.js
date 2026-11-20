/**
 * JAVHD.today Auto-Continue Checker for GitHub Actions
 * Outputs CONTINUE <pending_count> or COMPLETE 0
 */

import { PartitionManager } from './partition.js';
import { loadAllCatalogItems } from './enricher.js';

function checkContinue() {
    const isTest = process.argv.includes('--test');
    const catalog = loadAllCatalogItems(isTest);

    if (!catalog || catalog.length === 0) {
        console.log('COMPLETE 0');
        return;
    }

    const partitionManager = new PartitionManager(undefined, undefined, { silent: true });
    let pendingCount = 0;

    for (const item of catalog) {
        if (!partitionManager.has(item.id, item.code, item.slug)) {
            pendingCount++;
        }
    }

    if (pendingCount > 0) {
        console.log(`CONTINUE ${pendingCount}`);
    } else {
        console.log('COMPLETE 0');
    }
}

checkContinue();
