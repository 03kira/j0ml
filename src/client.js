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
    DEFAULT_COOLDOWN_MS,
    COOKIE_JAR_PATH
} from './config.js';

const execFileAsync = promisify(execFile);
const CURL_BIN = process.platform === 'win32' ? 'curl.exe' : 'curl';

/**
 * Checks whether an HTTP response indicates a Cloudflare challenge or rate limit.
 */
export function isCloudflareChallenge(body = '', statusCode = 200) {
    if (statusCode === 429) return true;
    if (!body || typeof body !== 'string') return false;
    const lower = body.toLowerCase();
    if (statusCode === 403 || statusCode === 503) {
        if (lower.includes('cloudflare') || lower.includes('cf-chl') || lower.includes('just a moment') || lower.includes('turnstile') || lower.includes('challenge-platform')) {
            return true;
        }
    }
    if (lower.includes('<!doctype html') || lower.includes('<html')) {
        if (lower.includes('cf-chl') || lower.includes('challenge-platform') || lower.includes('just a moment...') || lower.includes('attention required! | cloudflare')) {
            return true;
        }
    }
    return false;
}

/**
 * Pauses execution for the specified duration while displaying a live countdown in the terminal.
 */
export async function sleepWithCountdown(durationMs, message = 'Cooldown in progress') {
    const start = Date.now();
    const end = start + durationMs;
    const isTTY = Boolean(process.stdout.isTTY);

    console.log(`\n======================================================`);
    console.log(`[Cooldown] 🛑 PAUSE TRIGGERED: ${message}`);
    console.log(`[Cooldown] ⏱️ Halting all requests for ${(durationMs / 60000).toFixed(1)} minutes.`);
    console.log(`[Cooldown] 💡 Tip: You can press Ctrl+C anytime to safely save progress and exit.`);
    console.log(`======================================================\n`);

    while (Date.now() < end) {
        const remainingMs = Math.max(0, end - Date.now());
        const totalSec = Math.ceil(remainingMs / 1000);
        const mins = Math.floor(totalSec / 60);
        const secs = totalSec % 60;
        const timeStr = `${mins}m ${secs < 10 ? '0' : ''}${secs}s`;

        if (isTTY) {
            process.stdout.write(`\r[Cooldown] ⏳ Remaining: ${timeStr} until requests resume...       `);
        } else {
            if (totalSec % 60 === 0 || remainingMs <= 5000) {
                console.log(`[Cooldown] ⏳ Remaining: ${timeStr} until requests resume...`);
            }
        }

        const step = Math.min(1000, remainingMs);
        if (step <= 0) break;
        await new Promise(r => setTimeout(r, step));
    }

    if (isTTY) {
        process.stdout.write('\r[Cooldown] ⏳ 0m 00s remaining until requests resume...       \n');
    }
    console.log(`\n[Cooldown] ✅ Cooldown completed! Resuming crawler requests now...\n`);
}

export class HttpClient {
    constructor(options = {}) {
        this.delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
        this.timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
        this.maxRetries = options.maxRetries ?? MAX_RETRIES;
        this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
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
     * Halts all requests and enters a 10-15 minute cooldown to allow Cloudflare IP rate limits to reset.
     */
    async handleCooldown(url, reason = 'Cloudflare challenge / rate-limit detected') {
        console.warn(`\n[Client] ⚠️ Cloudflare challenge / rate-limit triggered at: ${url}`);
        console.warn(`[Client] 🛑 Stopping all requests immediately.`);

        // Clear cookies to avoid reusing blocked challenge session tokens
        if (this.cookieJarPath && fs.existsSync(this.cookieJarPath)) {
            try {
                fs.unlinkSync(this.cookieJarPath);
                console.log(`[Client] 🧹 Cleared cookie jar (${path.basename(this.cookieJarPath)}) for a clean retry session.`);
            } catch {}
        }

        await sleepWithCountdown(this.cooldownMs, reason);
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
                        await this.handleCooldown(url, `HTTP 429 Too Many Requests (attempt ${attempt}/${retries})`);
                        continue;
                    }

                    if (isCloudflareChallenge(body, statusCode)) {
                        await this.handleCooldown(url, `Cloudflare challenge detected (HTTP ${statusCode}, attempt ${attempt}/${retries})`);
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
                    if (res.status === 429) {
                        await this.handleCooldown(url, `Fetch HTTP 429 Too Many Requests`);
                        continue;
                    }
                    if (res.ok) {
                        const text = await res.text();
                        if (isCloudflareChallenge(text, res.status)) {
                            await this.handleCooldown(url, `Fetch Cloudflare challenge detected`);
                            continue;
                        }
                        return text;
                    }
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
     * Fetches and parses a JSON endpoint with HTML / Cloudflare challenge detection & 10-15m backoff cooldown.
     */
    async getJson(url, customHeaders = {}, maxCooldownCycles = 2) {
        let cooldownCycles = 0;

        while (true) {
            const body = await this.get(url, {
                'Accept': 'application/json, text/javascript, */*; q=0.01',
                ...customHeaders
            });
            if (!body) return null;

            const trimmed = body.trim();

            // Check if Cloudflare or server returned HTML challenge page instead of JSON
            if (trimmed.startsWith('<') || trimmed.includes('<!DOCTYPE') || trimmed.includes('<html')) {
                if (cooldownCycles < maxCooldownCycles) {
                    cooldownCycles++;
                    console.warn(`\n[Client] ⚠️ Received HTML instead of JSON from ${url} (Cloudflare challenge / temporary rate limit).`);
                    console.warn(`[Client] 🛑 Halting all requests immediately (Cooldown cycle ${cooldownCycles}/${maxCooldownCycles})...`);

                    await this.handleCooldown(url, `Received HTML challenge page instead of JSON from ${url}`);

                    console.log(`[Client] 🔄 Cooldown elapsed. Retrying JSON request to ${url}...`);
                    continue;
                } else {
                    throw new Error(`Cloudflare challenge persisted at ${url} after ${cooldownCycles} cooldown cycle(s) (${((cooldownCycles * this.cooldownMs) / 60000).toFixed(0)} mins pause).`);
                }
            }

            try {
                return JSON.parse(body);
            } catch (e) {
                throw new Error(`Failed to parse JSON response from ${url}: ${e.message}`);
            }
        }
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
            const data = await this.getJson(urlA, headers);
            if (data && data.html) return data;
        } catch (err) {
            if (err.message && err.message.includes('Cloudflare challenge persisted')) {
                throw err;
            }
            console.warn(`[Client] Primary endpoint error on page ${page}: ${err.message}. Trying fallback...`);
        }

        // Fallback to path-based AJAX endpoint: /releaseday/N/?ajax=browse_videos&page=N
        if (page > 1) {
            const urlB = `${RELEASEDAY_URL}${page}/?ajax=browse_videos&page=${page}`;
            return await this.getJson(urlB, headers);
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
