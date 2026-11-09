'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { downloadChapter } = require('../src/lib/downloader');

const IMAGE = Buffer.alloc(4096, 7);

function sendImage(res, type = 'image/jpeg') {
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': IMAGE.length });
    res.end(IMAGE);
}

async function startServer() {
    const hits = new Map();
    const referers = new Map();

    const server = http.createServer((req, res) => {
        const { pathname } = new URL(req.url, 'http://127.0.0.1');
        const hit = (hits.get(pathname) || 0) + 1;
        hits.set(pathname, hit);
        referers.set(pathname, req.headers.referer);

        if (pathname.startsWith('/img/')) {
            return sendImage(res, pathname.endsWith('.webp') ? 'image/webp' : 'image/jpeg');
        }
        if (pathname === '/noext') return sendImage(res, 'image/png');
        if (pathname === '/flaky.jpg') {
            if (hit < 3) {
                res.writeHead(500);
                return res.end();
            }
            return sendImage(res);
        }
        if (pathname === '/html.jpg') {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            return res.end('<html></html>');
        }
        if (pathname === '/huge.jpg') {
            res.writeHead(200, { 'Content-Type': 'image/jpeg' });
            res.write(IMAGE);
            res.write(IMAGE);
            return res.end(IMAGE);
        }
        if (pathname === '/redirect.jpg') {
            res.writeHead(302, { Location: '/img/redirected.jpg' });
            return res.end();
        }
        if (pathname === '/slow.jpg') {
            const timer = setTimeout(() => sendImage(res), 5000);
            res.on('close', () => clearTimeout(timer));
            return undefined;
        }

        res.writeHead(404);
        return res.end();
    });

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

    return {
        base: `http://127.0.0.1:${server.address().port}`,
        hits,
        referers,
        close: () => new Promise(resolve => {
            server.closeAllConnections?.();
            server.close(resolve);
        })
    };
}

describe('downloadChapter', () => {
    let server;
    let root;

    before(async () => {
        server = await startServer();
        root = await fsp.mkdtemp(path.join(os.tmpdir(), 'stellar-test-'));
    });

    after(async () => {
        await server.close();
        await fsp.rm(root, { recursive: true, force: true });
    });

    const dirFor = name => path.join(root, name);

    const run = (name, images, extra = {}) => downloadChapter({
        images,
        directory: dirFor(name),
        referer: `${server.base}/chapter/1`,
        retryDelay: 10,
        ...extra
    });

    it('saves pages in order with numbered names and correct extensions', async () => {
        const { base } = server;
        const result = await run('basic', [`${base}/img/a.jpg`, `${base}/img/b.webp`, `${base}/noext`]);

        assert.equal(result.completed, 3);
        assert.deepEqual(result.failed, []);
        assert.deepEqual((await fsp.readdir(dirFor('basic'))).sort(), ['001.jpg', '002.webp', '003.png']);

        const content = await fsp.readFile(path.join(dirFor('basic'), '001.jpg'));
        assert.ok(content.equals(IMAGE));
    });

    it('sends the chapter URL as Referer', async () => {
        await run('referer', [`${server.base}/img/ref.jpg`]);
        assert.equal(server.referers.get('/img/ref.jpg'), `${server.base}/chapter/1`);
    });

    it('retries server errors', async () => {
        const result = await run('retry', [`${server.base}/flaky.jpg`]);
        assert.equal(result.completed, 1);
        assert.equal(server.hits.get('/flaky.jpg'), 3);
    });

    it('does not retry client errors and reports the failed page', async () => {
        const { base } = server;
        const result = await run('missing', [`${base}/img/ok.jpg`, `${base}/missing.jpg`]);

        assert.equal(result.completed, 1);
        assert.deepEqual(result.failed.map(item => item.page), [2]);
        assert.match(result.failed[0].reason, /404/);
        assert.equal(server.hits.get('/missing.jpg'), 1);
        assert.deepEqual(await fsp.readdir(dirFor('missing')), ['001.jpg']);
    });

    it('rejects responses that are not images', async () => {
        const result = await run('html', [`${server.base}/html.jpg`]);
        assert.equal(result.completed, 0);
        assert.match(result.failed[0].reason, /content type/i);
        assert.deepEqual(await fsp.readdir(dirFor('html')), []);
    });

    it('enforces the size limit while streaming', async () => {
        const result = await run('huge', [`${server.base}/huge.jpg`], { maxBytes: IMAGE.length * 2 });
        assert.equal(result.completed, 0);
        assert.match(result.failed[0].reason, /larger than/);
        assert.deepEqual(await fsp.readdir(dirFor('huge')), []);
    });

    it('follows redirects', async () => {
        const result = await run('redirect', [`${server.base}/redirect.jpg`]);
        assert.equal(result.completed, 1);
        assert.equal(server.hits.get('/img/redirected.jpg'), 1);
    });

    it('skips pages that already exist', async () => {
        const { base } = server;
        const dir = dirFor('resume');
        await fsp.mkdir(dir, { recursive: true });
        await fsp.writeFile(path.join(dir, '001.jpg'), IMAGE);

        const result = await run('resume', [`${base}/img/r1.jpg`, `${base}/img/r2.jpg`]);
        assert.equal(result.skipped, 1);
        assert.equal(result.completed, 1);
        assert.equal(server.hits.get('/img/r1.jpg'), undefined);

        const forced = await run('resume', [`${base}/img/r1.jpg`, `${base}/img/r2.jpg`], { skipExisting: false });
        assert.equal(forced.completed, 2);
    });

    it('blocks private hosts when the chapter page is public', async () => {
        const result = await downloadChapter({
            images: [`${server.base}/img/private.jpg`],
            directory: dirFor('private'),
            referer: 'https://manga.example/ch/1',
            retryDelay: 10
        });

        assert.equal(result.completed, 0);
        assert.match(result.failed[0].reason, /private/i);
        assert.equal(server.hits.get('/img/private.jpg'), undefined);
    });

    it('cancels in-flight downloads and leaves no partial files', async () => {
        const controller = new AbortController();
        const pending = run('cancel', [`${server.base}/slow.jpg`, `${server.base}/img/c2.jpg`], {
            signal: controller.signal,
            concurrency: 1
        });
        setTimeout(() => controller.abort(), 100);

        const result = await pending;
        assert.equal(result.cancelled, true);
        assert.equal(result.completed, 0);
        assert.equal(server.hits.get('/img/c2.jpg'), undefined);
        assert.deepEqual(await fsp.readdir(dirFor('cancel')), []);
    });

    it('rejects an empty image list', async () => {
        await assert.rejects(downloadChapter({ images: [], directory: dirFor('empty') }), /No images/);
    });
});