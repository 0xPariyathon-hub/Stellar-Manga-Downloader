'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { filterImages } = require('../src/lib/scraper');

const page = new URL('https://manga.example/series/ch-1');

test('filterImages resolves relative URLs and removes duplicates', () => {
    const result = filterImages([
        { src: '/img/001.jpg', width: 800, height: 1200 },
        { src: 'https://manga.example/img/001.jpg', width: 800, height: 1200 },
        { src: 'img/002.jpg', width: 0, height: 0 }
    ], page, true);

    assert.deepEqual(result, [
        'https://manga.example/img/001.jpg',
        'https://manga.example/series/img/002.jpg'
    ]);
});

test('smart mode drops small images, GIF, SVG and site chrome', () => {
    const result = filterImages([
        { src: '/assets/site-logo.png', width: 800, height: 400 },
        { src: '/assets/icon_user.png', width: 800, height: 800 },
        { src: '/ads/spinner.gif', width: 800, height: 800 },
        { src: '/thumb/x.jpg', width: 120, height: 160 },
        { src: '/img/vector.svg', width: 800, height: 800 },
        { src: '/manga/iconic-hero/005.jpg', width: 900, height: 1300 }
    ], page, true);

    assert.deepEqual(result, ['https://manga.example/manga/iconic-hero/005.jpg']);
});

test('all mode keeps every image but still drops unsafe URLs', () => {
    const result = filterImages([
        { src: '/assets/logo.png', width: 50, height: 50 },
        { src: 'javascript:alert(1)', width: 0, height: 0 },
        { src: null, width: 0, height: 0 },
        { src: 'http://192.168.1.1/admin.png', width: 800, height: 800 }
    ], page, false);

    assert.deepEqual(result, ['https://manga.example/assets/logo.png']);
});

test('private image hosts are allowed when the chapter itself is local', () => {
    const local = new URL('http://localhost:8080/ch/1');
    assert.deepEqual(
        filterImages([{ src: '/1.jpg', width: 800, height: 1000 }], local, true),
        ['http://localhost:8080/1.jpg']
    );
});