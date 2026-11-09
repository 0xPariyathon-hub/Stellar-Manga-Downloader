'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const HISTORY_LIMIT = 500;

function readJson(file, fallback) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return fallback;
    }
}

function writeJsonAtomic(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(temp, file);
}

function createStore(directory) {
    const historyFile = path.join(directory, 'history.json');
    const settingsFile = path.join(directory, 'settings.json');

    const getSettings = () => {
        const value = readJson(settingsFile, {});
        return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    };

    const getHistory = () => {
        const value = readJson(historyFile, []);
        return Array.isArray(value) ? value : [];
    };

    return {
        getSettings,

        updateSettings(patch) {
            const next = { ...getSettings(), ...patch };
            writeJsonAtomic(settingsFile, next);
            return next;
        },

        getHistory,

        addHistory(entry) {
            const record = {
                id: crypto.randomUUID(),
                createdAt: new Date().toISOString(),
                ...entry
            };
            writeJsonAtomic(historyFile, [...getHistory(), record].slice(-HISTORY_LIMIT));
            return record;
        },

        findHistory(id) {
            return getHistory().find(entry => entry.id === id) || null;
        },

        clearHistory() {
            fs.rmSync(historyFile, { force: true });
        }
    };
}

module.exports = { createStore, HISTORY_LIMIT };