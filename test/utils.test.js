'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    sanitizeName, parseHttpUrl, isPrivateHost, pageBaseName, extensionFor, isAcceptedImageType
} = require('../src/lib/utils');

test('sanitizeName replaces characters that are invalid in file names', () => {
    assert.equal(sanitizeName('Chapter 1: The <Start>?'), 'Chapter 1_ The _Start__');
});

test('sanitizeName prevents path traversal', () => {
    for (const input of ['..', '.', '../..', '../../etc/passwd', '..\\..\\Windows']) {
        const name = sanitizeName(input, 'fallback');
        assert.ok(!name.includes('/') && !name.includes('\\'), name);
        assert.ok(!name.startsWith('.'), name);
    }
    assert.equal(sanitizeName('..', 'fallback'), 'fallback');
});

test('sanitizeName handles reserved names, whitespace and length', () => {
    assert.equal(sanitizeName('CON', 'fallback'), 'fallback');
    assert.equal(sanitizeName('nul.txt', 'fallback'), 'fallback');
    assert.equal(sanitizeName('Console'), 'Console');
    assert.equal(sanitizeName('  My   Manga  Ch. 5.  '), 'My Manga Ch. 5');
    assert.equal(sanitizeName('', 'fallback'), 'fallback');
    assert.equal(sanitizeName(null, 'fallback'), 'fallback');
    assert.ok(sanitizeName('a'.repeat(500)).length <= 120);
});

test('parseHttpUrl accepts only http and https', () => {
    assert.equal(parseHttpUrl('https://example.com/a').href, 'https://example.com/a');
    assert.equal(parseHttpUrl('  http://example.com  ').hostname, 'example.com');
    assert.equal(
        parseHttpUrl('/img/1.jpg', 'https://example.com/ch/1').href,
        'https://example.com/img/1.jpg'
    );

    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'data:image/png;base64,AA', 'not a url', '', null, 42]) {
        assert.equal(parseHttpUrl(bad), null, String(bad));
    }
});

test('isPrivateHost detects loopback, private and link-local hosts', () => {
    const blocked = [
        'localhost', 'LOCALHOST.', 'app.localhost', 'printer.local',
        '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1',
        '169.254.169.254', '0.0.0.0', '[::1]', '::1', 'fd00::1', 'fe80::1'
    ];
    for (const host of blocked) assert.equal(isPrivateHost(host), true, host);

    const allowed = ['example.com', '8.8.8.8', '172.32.0.1', '192.169.0.1', '2606:4700::1111', 'cdn.localhost-images.com'];
    for (const host of allowed) assert.equal(isPrivateHost(host), false, host);
});

test('isPrivateHost catches encoded IPv4 forms normalised by the URL parser', () => {
    assert.equal(isPrivateHost(new URL('http://2130706433/').hostname), true);
    assert.equal(isPrivateHost(new URL('http://0x7f.1/').hostname), true);
    assert.equal(isPrivateHost(new URL('http://[::ffff:127.0.0.1]/').hostname), true);
    assert.equal(isPrivateHost(new URL('http://[::ffff:192.168.0.1]/').hostname), true);
});

test('pageBaseName pads to at least three digits', () => {
    assert.equal(pageBaseName(0, 20), '001');
    assert.equal(pageBaseName(9, 999), '010');
    assert.equal(pageBaseName(1233, 1500), '1234');
});

test('extensionFor prefers the MIME type and falls back to the URL', () => {
    assert.equal(extensionFor('image/webp', 'https://x.test/a'), '.webp');
    assert.equal(extensionFor('image/jpeg; charset=binary', 'https://x.test/a.png'), '.jpg');
    assert.equal(extensionFor('application/octet-stream', 'https://x.test/p/01.PNG?v=2'), '.png');
    assert.equal(extensionFor('', 'https://x.test/p/01.jpeg'), '.jpg');
    assert.equal(extensionFor('application/octet-stream', 'https://x.test/p/page'), '.jpg');
    assert.equal(extensionFor('application/octet-stream', 'https://x.test/p/run.exe'), '.jpg');
});

test('isAcceptedImageType rejects HTML, JSON and SVG', () => {
    for (const type of ['image/jpeg', 'image/webp; q=1', 'application/octet-stream', '', undefined]) {
        assert.equal(isAcceptedImageType(type), true, String(type));
    }
    for (const type of ['text/html; charset=utf-8', 'application/json', 'image/svg+xml']) {
        assert.equal(isAcceptedImageType(type), false, type);
    }
});