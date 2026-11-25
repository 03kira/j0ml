/**
 * JAVHD.today Enriched Dataset Partition Manager
 * Manages chunked JSON files (jav_enriched_part1.json, part2.json, etc.)
 * strictly under 85 MB to comply with GitHub's 100 MB hard file limit.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ENRICHED_DIR, MAX_PART_SIZE_BYTES } from './config.js';

class EnrichedPart {
    constructor(filePath, partNum, items = []) {
        this.filePath = filePath;
        this.partNum = partNum;
        this.items = items;
        this.itemCount = Array.isArray(items) ? items.length : 0;
        this.dirty = false;
        this.size = 0;
    }
}

export class PartitionManager {
    constructor(enrichedDir = ENRICHED_DIR, maxPartSizeBytes = MAX_PART_SIZE_BYTES, options = {}) {
        this.enrichedDir = enrichedDir;
        this.maxPartSizeBytes = maxPartSizeBytes;
        this.silent = options.silent ?? false;
        this.lightweight = options.lightweight ?? true;
        this.parts = [];
        this.allIds = new Set();
        this.allCodes = new Set();
        this.allSlugs = new Set();
        this.index = new Map(); // identifier -> { part, itemIndex } (only used when lightweight=false)
        this.activePart = null;
        this._init();
    }

    _init() {
        if (!fs.existsSync(this.enrichedDir)) {
            fs.mkdirSync(this.enrichedDir, { recursive: true });
        }

        const files = fs.readdirSync(this.enrichedDir);
        const partRegex = /^javhd_enriched_part(\d+)\.json$/;
        const partFiles = [];

        for (const f of files) {
            const match = f.match(partRegex);
            if (match) {
                partFiles.push({ file: f, partNum: parseInt(match[1], 10) });
            }
        }

        partFiles.sort((a, b) => a.partNum - b.partNum);

        if (partFiles.length === 0) {
            const initialPath = path.join(this.enrichedDir, 'javhd_enriched_part1.json');
            const p = new EnrichedPart(initialPath, 1, []);
            this.parts.push(p);
            this.activePart = p;
            return;
        }

        for (let pIdx = 0; pIdx < partFiles.length; pIdx++) {
            const pf = partFiles[pIdx];
            const isLastFile = pIdx === partFiles.length - 1;
            const fullPath = path.join(this.enrichedDir, pf.file);
            const stat = fs.statSync(fullPath);

            let items = [];
            try {
                const content = fs.readFileSync(fullPath, 'utf8');
                items = JSON.parse(content);
                if (!Array.isArray(items)) items = [];
            } catch (err) {
                console.error(`[PartitionManager] ⚠️ Error loading ${pf.file}: ${err.message}`);
                items = [];
            }

            const keepItemsInMemory = !this.lightweight || (isLastFile && stat.size < this.maxPartSizeBytes);
            const part = new EnrichedPart(fullPath, pf.partNum, keepItemsInMemory ? items : null);
            part.itemCount = items.length;
            part.size = stat.size;
            this.parts.push(part);

            for (let i = 0; i < items.length; i++) {
                const it = items[i];
                if (it && it.id != null) {
                    this.allIds.add(String(it.id));
                    if (!this.lightweight) this.index.set(`id:${it.id}`, { part, itemIndex: i });
                }
                if (it && it.code) {
                    const uc = String(it.code).toUpperCase();
                    this.allCodes.add(uc);
                    if (!this.lightweight) this.index.set(`code:${uc}`, { part, itemIndex: i });
                }
                if (it && it.slug) {
                    const ls = String(it.slug).toLowerCase();
                    this.allSlugs.add(ls);
                    if (!this.lightweight) this.index.set(`slug:${ls}`, { part, itemIndex: i });
                }
            }
            // Drop reference so V8 GC can immediately reclaim closed partition objects
            items = null;
        }

        // Active part is the latest part
        this.activePart = this.parts[this.parts.length - 1];

        // Check if latest part is already full
        if (this.activePart.size >= this.maxPartSizeBytes || this.activePart.items === null) {
            this._rotateNewPart();
        }

        if (!this.silent) {
            console.log(`[PartitionManager] 📂 Loaded ${this.parts.length} partition(s). Total enriched items: ${this.allIds.size}. Active part: ${path.basename(this.activePart.filePath)} (${(this.activePart.size / (1024 * 1024)).toFixed(1)} MB)`);
        }
    }

    _rotateNewPart() {
        const prevPart = this.activePart;
        if (this.lightweight && prevPart && !prevPart.dirty && Array.isArray(prevPart.items)) {
            prevPart.itemCount = prevPart.items.length;
            prevPart.items = null; // Free memory of rotated closed partition
        }
        const nextNum = this.parts.length + 1;
        const nextPath = path.join(this.enrichedDir, `javhd_enriched_part${nextNum}.json`);
        console.log(`[PartitionManager] 📦 Active partition reached limit (${(this.activePart.size / (1024 * 1024)).toFixed(1)} MB). Creating ${path.basename(nextPath)}`);
        const newPart = new EnrichedPart(nextPath, nextNum, []);
        this.parts.push(newPart);
        this.activePart = newPart;
    }

    has(id, code, slug) {
        if (id != null) return this.allIds.has(String(id));
        if (code) return this.allCodes.has(String(code).toUpperCase());
        if (slug) return this.allSlugs.has(String(slug).toLowerCase());
        return false;
    }

    find(id, code, slug) {
        if (id != null && this.index.has(`id:${id}`)) {
            const loc = this.index.get(`id:${id}`);
            return { item: loc.part.items[loc.itemIndex], part: loc.part, itemIndex: loc.itemIndex };
        }
        if (code && this.index.has(`code:${String(code).toUpperCase()}`)) {
            const loc = this.index.get(`code:${String(code).toUpperCase()}`);
            return { item: loc.part.items[loc.itemIndex], part: loc.part, itemIndex: loc.itemIndex };
        }
        if (slug && this.index.has(`slug:${String(slug).toLowerCase()}`)) {
            const loc = this.index.get(`slug:${String(slug).toLowerCase()}`);
            return { item: loc.part.items[loc.itemIndex], part: loc.part, itemIndex: loc.itemIndex };
        }
        return null;
    }

    add(item) {
        if (!item) return;

        // Check if current part size exceeds limit
        const estimatedItemBytes = JSON.stringify(item).length + 4;
        if (this.activePart.size + estimatedItemBytes >= this.maxPartSizeBytes && this.activePart.items.length > 0) {
            this.flush();
            this._rotateNewPart();
        }

        this.activePart.items.push(item);
        this.activePart.itemCount = this.activePart.items.length;
        this.activePart.dirty = true;
        this.activePart.size += estimatedItemBytes;

        const newIdx = this.activePart.items.length - 1;
        if (item.id != null) {
            this.allIds.add(String(item.id));
            if (!this.lightweight) this.index.set(`id:${item.id}`, { part: this.activePart, itemIndex: newIdx });
        }
        if (item.code) {
            const uc = String(item.code).toUpperCase();
            this.allCodes.add(uc);
            if (!this.lightweight) this.index.set(`code:${uc}`, { part: this.activePart, itemIndex: newIdx });
        }
        if (item.slug) {
            const ls = String(item.slug).toLowerCase();
            this.allSlugs.add(ls);
            if (!this.lightweight) this.index.set(`slug:${ls}`, { part: this.activePart, itemIndex: newIdx });
        }
    }

    upsert(item) {
        if (!item) return { action: 'none' };
        const found = this.find(item.id, item.code, item.slug);
        if (found) {
            found.part.items[found.itemIndex] = item;
            found.part.dirty = true;
            return { action: 'updated', part: found.part };
        } else {
            this.add(item);
            return { action: 'added', part: this.activePart };
        }
    }

    flush() {
        for (const part of this.parts) {
            if (part.dirty) {
                const tempPath = `${part.filePath}.tmp`;
                fs.writeFileSync(tempPath, JSON.stringify(part.items, null, 2), 'utf8');
                fs.renameSync(tempPath, part.filePath);
                part.dirty = false;
                part.size = fs.statSync(part.filePath).size;
            }
        }
    }

    getStats() {
        let totalItems = 0;
        let totalBytes = 0;
        const partsSummary = [];

        for (const part of this.parts) {
            const count = Array.isArray(part.items) ? part.items.length : (part.itemCount || 0);
            totalItems += count;
            totalBytes += part.size;
            partsSummary.push({
                file: path.basename(part.filePath),
                items: count,
                sizeMB: (part.size / (1024 * 1024)).toFixed(2)
            });
        }

        return {
            totalParts: this.parts.length,
            totalItems,
            totalSizeMB: (totalBytes / (1024 * 1024)).toFixed(2),
            partsSummary
        };
    }
}
