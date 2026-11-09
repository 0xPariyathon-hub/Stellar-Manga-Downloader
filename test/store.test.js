'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createStore, HISTORY_LIMIT } = require('../src/lib/store');

describe('store', () => {
    let root;

    before(async () => {
        root = await fsp.mkdtemp(path.join(os.tmpdir(), 'stellar-store-'));
    });

    after(async () => {
        await fsp.rm(root, { recursive: true, force: true });
    });

    it('recovers from a corrupted history file', async () => {
        const dir = path.join(root, 'corrupt');
        await fsp.mkdir(dir, { recursive: true });
        await fsp.writeFile(path.join(dir, 'history.json'), '{not json');

        const store = createStore(dir);
        assert.deepEqual(store.getHistory(), []);

        const entry = store.addHistory({ folder: 'A' });
        assert.ok(entry.id);
        assert.ok(entry.createdAt);
        assert.equal(store.getHistory().length, 1);
    });

    it('caps history at the configured limit', () => {
        const store = createStore(path.join(root, 'cap'));
        for (let i = 0; i < HISTORY_LIMIT + 5; i++) store.addHistory({ folder: `F${i}` });

        const history = store.getHistory();
        assert.equal(history.length, HISTORY_LIMIT);
        assert.equal(history[0].folder, 'F5');
        assert.equal(history.at(-1).folder, `F${HISTORY_LIMIT + 4}`);
    });

    it('finds and clears entries', () => {
        const store = createStore(path.join(root, 'find'));
        const entry = store.addHistory({ folder: 'B' });

        assert.equal(store.findHistory(entry.id).folder, 'B');
        assert.equal(store.findHistory('missing'), null);

        store.clearHistory();
        assert.deepEqual(store.getHistory(), []);
    });

    it('merges settings updates', () => {
        const store = createStore(path.join(root, 'settings'));
        store.updateSettings({ filterMode: 'all' });
        store.updateSettings({ skipExisting: false });
        assert.deepEqual(store.getSettings(), { filterMode: 'all', skipExisting: false });
    });
});