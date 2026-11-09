'use strict';

const { USER_AGENT, createAbortError, isPrivateHost, parseHttpUrl } = require('./utils');

const NAVIGATION_TIMEOUT = 45000;
const SCROLL_TIME_LIMIT = 60000;
const NETWORK_IDLE = { idleTime: 1000, timeout: 10000 };
const MIN_PAGE_WIDTH = 300;
const MIN_PAGE_HEIGHT = 150;
const EXCLUDED_NAME = /(^|[^a-z0-9])(logo|icon|avatar|favicon|banner|sprite)([^a-z0-9]|$)/i;
const EXCLUDED_EXTENSION = /\.(gif|svg)$/i;

// Runs inside the page context. Must be self-contained.
function collectImages(smartMode, minWidth) {
    const SOURCE_ATTRIBUTES = ['data-src', 'data-lazy-src', 'data-original', 'data-url', 'data-image'];
    const isInline = value => /^(data|blob):/i.test(value);

    const sourceOf = img => {
        for (const name of SOURCE_ATTRIBUTES) {
            const value = (img.getAttribute(name) || '').trim();
            if (value && !isInline(value)) return value;
        }
        const current = img.currentSrc || img.src || '';
        return current && !isInline(current) ? current : null;
    };

    let images = Array.from(document.images);

    if (smartMode) {
        // Pick the deepest container holding the most full-size images.
        let best = null;
        let bestCount = 0;

        for (const element of document.querySelectorAll('div, article, section, main, ul, ol')) {
            let count = 0;
            for (const img of element.getElementsByTagName('img')) {
                if (img.naturalWidth >= minWidth) count++;
            }
            if (count > 0 && count >= bestCount) {
                best = element;
                bestCount = count;
            }
        }

        if (best && bestCount >= 2) {
            images = Array.from(best.getElementsByTagName('img'));
        }
    }

    return {
        title: document.title || '',
        items: images.map(img => ({
            src: sourceOf(img),
            width: img.naturalWidth,
            height: img.naturalHeight
        }))
    };
}

async function autoScroll(page) {
    await page.evaluate(async timeLimit => {
        await new Promise(resolve => {
            const startedAt = Date.now();
            let lastHeight = 0;
            let stableTicks = 0;

            const timer = setInterval(() => {
                window.scrollBy(0, 600);

                const height = document.documentElement.scrollHeight;
                const atBottom = window.scrollY + window.innerHeight >= height - 5;
                stableTicks = atBottom && height === lastHeight ? stableTicks + 1 : 0;
                lastHeight = height;

                if (stableTicks >= 5 || Date.now() - startedAt > timeLimit) {
                    clearInterval(timer);
                    resolve();
                }
            }, 250);
        });
    }, SCROLL_TIME_LIMIT);
}

function filterImages(items, pageUrl, smart) {
    const allowPrivate = isPrivateHost(pageUrl.hostname);
    const seen = new Set();
    const images = [];

    for (const item of items) {
        const url = parseHttpUrl(item.src, pageUrl.href);
        if (!url || seen.has(url.href)) continue;
        if (!allowPrivate && isPrivateHost(url.hostname)) continue;

        if (smart) {
            const fileName = url.pathname.split('/').pop() || '';
            if (EXCLUDED_EXTENSION.test(fileName) || EXCLUDED_NAME.test(fileName)) continue;
            if (item.width > 0 && (item.width < MIN_PAGE_WIDTH || item.height < MIN_PAGE_HEIGHT)) continue;
        }

        seen.add(url.href);
        images.push(url.href);
    }

    return images;
}

function friendlyError(error) {
    const message = String(error?.message || error);
    if (error?.name === 'TimeoutError') return new Error('The page took too long to load.');
    if (message.includes('ERR_NAME_NOT_RESOLVED')) return new Error('Could not resolve the host name.');
    if (message.includes('ERR_CONNECTION')) return new Error('Could not connect to the site.');
    if (message.includes('ERR_CERT')) return new Error('The site has an invalid TLS certificate.');
    return error instanceof Error ? error : new Error(message);
}

async function scrapeChapter(pageUrl, { mode = 'smart', signal } = {}) {
    const target = parseHttpUrl(pageUrl);
    if (!target) throw new Error('Enter a valid http(s) URL.');
    if (signal?.aborted) throw createAbortError();

    const puppeteer = require('puppeteer');
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--disable-notifications', '--mute-audio']
    });

    let closing = null;
    const closeBrowser = () => (closing ??= browser.close().catch(() => {}));
    signal?.addEventListener('abort', closeBrowser, { once: true });

    try {
        try {
            const cdp = await browser.target().createCDPSession();
            await cdp.send('Browser.setDownloadBehavior', { behavior: 'deny' });
        } catch {
            // Not supported by every browser build; scanning still works.
        }

        const page = await browser.newPage();
        await page.setViewport({ width: 1366, height: 900 });
        await page.setUserAgent(USER_AGENT);
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

        const response = await page.goto(target.href, {
            waitUntil: 'domcontentloaded',
            timeout: NAVIGATION_TIMEOUT
        });

        if (response && response.status() >= 400) {
            throw new Error(`The site responded with HTTP ${response.status()}.`);
        }

        await page.waitForNetworkIdle(NETWORK_IDLE).catch(() => {});
        await autoScroll(page);
        await page.waitForNetworkIdle(NETWORK_IDLE).catch(() => {});

        const smart = mode !== 'all';
        const { title, items } = await page.evaluate(collectImages, smart, MIN_PAGE_WIDTH);

        return { title: title.trim(), images: filterImages(items, target, smart) };
    } catch (error) {
        if (signal?.aborted) throw createAbortError();
        throw friendlyError(error);
    } finally {
        signal?.removeEventListener('abort', closeBrowser);
        await closeBrowser();
    }
}

module.exports = { scrapeChapter, filterImages };