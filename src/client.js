import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
    BASE_URL,
    RELEASEDAY_URL,
    HEADERS,
    DEFAULT_DELAY_MS,
    TIMEOUT_MS,
    MAX_RETRIES
} from './config.js';

const execFileAsync = promisify(execFile);
const CURL_BIN = process.platform === 'win32' ? 'curl.exe' : 'curl';

export class HttpClient {
    constructor(options = {}) {
        this.delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
        this.timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
        this.maxRetries = options.maxRetries ?? MAX_RETRIES;
        this.userAgent = options.userAgent || HEADERS['User-Agent'];
        this.headers = { ...HEADERS, ...(options.headers || {}) };
        this.lastRequestTime = 0;
    }

    async throttle() {
        const now = Date.now();
        const elapsed = now - this.lastRequestTime;
        if (elapsed < this.delayMs) {
            await new Promise(resolve => setTimeout(resolve, this.delayMs - elapsed));
        }
        this.lastRequestTime = Date.now();
    }

    /**
     * Executes HTTP GET using system curl with retry logic and full header emulation.
     */
    async get(url, customHeaders = {}, retries = this.maxRetries) {
        const timeoutSec = Math.max(5, Math.ceil(this.timeoutMs / 1000));
        let lastError = null;

        const effectiveHeaders = { ...this.headers, ...customHeaders };
        const headerArgs = [];
        for (const [k, v] of Object.entries(effectiveHeaders)) {
            if (k.toLowerCase() !== 'user-agent' && v !== undefined && v !== null && v !== '') {
                headerArgs.push('-H', `${k}: ${v}`);
            }
        }

        for (let attempt = 1; attempt <= retries; attempt++) {
            await this.throttle();

            // 1. Try system curl
            try {
                const { stdout } = await execFileAsync(CURL_BIN, [
                    '-sL',
                    '--compressed',
                    '--max-time', String(timeoutSec),
                    '-w', '\n__HTTP_STATUS__:%{http_code}',
                    '-A', effectiveHeaders['User-Agent'] || this.userAgent,
                    ...headerArgs,
                    url
                ], {
                    maxBuffer: 30 * 1024 * 1024,
                    windowsHide: true
                });

                if (stdout) {
                    const statusIdx = stdout.lastIndexOf('__HTTP_STATUS__:');
                    let statusCode = 200;
                    let body = stdout;
                    if (statusIdx !== -1) {
                        body = stdout.slice(0, statusIdx);
                        const statusStr = stdout.slice(statusIdx + '__HTTP_STATUS__:'.length).trim();
                        statusCode = parseInt(statusStr, 10) || 0;
                    }

                    if (statusCode === 404) return null;

                    if (statusCode === 429) {
                        const waitMs = 3000 * attempt;
                        console.warn(`[Client] Rate limited (429) on ${url}. Waiting ${waitMs / 1000}s...`);
                        await new Promise(r => setTimeout(r, waitMs));
                        continue;
                    }

                    if (statusCode >= 500) {
                        const waitMs = 2000 * attempt;
                        console.warn(`[Client] Server error (${statusCode}) on ${url}. Waiting ${waitMs / 1000}s...`);
                        await new Promise(r => setTimeout(r, waitMs));
                        continue;
                    }

                    if (statusCode >= 200 && statusCode < 300) {
                        return body;
                    }

                    lastError = new Error(`HTTP Error ${statusCode}: ${body.slice(0, 100)}`);
                }
            } catch (curlErr) {
                lastError = curlErr;

                // 2. Fallback to native fetch if curl failed to execute
                try {
                    const res = await fetch(url, {
                        headers: effectiveHeaders,
                        signal: AbortSignal.timeout(this.timeoutMs)
                    });
                    if (res.status === 404) return null;
                    if (res.ok) return await res.text();
                } catch (fetchErr) {
                    lastError = fetchErr;
                }
            }

            if (attempt === retries) {
                throw new Error(`Failed to GET ${url} after ${retries} attempts: ${lastError?.message || 'Unknown error'}`);
            }
            await new Promise(r => setTimeout(r, 1000 * attempt));
        }

        return null;
    }

    /**
     * Fetches and parses a JSON endpoint.
     */
    async getJson(url, customHeaders = {}) {
        const body = await this.get(url, customHeaders);
        if (!body) return null;
        try {
            return JSON.parse(body);
        } catch (e) {
            throw new Error(`Failed to parse JSON response from ${url}: ${e.message}`);
        }
    }

    /**
     * Fetches releaseday catalog page JSON.
     */
    async getCatalogPage(page = 1) {
        const url = `${RELEASEDAY_URL}?ajax=browse_videos&page=${page}`;
        return await this.getJson(url);
    }

    /**
     * Fetches video detail page HTML.
     */
    async getVideoHtml(idOrUrl) {
        const url = String(idOrUrl).startsWith('http') 
            ? String(idOrUrl) 
            : `${BASE_URL}/${String(idOrUrl).replace(/^\/+/, '')}/`;
        return await this.get(url, {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'X-Requested-With': undefined
        });
    }

    /**
     * Fetches video download page HTML.
     */
    async getDownloadHtml(id) {
        if (!id) return null;
        const url = `${BASE_URL}/download/${id}/`;
        return await this.get(url, {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Referer': `${BASE_URL}/${id}/`
        });
    }

    /**
     * Fetches related videos AJAX JSON.
     */
    async getRelatedVideos(canonicalUrl) {
        if (!canonicalUrl) return null;
        const cleanUrl = canonicalUrl.endsWith('/') ? canonicalUrl : `${canonicalUrl}/`;
        const url = `${cleanUrl}?ajax=related`;
        return await this.getJson(url, {
            'X-Requested-With': 'XMLHttpRequest',
            'Referer': cleanUrl
        });
    }
}
