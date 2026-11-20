import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
    BASE_URL,
    RELEASEDAY_URL,
    HEADERS,
    DEFAULT_DELAY_MS,
    TIMEOUT_MS,
    MAX_RETRIES,
    COOKIE_JAR_PATH
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
        this.cookieJarPath = options.cookieJarPath || COOKIE_JAR_PATH;

        if (this.cookieJarPath) {
            const dir = path.dirname(this.cookieJarPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        }
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
     * Executes HTTP GET using system curl with retry logic, cookie jar, and full header emulation.
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

        const cookieArgs = [];
        if (this.cookieJarPath) {
            cookieArgs.push('-c', this.cookieJarPath, '-b', this.cookieJarPath);
        }

        for (let attempt = 1; attempt <= retries; attempt++) {
            await this.throttle();

            // 1. Try system curl
            try {
                const { stdout } = await execFileAsync(CURL_BIN, [
                    '-sL',
                    '--compressed',
                    '--max-time', String(timeoutSec),
                    ...cookieArgs,
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
                        const waitMs = 3500 * attempt;
                        console.warn(`[Client] Rate limited (429) on ${url}. Waiting ${waitMs / 1000}s...`);
                        await new Promise(r => setTimeout(r, waitMs));
                        continue;
                    }

                    if (statusCode >= 500) {
                        const waitMs = 3000 * attempt;
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
            await new Promise(r => setTimeout(r, 1500 * attempt));
        }

        return null;
    }

    /**
     * Fetches and parses a JSON endpoint with HTML / Cloudflare challenge detection & backoff.
     */
    async getJson(url, customHeaders = {}, retries = 3) {
        for (let attempt = 1; attempt <= retries; attempt++) {
            const body = await this.get(url, {
                'Accept': 'application/json, text/javascript, */*; q=0.01',
                ...customHeaders
            });
            if (!body) return null;

            const trimmed = body.trim();
            // Check if Cloudflare or server returned HTML challenge page instead of JSON
            if (trimmed.startsWith('<') || trimmed.includes('<!DOCTYPE')) {
                const waitMs = 4000 * attempt;
                console.warn(`[Client] ⚠️ Received HTML instead of JSON from ${url} (Cloudflare challenge / temporary rate limit). Pausing ${waitMs / 1000}s (attempt ${attempt}/${retries})...`);
                await new Promise(r => setTimeout(r, waitMs));
                continue;
            }

            try {
                return JSON.parse(body);
            } catch (e) {
                if (attempt === retries) {
                    throw new Error(`Failed to parse JSON response from ${url}: ${e.message}`);
                }
                await new Promise(r => setTimeout(r, 2000 * attempt));
            }
        }
        return null;
    }

    /**
     * Fetches releaseday catalog page JSON with automatic format fallback and proper AJAX headers.
     */
    async getCatalogPage(page = 1) {
        const headers = {
            'Accept': 'application/json, text/javascript, */*; q=0.01',
            'X-Requested-With': 'XMLHttpRequest',
            'Referer': page > 1 ? `${RELEASEDAY_URL}${page}/` : RELEASEDAY_URL
        };

        // Try primary AJAX endpoint: /releaseday/?ajax=browse_videos&page=N
        const urlA = `${RELEASEDAY_URL}?ajax=browse_videos&page=${page}`;
        try {
            const data = await this.getJson(urlA, headers, 2);
            if (data && data.html) return data;
        } catch {}

        // Fallback to path-based AJAX endpoint: /releaseday/N/?ajax=browse_videos&page=N
        if (page > 1) {
            const urlB = `${RELEASEDAY_URL}${page}/?ajax=browse_videos&page=${page}`;
            return await this.getJson(urlB, headers, 3);
        }

        return null;
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
