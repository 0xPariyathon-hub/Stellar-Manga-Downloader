'use strict';

const dns = require('dns');
const fs = require('fs');
const fsp = require('fs/promises');
const http = require('http');
const https = require('https');
const path = require('path');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const axios = require('axios');

const {
    USER_AGENT,
    createAbortError,
    extensionFor,
    isAcceptedImageType,
    isPrivateHost,
    pageBaseName,
    parseHttpUrl
} = require('./utils');

const DEFAULTS = Object.freeze({
    concurrency: 4,
    retries: 3,
    retryDelay: 1000,
    timeout: 30000,
    maxBytes: 50 * 1024 * 1024,
    maxRedirects: 5,
    skipExisting: true
});

const PAGE_FILE = /^(\d+)\.(jpe?g|png|webp|avif|gif|bmp)$/i;
const FATAL_FS_ERRORS = new Set(['EACCES', 'EPERM', 'ENOSPC', 'EROFS']);

class DownloadError extends Error {
    constructor(message, { retryable = false, status } = {}) {
        super(message);
        this.name = 'DownloadError';
        this.retryable = retryable;
        this.status = status;
    }
}

function isRetryable(error) {
    if (error instanceof DownloadError) return error.retryable;
    return !FATAL_FS_ERRORS.has(error?.code);
}

function delay(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(createAbortError());
            return;
        }
        const onAbort = () => {
            clearTimeout(timer);
            reject(createAbortError());
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

// Resolves host names and refuses to connect to private or loopback
// addresses. Checked at connect time, so DNS rebinding is covered as well.
function guardedLookup(hostname, options, callback) {
    dns.lookup(hostname, options, (error, address, family) => {
        if (error) {
            callback(error);
            return;
        }
        const entries = Array.isArray(address) ? address : [{ address, family }];
        if (entries.some(entry => isPrivateHost(entry.address))) {
            callback(new DownloadError(`Blocked request to private address (${hostname})`));
            return;
        }
        callback(null, address, family);
    });
}

function createAgents(allowPrivateHosts) {
    const options = { keepAlive: true, maxSockets: 8 };
    if (!allowPrivateHosts) options.lookup = guardedLookup;
    return {
        httpAgent: new http.Agent(options),
        httpsAgent: new https.Agent(options)
    };
}

function createStreamGuard({ maxBytes, timeout }) {
    let received = 0;
    let timer = null;

    const guard = new Transform({
        transform(chunk, encoding, callback) {
            received += chunk.length;
            if (received > maxBytes) {
                callback(new DownloadError(`File is larger than the size limit (${maxBytes} bytes)`));
                return;
            }
            arm();
            callback(null, chunk);
        },
        flush(callback) {
            clearTimeout(timer);
            callback();
        },
        destroy(error, callback) {
            clearTimeout(timer);
            callback(error);
        }
    });

    function arm() {
        clearTimeout(timer);
        timer = setTimeout(() => {
            guard.destroy(new DownloadError('Connection stalled', { retryable: true }));
        }, timeout);
    }

    arm();
    return guard;
}

async function openImageStream(startUrl, ctx) {
    let current = startUrl;

    for (let hop = 0; hop <= ctx.maxRedirects; hop++) {
        if (!ctx.allowPrivateHosts && isPrivateHost(current.hostname)) {
            throw new DownloadError(`Blocked request to private address (${current.hostname})`);
        }

        let response;
        try {
            response = await axios.get(current.href, {
                responseType: 'stream',
                timeout: ctx.timeout,
                maxRedirects: 0,
                validateStatus: () => true,
                signal: ctx.signal,
                httpAgent: ctx.agents.httpAgent,
                httpsAgent: ctx.agents.httpsAgent,
                headers: {
                    'User-Agent': USER_AGENT,
                    'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
                    'Referer': ctx.referer
                }
            });
        } catch (error) {
            if (ctx.signal?.aborted) throw createAbortError();
            if (error?.cause instanceof DownloadError) throw error.cause;
            if (error instanceof DownloadError) throw error;
            throw new DownloadError(error.message || 'Network error', { retryable: true });
        }

        const { status, headers, data } = response;

        if (status >= 300 && status < 400 && headers.location) {
            data.destroy();
            const next = parseHttpUrl(headers.location, current.href);
            if (!next) throw new DownloadError('Invalid redirect target');
            current = next;
            continue;
        }

        if (status < 200 || status >= 300) {
            data.destroy();
            const retryable = status === 408 || status === 429 || status >= 500;
            throw new DownloadError(`HTTP ${status}`, { retryable, status });
        }

        if (!isAcceptedImageType(headers['content-type'])) {
            data.destroy();
            throw new DownloadError(`Unexpected content type: ${headers['content-type']}`);
        }

        if (Number(headers['content-length']) > ctx.maxBytes) {
            data.destroy();
            throw new DownloadError(`File is larger than the size limit (${ctx.maxBytes} bytes)`);
        }

        return { stream: data, contentType: headers['content-type'], finalUrl: current.href };
    }

    throw new DownloadError('Too many redirects');
}

async function downloadPage(url, index, ctx) {
    const baseName = pageBaseName(index, ctx.total);
    const tempPath = path.join(ctx.directory, `${baseName}.part`);
    let lastError = null;

    for (let attempt = 1; attempt <= ctx.retries; attempt++) {
        try {
            const { stream, contentType, finalUrl } = await openImageStream(url, ctx);
            await pipeline(
                stream,
                createStreamGuard(ctx),
                fs.createWriteStream(tempPath),
                { signal: ctx.signal }
            );

            const finalPath = path.join(ctx.directory, baseName + extensionFor(contentType, finalUrl));
            await fsp.rename(tempPath, finalPath);
            return finalPath;
        } catch (error) {
            await fsp.rm(tempPath, { force: true }).catch(() => {});
            if (ctx.signal?.aborted) throw createAbortError();

            lastError = error;
            if (attempt === ctx.retries || !isRetryable(error)) break;
            await delay(ctx.retryDelay * attempt, ctx.signal);
        }
    }

    throw lastError;
}

async function findExistingPages(directory) {
    const pages = new Set();
    const entries = await fsp.readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
        if (!entry.isFile()) continue;
        const match = entry.name.match(PAGE_FILE);
        if (!match) continue;

        const { size } = await fsp.stat(path.join(directory, entry.name));
        if (size > 0) pages.add(Number(match[1]) - 1);
    }

    return pages;
}

async function downloadChapter(options = {}) {
    const opts = { ...DEFAULTS, ...options };
    const { images, directory, signal, onProgress } = opts;

    if (!Array.isArray(images) || images.length === 0) throw new Error('No images to download.');
    if (!directory) throw new Error('No output directory specified.');

    const pageUrl = parseHttpUrl(opts.referer);
    const allowPrivateHosts = Boolean(pageUrl && isPrivateHost(pageUrl.hostname));
    const urls = images.map(value => parseHttpUrl(value));
    const total = urls.length;

    await fsp.mkdir(directory, { recursive: true });
    const existing = opts.skipExisting ? await findExistingPages(directory) : new Set();

    const agents = createAgents(allowPrivateHosts);
    const ctx = {
        ...opts,
        total,
        agents,
        allowPrivateHosts,
        retries: Math.max(1, Math.floor(opts.retries) || 1)
    };
    const concurrency = Math.min(total, Math.max(1, Math.min(16, Math.floor(opts.concurrency) || 1)));

    const result = { total, completed: 0, skipped: 0, failed: [], cancelled: false };
    let processed = 0;
    let cursor = 0;

    const report = () => onProgress?.({
        processed,
        total,
        completed: result.completed,
        skipped: result.skipped,
        failed: result.failed.length
    });

    const worker = async () => {
        while (cursor < total && !signal?.aborted) {
            const index = cursor++;
            const url = urls[index];

            if (existing.has(index)) {
                result.skipped++;
            } else if (!url) {
                result.failed.push({ page: index + 1, reason: 'Invalid image URL' });
            } else {
                try {
                    const referer = pageUrl ? pageUrl.href : `${url.origin}/`;
                    await downloadPage(url, index, { ...ctx, referer });
                    result.completed++;
                } catch (error) {
                    if (signal?.aborted) break;
                    result.failed.push({ page: index + 1, reason: error.message });
                }
            }

            processed++;
            report();
        }
    };

    report();
    try {
        await Promise.all(Array.from({ length: concurrency }, worker));
    } finally {
        agents.httpAgent.destroy();
        agents.httpsAgent.destroy();
    }

    result.cancelled = Boolean(signal?.aborted);
    result.failed.sort((a, b) => a.page - b.page);
    return result;
}

module.exports = { downloadChapter, DownloadError, DEFAULTS };