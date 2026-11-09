'use strict';

const net = require('net');

const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const INVALID_NAME_CHARS = /[<>:"/\\|?*\x00-\x1f\x7f]/g;
const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i;
const MAX_NAME_LENGTH = 120;

const MIME_EXTENSIONS = {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/avif': '.avif',
    'image/gif': '.gif',
    'image/bmp': '.bmp'
};

const KNOWN_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif', '.bmp']);

function sanitizeName(input, fallback = 'Untitled') {
    const name = String(input ?? '')
        .normalize('NFC')
        .replace(INVALID_NAME_CHARS, '_')
        .replace(/\s+/g, ' ')
        .slice(0, MAX_NAME_LENGTH)
        .replace(/^[\s.]+|[\s.]+$/g, '');

    if (!name || WINDOWS_RESERVED_NAMES.test(name)) return fallback;
    return name;
}

function parseHttpUrl(value, base) {
    if (typeof value !== 'string' || !value.trim()) return null;
    try {
        const url = new URL(value.trim(), base);
        return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
    } catch {
        return null;
    }
}

function isPrivateIPv4(address) {
    const [a, b] = address.split('.').map(Number);
    return (
        a === 0 ||
        a === 10 ||
        a === 127 ||
        (a === 100 && b >= 64 && b <= 127) ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        a >= 224
    );
}

function isPrivateIPv6(address) {
    const ip = address.toLowerCase();
    if (ip === '::' || ip === '::1') return true;
    if (/^f[cd][0-9a-f]{2}:/.test(ip)) return true;     // fc00::/7
    if (/^fe[89ab][0-9a-f]:/.test(ip)) return true;     // fe80::/10

    const dotted = ip.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (dotted) return isPrivateIPv4(dotted[1]);

    const hex = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
        const high = parseInt(hex[1], 16);
        const low = parseInt(hex[2], 16);
        return isPrivateIPv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
    }
    return false;
}

function isPrivateHost(hostname) {
    const host = String(hostname || '')
        .toLowerCase()
        .replace(/^\[|\]$/g, '')
        .replace(/\.$/, '');

    if (!host) return true;
    if (
        host === 'localhost' ||
        host.endsWith('.localhost') ||
        host.endsWith('.local') ||
        host.endsWith('.internal')
    ) {
        return true;
    }

    const family = net.isIP(host);
    if (family === 4) return isPrivateIPv4(host);
    if (family === 6) return isPrivateIPv6(host);
    return false;
}

function pageBaseName(index, total) {
    const width = Math.max(3, String(total).length);
    return String(index + 1).padStart(width, '0');
}

function mimeType(contentType) {
    return String(contentType || '').split(';')[0].trim().toLowerCase();
}

function extensionFor(contentType, url) {
    const fromMime = MIME_EXTENSIONS[mimeType(contentType)];
    if (fromMime) return fromMime;

    try {
        const match = new URL(url).pathname.toLowerCase().match(/\.[a-z0-9]{2,5}$/);
        if (match && KNOWN_EXTENSIONS.has(match[0])) {
            return match[0] === '.jpeg' ? '.jpg' : match[0];
        }
    } catch {
        // Fall through to the default extension.
    }
    return '.jpg';
}

function isAcceptedImageType(contentType) {
    const type = mimeType(contentType);
    if (!type) return true;
    if (type === 'image/svg+xml') return false; // SVG can carry scripts
    return type.startsWith('image/') || type.endsWith('/octet-stream');
}

function createAbortError() {
    const error = new Error('The operation was cancelled.');
    error.name = 'AbortError';
    return error;
}

module.exports = {
    USER_AGENT,
    sanitizeName,
    parseHttpUrl,
    isPrivateHost,
    pageBaseName,
    extensionFor,
    isAcceptedImageType,
    createAbortError
};