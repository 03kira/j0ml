# JAVHD.today Standalone Scraper & Dataset Builder

High-performance, resilient scraper and database builder for [JAVHD.today](https://javhd.today) with zero external npm dependencies, automatic 85 MB dataset partitioning (to strictly comply with GitHub's 100 MB file limit), multi-server streaming embed extraction, and self-cascading GitHub Actions workflow orchestration.

---

## 🏗️ Architecture & Features

- **Zero External Dependencies**: Pure modern Node.js 22 (ES modules) + system `curl` engine with resilient fallback to native `fetch`.
- **Two-Stage Pipeline**:
  1. **Stage 1 (Catalog Indexer)**: Crawls `https://javhd.today/releaseday/?ajax=browse_videos&page={p}` across all ~13,569 pages (~380,000 items). Extracts IDs, DVD release codes (e.g. `DAL-013`, `JIMMY-016`), titles, thumbnail URLs, durations, HD badges, view counts, and upload relative dates.
  2. **Stage 2 (Detail & Stream Enricher)**: Crawls each video dossier, decodes Base64 multi-server streaming buttons (BpServer, Fastserver, Myserver, Topserver, STserver, Dood, Streamtape, etc.), resolves studio/channels, director, release date, cast/actresses, genres, and tags.
- **85 MB Auto-Partitioning (`PartitionManager`)**: Automatically manages and rotates chunked JSON files (`javhd_enriched_part1.json`, `javhd_enriched_part2.json`, ...) strictly under 85 MB so the repository never exceeds GitHub's 100 MB hard limit.
- **Auto-Cascading GitHub Actions**: `.github/workflows/javhd_enrich.yml` runs 4.5-hour batches, automatically commits and pushes enriched data, and triggers the next cycle if pending titles remain.

---

## 📁 Repository Structure

```text
JAVHD_GHA/
├── .github/
│   └── workflows/
│       └── javhd_enrich.yml       # Auto-cascading GitHub Actions workflow
├── data/
│   ├── catalog/
│   │   ├── javhd_catalog_test.json # Sample test catalog (84 items)
│   │   └── javhd_catalog.json      # Production indexed catalog
│   ├── enriched/
│   │   ├── javhd_enriched_part1.json # Enriched dataset partition 1 (< 85 MB)
│   │   └── javhd_enriched_part2.json # Enriched dataset partition 2 ...
│   └── checkpoint.json            # Indexer & Enricher progress checkpoints
├── src/
│   ├── client.js                  # Resilient curl HTTP engine with auto-retry
│   ├── config.js                  # Endpoints, headers, timeouts, partition caps
│   ├── indexer.js                 # Fast catalog crawler with checkpointing
│   ├── parser.js                  # Zero-dependency regex card & detail parser
│   ├── partition.js               # 85 MB partition manager with in-memory index
│   ├── enricher.js                # Full metadata & streaming server crawler
│   ├── probe.js                   # Domain connectivity diagnostic tool
│   ├── check-continue.js          # GHA worker continuation trigger
│   └── status.js                  # Formatted CLI status report
├── package.json
└── README.md
```

---

## 🚀 Quick Start & CLI Usage

### 1. Check Connectivity
```bash
npm run probe
```

### 2. Catalog Indexing (Stage 1)
```bash
# Quick test (3 pages = 84 titles)
npm run index:test

# Crawl a specific number of pages
node src/indexer.js --pages 500

# Resume previous crawl from checkpoint
node src/indexer.js --resume

# Full crawl across all ~13,569 pages
npm run index:all
```

### 3. Detail Enrichment (Stage 2)
```bash
# Test run (5 titles from test catalog)
npm run enrich:test

# Enrich pending titles with custom batch size and delay
node src/enricher.js --batch 200 --delay 200

# Enrich single video by ID or URL
node src/enricher.js --id 380028
node src/enricher.js --url https://javhd.today/380028/
```

### 4. Database Status Dashboard
```bash
npm run status
```

---

## 📊 Dataset Schema

Each video record in `data/enriched/javhd_enriched_partN.json` adheres to:

```json
{
  "id": 380028,
  "code": "DAL-013",
  "title": "Doc DAL-013 Marin Amamiya, 23 years old, AV Debut...",
  "title_alt": "Doc DAL-013 马林·阿玛米亚...",
  "url": "https://javhd.today/380028/",
  "slug": "doc-dal-013-marin-amamiya...",
  "thumbnail": "https://pics.javhd.today/videos/tmb/000/380/028/1.jpg",
  "duration": "02:18:00",
  "is_hd": true,
  "release_date": "2026-12-17",
  "studio": {
    "name": "DOC",
    "url": "https://javhd.today/channel/doc"
  },
  "director": null,
  "label": "Doc",
  "country": "Japan",
  "actresses": [
    {
      "name": "Marin Amamiya",
      "slug": "marin-amamiya",
      "url": "https://javhd.today/pornstar/marin-amamiya/",
      "avatar_url": "https://pics.javhd.today/models/marin-amamiya.jpg"
    }
  ],
  "genres": [
    { "name": "Big Tits", "slug": "big-tits", "url": "https://javhd.today/categories/big-tits/" }
  ],
  "tags": [
    { "name": "Beautiful Girl", "slug": "beautiful-girl", "url": "https://javhd.today/tag/beautiful-girl/" }
  ],
  "servers": [
    {
      "name": "BpServer",
      "iframe_src": "https://stream10.javhdz.today/embed_server12.php?p=...",
      "embed_url": "https://stream10.javhdz.today/embed_server12.php?p=...",
      "failover_urls": [
        "https://stream10.javhdz.today/embed_server12.php?p=...",
        "https://stream11.javhdz.today/embed_server12.php?p=..."
      ],
      "is_direct_player": true
    },
    {
      "name": "Dood",
      "iframe_src": "https://dooood.com/e/m79v0m7wniom",
      "embed_url": "https://dooood.com/e/m79v0m7wniom",
      "is_direct_player": false
    }
  ],
  "primary_iframe_src": "https://stream10.javhdz.today/embed_server12.php?p=...",
  "views": 53540,
  "likes": 664,
  "scraped_at": "2026-11-20T10:23:32.000Z"
}
```
