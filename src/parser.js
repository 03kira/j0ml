/**
 * JAVHD.today HTML & Card Parser
 * Pure zero-dependency regular expression parser for video cards, pagination, download pages, and full detail dossiers.
 */

import { BASE_URL } from './config.js';

export function decodeHtmlEntities(str) {
    if (!str || typeof str !== 'string') return '';
    return str
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#039;/g, "'")
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .trim();
}

/**
 * Parses video cards from the AJAX HTML payload of catalog pages or related videos.
 */
export function parseVideoCards(html) {
    if (!html || typeof html !== 'string') return [];

    const cards = [];
    const seen = new Set();

    // Match each <li id="video-..."> container
    const liRegex = /<li[^>]*id=["']video-(\d+)["'][\s\S]*?<\/li>/gi;
    let liMatch;

    while ((liMatch = liRegex.exec(html)) !== null) {
        const id = liMatch[1];
        if (seen.has(id)) continue;
        seen.add(id);

        const cardHtml = liMatch[0];

        // 1. Link & Slug
        const linkMatch = cardHtml.match(/<a[^>]*href=["'](?:\/|https:\/\/javhd\.today\/)?(\d+)\/([^"'\s]+)\/?["']/i);
        const slug = linkMatch ? linkMatch[2].replace(/\/+$/, '') : '';
        const url = `${BASE_URL}/${id}/${slug}/`;

        // 2. Title
        const titleMatch = cardHtml.match(/title=["']([^"']+)["']/i) || 
                           cardHtml.match(/<span[^>]*class=["'][^"']*video-title[^"']*["'][^>]*>([\s\S]*?)<\/span>/i);
        const rawTitle = titleMatch ? (titleMatch[1] || '') : '';
        const title = decodeHtmlEntities(rawTitle).replace(/\s+/g, ' ');

        // 3. Thumbnail
        const imgMatch = cardHtml.match(/<img[^>]*src=["']([^"']+)["']/i);
        let thumbnail = imgMatch ? imgMatch[1].trim() : '';
        if (thumbnail.startsWith('//')) thumbnail = `https:${thumbnail}`;
        else if (thumbnail.startsWith('/')) thumbnail = `${BASE_URL}${thumbnail}`;

        // 4. DVD Code (e.g. JIMMY-016, SSNI-221, FC2PPV-5003320)
        const codeBadgeMatch = cardHtml.match(/<span[^>]*class=["'][^"']*video-overlay1[^"']*["'][^>]*>([\s\S]*?)<\/span>/i);
        let code = codeBadgeMatch ? codeBadgeMatch[1].replace(/<[^>]+>/g, '').trim() : '';

        if (!code || code.length < 3) {
            const extracted = title.match(/\b([A-Z0-9]{2,8}-[0-9]{2,8})\b/i) ||
                              title.match(/\b(FC2PPV[-_]?\d+)\b/i) ||
                              title.match(/\b(10musume[-_]?\d+)\b/i) ||
                              title.match(/\b(caribbeancom[-_]?\d+)\b/i) ||
                              title.match(/\b(heyzo[-_]?\d+)\b/i);
            if (extracted) code = extracted[1].toUpperCase();
        }

        // 5. Duration & HD Badge
        const overlayMatch = cardHtml.match(/<span[^>]*class=["'][^"']*video-overlay badge[^"']*["'][^>]*>([\s\S]*?)<\/span>/i);
        const overlayText = overlayMatch ? overlayMatch[1] : '';
        const isHd = /HD/i.test(overlayText);
        const durationMatch = overlayText.match(/(\d{1,2}:\d{2}(?::\d{2})?)/);
        const duration = durationMatch ? durationMatch[1] : null;

        // 6. Upload Time Ago
        const timeMatch = cardHtml.match(/<span[^>]*class=["'][^"']*video-overlay2[^"']*["'][^>]*>([\s\S]*?)<\/span>/i);
        const uploadedAgo = timeMatch ? timeMatch[1].replace(/<[^>]+>/g, '').trim() : null;

        // 7. Views & Likes
        const viewsMatch = cardHtml.match(/<i[^>]*fa-eye[^>]*><\/i>\s*(\d+)/i);
        const views = viewsMatch ? parseInt(viewsMatch[1], 10) : null;

        const likesMatch = cardHtml.match(/<i[^>]*fa-heart[^>]*><\/i>\s*(\d+)/i);
        const likes = likesMatch ? parseInt(likesMatch[1], 10) : null;

        cards.push({
            id: Number(id),
            code: code ? code.toUpperCase() : null,
            slug,
            title,
            url,
            thumbnail: thumbnail || null,
            duration,
            is_hd: isHd,
            views,
            likes,
            uploaded_ago: uploadedAgo
        });
    }

    return cards;
}

/**
 * Extracts total pages count and pagination metadata from pagination HTML.
 */
export function parsePagination(paginationHtml, fallbackTotal = 13569) {
    if (!paginationHtml || typeof paginationHtml !== 'string') {
        return { totalPages: fallbackTotal, hasNext: false, hasPrev: false };
    }

    const pageMatches = [...paginationHtml.matchAll(/page[=/](\d+)/g)].map(m => parseInt(m[1], 10));
    const slashMatches = [...paginationHtml.matchAll(/\/releaseday\/(\d+)\//g)].map(m => parseInt(m[1], 10));
    const allNums = [...pageMatches, ...slashMatches].filter(n => !isNaN(n) && n > 0);

    const totalPages = allNums.length > 0 ? Math.max(...allNums) : fallbackTotal;
    const hasNext = /class=["'][^"']*prevnext[^"']*["'][^>]*>[\s\S]*?next/i.test(paginationHtml);
    const hasPrev = /class=["'][^"']*prevnext[^"']*["'][^>]*>[\s\S]*?prev/i.test(paginationHtml);

    return {
        totalPages,
        hasNext,
        hasPrev
    };
}

/**
 * Parses direct download links from video download page (https://javhd.today/download/{id}/).
 */
export function parseDownloads(downloadHtml) {
    if (!downloadHtml || typeof downloadHtml !== 'string') return [];

    const downloads = [];
    const seenUrls = new Set();

    const linkRegex = /<a[^>]*href=['"\\]+([^'"\\]+)['"\\]+[^>]*>([\s\S]*?)<\/a>/gi;
    let match;

    while ((match = linkRegex.exec(downloadHtml)) !== null) {
        let url = match[1].trim();
        const text = match[2].replace(/<[^>]+>/g, '').trim();

        if (url.startsWith('\\')) url = url.replace(/^\\+/, '');
        if (text.toLowerCase().includes('download') || url.includes('/embed/') || url.includes('/d/') || url.includes('/f/') || url.includes('/e/')) {
            if (url.startsWith('http') && !seenUrls.has(url)) {
                seenUrls.add(url);
                const nameMatch = text.match(/Download\s+([A-Za-z0-9_-]+)(?:\.mp4)?/i);
                const serverName = nameMatch ? nameMatch[1] : (url.match(/https?:\/\/([^/]+)/) || [])[1] || 'Download';

                downloads.push({
                    server: serverName,
                    url,
                    label: text
                });
            }
        }
    }

    return downloads;
}

/**
 * Parses full video detail page HTML into enriched schema with download sources, embed sources, and related videos.
 */
export function parseVideoDetail(html, pageUrl, catalogItem = {}, extras = {}) {
    if (!html || typeof html !== 'string') return null;

    // 1. Video ID
    const idMatch = pageUrl.match(/javhd\.today\/(\d+)\//) || html.match(/id="video-(\d+)"/);
    const id = idMatch ? parseInt(idMatch[1], 10) : (catalogItem.id || null);

    // 2. Titles (English & Japanese/Chinese)
    const h1Matches = [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)].map(m => decodeHtmlEntities(m[1].replace(/<[^>]+>/g, '').trim()));
    const title = h1Matches[0] || catalogItem.title || '';
    const titleAlt = h1Matches.length > 1 ? h1Matches[1] : null;

    // 3. DVD Release Code
    let code = catalogItem.code || null;
    if (!code) {
        const codeMatch = title.match(/\b([A-Z0-9]{2,8}-[0-9]{2,8})\b/i) ||
                          title.match(/\b(FC2PPV[-_]?\d+)\b/i) ||
                          title.match(/\b(10musume[-_]?\d+)\b/i) ||
                          title.match(/\b(caribbeancom[-_]?\d+)\b/i) ||
                          title.match(/\b(heyzo[-_]?\d+)\b/i);
        if (codeMatch) code = codeMatch[1].toUpperCase();
    }

    // 4. Thumbnail & Poster
    let thumbnail = catalogItem.thumbnail || null;
    const posterMatch = html.match(/<div[^>]*class=["'][^"']*col-xs-12[^"']*["'][^>]*>\s*<div[^>]*>\s*<img[^>]*src=["']([^"']+)["']/i) ||
                        html.match(/<img[^>]*src=["'](https:\/\/pics\.javhd\.today\/videos\/tmb\/[^"']+)["']/i);
    if (posterMatch) {
        thumbnail = posterMatch[1].trim();
        if (thumbnail.startsWith('//')) thumbnail = `https:${thumbnail}`;
    }

    // 5. Release Date
    let releaseDate = null;
    const relMatch = html.match(/Release\s*Day:\s*(\d{4}-\d{2}-\d{2})/i);
    if (relMatch) {
        releaseDate = relMatch[1];
    }

    // 6. Studio
    let studio = null;
    const studioMatch = html.match(/Studio:\s*<a[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (studioMatch) {
        const name = decodeHtmlEntities(studioMatch[2].replace(/<[^>]+>/g, '').trim());
        const href = studioMatch[1].trim();
        if (name) {
            studio = {
                name,
                url: href.startsWith('http') ? href : `${BASE_URL}${href}`
            };
        }
    }

    // 7. Director
    let director = null;
    const dirMatch = html.match(/Director:\s*<a[^>]*href=["'][^"']*s=([^"']*)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (dirMatch && dirMatch[2].trim()) {
        director = decodeHtmlEntities(dirMatch[2].replace(/<[^>]+>/g, '').trim());
    }

    // 8. Label
    let label = null;
    const labelMatch = html.match(/Label:\s*<a[^>]*href=["'][^"']*s=([^"']*)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (labelMatch && labelMatch[2].trim()) {
        label = decodeHtmlEntities(labelMatch[2].replace(/<[^>]+>/g, '').trim());
    }

    // 9. Country
    let country = 'Japan';
    const countryMatch = html.match(/Country:\s*<a[^>]*>([\s\S]*?)<\/a>/i);
    if (countryMatch && countryMatch[1].trim()) {
        country = decodeHtmlEntities(countryMatch[1].replace(/<[^>]+>/g, '').trim());
    }

    // 10. Genres
    const genres = [];
    const genreBlockMatch = html.match(/Genre:\s*([\s\S]*?)(?:<hr\/|<div|<i class="fa fa-caret-right"|$)/i);
    if (genreBlockMatch) {
        const aMatches = [...genreBlockMatch[1].matchAll(/<a[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi)];
        for (const m of aMatches) {
            const gName = decodeHtmlEntities(m[2].replace(/<[^>]+>/g, '').trim());
            const gHref = m[1].trim();
            if (gName && !genres.some(g => g.name.toLowerCase() === gName.toLowerCase())) {
                const slugMatch = gHref.match(/\/([^/]+)\/?$/);
                genres.push({
                    name: gName,
                    slug: slugMatch ? slugMatch[1] : gName.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
                    url: gHref.startsWith('http') ? gHref : `${BASE_URL}${gHref}`
                });
            }
        }
    }

    // 11. Actresses / Starring
    const actresses = [];
    const starringBlockMatch = html.match(/starring:\s*([\s\S]*?)(?:<hr\/|<div|<i class="fa fa-caret-right"|$)/i);
    if (starringBlockMatch) {
        const aMatches = [...starringBlockMatch[1].matchAll(/<a[^>]*href=["']([^"']*\/pornstar\/[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi)];
        for (const m of aMatches) {
            const aName = decodeHtmlEntities(m[2].replace(/<[^>]+>/g, '').trim());
            const aHref = m[1].trim();
            const slugMatch = aHref.match(/\/pornstar\/([^/]+)\/?/);
            if (aName && slugMatch && !actresses.some(a => a.slug === slugMatch[1])) {
                actresses.push({
                    name: aName,
                    slug: slugMatch[1],
                    url: aHref.startsWith('http') ? aHref : `${BASE_URL}${aHref}`,
                    avatar_url: `https://pics.javhd.today/models/${slugMatch[1]}.jpg`
                });
            }
        }
    }

    // 12. Tags
    const tags = [];
    const tagsBlockMatch = html.match(/Tags:\s*([\s\S]*?)(?:<hr\/|<div|class=["'][^"']*col-|<ul|$)/i);
    if (tagsBlockMatch) {
        const aMatches = [...tagsBlockMatch[1].matchAll(/<a[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi)];
        for (const m of aMatches) {
            const tName = decodeHtmlEntities(m[2].replace(/<[^>]+>/g, '').trim());
            const tHref = m[1].trim();
            if (tName && !tags.some(t => t.name.toLowerCase() === tName.toLowerCase())) {
                const slugMatch = tHref.match(/\/([^/]+)\/?$/);
                tags.push({
                    name: tName,
                    slug: slugMatch ? slugMatch[1] : tName.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
                    url: tHref.startsWith('http') ? tHref : `${BASE_URL}${tHref}`
                });
            }
        }
    }

    // 13. Decoded Streaming Servers & Embed Sources
    const servers = [];
    const seenServers = new Set();
    const btnRegex = /<button[^>]*class=["'][^"']*button_choice_server[^"']*["'][^>]*>([\s\S]*?)<\/button>/gi;
    let btnMatch;

    while ((btnMatch = btnRegex.exec(html)) !== null) {
        const btnHtml = btnMatch[0];
        const btnText = decodeHtmlEntities(btnMatch[1].replace(/<[^>]+>/g, '').trim()).replace(/^LIVE\s*/i, '');

        const nameMatch = btnHtml.match(/data-name=["']([^"']+)["']/i);
        const name = nameMatch ? nameMatch[1].trim() : btnText;

        const embedB64 = (btnHtml.match(/data-embed=["']([^"']+)["']/i) || [])[1];
        const embedsB64 = (btnHtml.match(/data-embeds=["']([^"']+)["']/i) || [])[1];

        let embedUrl = '';
        let failoverUrls = [];

        if (embedB64) {
            try {
                embedUrl = Buffer.from(embedB64, 'base64').toString('utf8');
            } catch {}
        }

        if (embedsB64) {
            try {
                const decoded = Buffer.from(embedsB64, 'base64').toString('utf8');
                const parsed = JSON.parse(decoded);
                if (Array.isArray(parsed) && parsed.length > 0) {
                    failoverUrls = parsed;
                    if (!embedUrl) embedUrl = parsed[0];
                }
            } catch {}
        }

        if (name && (embedUrl || failoverUrls.length > 0) && !seenServers.has(name)) {
            seenServers.add(name);
            const resolvedEmbedSrc = embedUrl || failoverUrls[0] || '';
            const iframeCode = `<iframe src="${resolvedEmbedSrc}" width="100%" height="100%" frameborder="0" scrolling="no" allowfullscreen></iframe>`;

            servers.push({
                name,
                embed_src: resolvedEmbedSrc,
                iframe_src: resolvedEmbedSrc,
                iframe_code: iframeCode,
                failover_urls: failoverUrls.length > 0 ? failoverUrls : undefined,
                is_direct_player: /data-player=["']1["']/i.test(btnHtml) || embedsB64 !== undefined
            });
        }
    }

    const primaryEmbedSrc = servers[0]?.embed_src || null;
    const primaryIframeCode = primaryEmbedSrc 
        ? `<iframe src="${primaryEmbedSrc}" width="100%" height="100%" frameborder="0" scrolling="no" allowfullscreen></iframe>`
        : null;

    // 14. Download Sources
    let downloads = [];
    if (extras.downloads && Array.isArray(extras.downloads)) {
        downloads = extras.downloads;
    } else if (extras.downloadHtml) {
        downloads = parseDownloads(extras.downloadHtml);
    }

    // 15. Related Videos
    let relatedVideos = [];
    if (extras.relatedVideos && Array.isArray(extras.relatedVideos)) {
        relatedVideos = extras.relatedVideos;
    } else if (extras.relatedHtml) {
        relatedVideos = parseVideoCards(extras.relatedHtml).filter(v => v.id !== id);
    }

    return {
        id,
        code,
        title,
        title_alt: titleAlt,
        url: pageUrl,
        slug: catalogItem.slug || (pageUrl.match(/\/(\d+)\/([^/]+)\/?/) || [])[2] || '',
        thumbnail,
        duration: catalogItem.duration || null,
        is_hd: catalogItem.is_hd ?? true,
        release_date: releaseDate,
        studio,
        director,
        label,
        country,
        actresses,
        genres,
        tags,
        primary_embed_src: primaryEmbedSrc,
        primary_iframe_src: primaryEmbedSrc,
        embed_code: primaryIframeCode,
        servers,
        download_page_url: id ? `${BASE_URL}/download/${id}/` : null,
        downloads,
        related_videos: relatedVideos.slice(0, 12),
        views: catalogItem.views || null,
        likes: catalogItem.likes || null,
        scraped_at: new Date().toISOString()
    };
}
