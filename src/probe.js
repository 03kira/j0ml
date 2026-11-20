/**
 * JAVHD.today Connectivity & Engine Health Probe
 */

import { HttpClient } from './client.js';
import { RELEASEDAY_URL, BASE_URL } from './config.js';

async function probe() {
    console.log(`\n======================================================`);
    console.log(`         🌐 JAVHD.TODAY CONNECTIVITY PROBE             `);
    console.log(`======================================================`);

    const client = new HttpClient({ timeoutMs: 15000 });

    // 1. Probe Catalog AJAX Endpoint
    console.log(`\n[Probe 1/2] Testing catalog AJAX endpoint: ${RELEASEDAY_URL}?ajax=browse_videos&page=1`);
    const t0 = Date.now();
    try {
        const catalogPage = await client.getCatalogPage(1);
        const elapsedCatalog = Date.now() - t0;
        if (catalogPage && catalogPage.html) {
            console.log(`✅ Catalog AJAX Reachable in ${elapsedCatalog}ms! (total: ${catalogPage.total}, html bytes: ${catalogPage.html.length})`);
        } else {
            console.warn(`⚠️ Catalog AJAX responded without html in ${elapsedCatalog}ms`);
        }
    } catch (err) {
        console.error(`❌ Catalog AJAX Failed: ${err.message}`);
    }

    // 2. Probe Video Detail Endpoint
    const sampleUrl = `${BASE_URL}/380028/`;
    console.log(`\n[Probe 2/2] Testing video detail endpoint: ${sampleUrl}`);
    const t1 = Date.now();
    try {
        const videoHtml = await client.getVideoHtml(sampleUrl);
        const elapsedVideo = Date.now() - t1;
        if (videoHtml && videoHtml.length > 5000) {
            console.log(`✅ Video Detail Page Reachable in ${elapsedVideo}ms! (bytes: ${videoHtml.length})`);
        } else {
            console.warn(`⚠️ Video Detail Page returned short response in ${elapsedVideo}ms`);
        }
    } catch (err) {
        console.error(`❌ Video Detail Failed: ${err.message}`);
    }

    console.log(`\n======================================================\n`);
}

probe().catch(err => {
    console.error('Probe failed:', err);
    process.exit(1);
});
