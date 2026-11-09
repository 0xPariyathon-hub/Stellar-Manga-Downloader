'use strict';

const fs = require('fs');
const path = require('path');
const { fileURLToPath } = require('url');
const {
    app, BrowserWindow, Notification, dialog, ipcMain, session, shell
} = require('electron');

const { scrapeChapter } = require('./lib/scraper');
const { downloadChapter } = require('./lib/downloader');
const { createStore } = require('./lib/store');
const { parseHttpUrl, sanitizeName } = require('./lib/utils');

const APP_NAME = 'Stellar Manga Downloader';
const RENDERER_FILE = path.join(__dirname, 'renderer', 'index.html');
const FILTER_MODES = new Set(['smart', 'all']);
const MAX_PAGES = 2000;
const MAX_URL_LENGTH = 4096;

let mainWindow = null;
let store = null;
let saveDirectory = null;
let previewReferer = null;
let scrapeController = null;
let downloadController = null;

app.enableSandbox();

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 960,
        minHeight: 640,
        frame: false,
        show: false,
        title: APP_NAME,
        backgroundColor: '#0f1117',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            webSecurity: true,
            spellcheck: false,
            devTools: !app.isPackaged
        }
    });

    mainWindow.once('ready-to-show', () => mainWindow.show());

    mainWindow.on('closed', () => {
        mainWindow = null;
        scrapeController?.abort();
        downloadController?.abort();
    });

    mainWindow.loadFile(RENDERER_FILE);
}

function send(channel, payload) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(channel, payload);
    }
}

function notifyIfUnfocused(result) {
    if (!Notification.isSupported() || mainWindow?.isFocused()) return;

    const saved = result.completed + result.skipped;
    let body = `${saved} of ${result.total} pages saved.`;
    if (result.cancelled) body = 'Download cancelled.';
    else if (result.failed.length) body = `${saved} of ${result.total} pages saved, ${result.failed.length} failed.`;

    new Notification({ title: APP_NAME, body }).show();
}

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

function isTrustedSender(event) {
    const url = event.senderFrame?.url;
    if (!url || !url.startsWith('file:')) return false;

    try {
        const senderPath = path.normalize(fileURLToPath(url));
        return process.platform === 'win32'
            ? senderPath.toLowerCase() === RENDERER_FILE.toLowerCase()
            : senderPath === RENDERER_FILE;
    } catch {
        return false;
    }
}

function handle(channel, listener) {
    ipcMain.handle(channel, (event, ...args) => {
        if (!isTrustedSender(event)) throw new Error('Unauthorized IPC sender.');
        return listener(event, ...args);
    });
}

function on(channel, listener) {
    ipcMain.on(channel, (event, ...args) => {
        if (isTrustedSender(event)) listener(event, ...args);
    });
}

function hardenSession(ses) {
    ses.setPermissionRequestHandler((webContents, permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);

    // Preview images are requested with the chapter URL as Referer so that
    // hotlink-protected hosts still serve them.
    ses.webRequest.onBeforeSendHeaders(
        { urls: ['http://*/*', 'https://*/*'] },
        (details, callback) => {
            if (previewReferer && details.resourceType === 'image') {
                details.requestHeaders.Referer = previewReferer;
            }
            callback({ requestHeaders: details.requestHeaders });
        }
    );
}

app.on('web-contents-created', (event, contents) => {
    contents.on('will-navigate', navigationEvent => navigationEvent.preventDefault());
    contents.on('will-attach-webview', attachEvent => attachEvent.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

function restoreSaveDirectory() {
    const stored = store.getSettings().saveDirectory;
    try {
        if (typeof stored === 'string' && path.isAbsolute(stored) && fs.statSync(stored).isDirectory()) {
            return stored;
        }
    } catch {
        // Directory was removed since the last session.
    }
    return null;
}

function bootstrap() {
    if (process.platform === 'win32') {
        app.setAppUserModelId('com.stellar.mangadownloader');
    }

    store = createStore(app.getPath('userData'));
    saveDirectory = restoreSaveDirectory();
    hardenSession(session.defaultSession);
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
}

if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (!mainWindow) return;
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
    });

    app.whenReady().then(bootstrap);
}

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

// ---------------------------------------------------------------------------
// IPC: window
// ---------------------------------------------------------------------------

on('window:minimize', () => mainWindow?.minimize());
on('window:close', () => mainWindow?.close());
on('window:toggle-maximize', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
});

// ---------------------------------------------------------------------------
// IPC: app state and settings
// ---------------------------------------------------------------------------

handle('app:get-state', () => {
    const settings = store.getSettings();
    return {
        version: app.getVersion(),
        saveDirectory,
        filterMode: FILTER_MODES.has(settings.filterMode) ? settings.filterMode : 'smart',
        skipExisting: settings.skipExisting !== false
    };
});

handle('settings:update', (event, patch) => {
    const next = {};
    if (FILTER_MODES.has(patch?.filterMode)) next.filterMode = patch.filterMode;
    if (typeof patch?.skipExisting === 'boolean') next.skipExisting = patch.skipExisting;
    if (Object.keys(next).length) store.updateSettings(next);
    return true;
});

handle('dialog:select-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Choose download location',
        defaultPath: saveDirectory || app.getPath('downloads'),
        properties: ['openDirectory', 'createDirectory']
    });

    if (result.canceled || result.filePaths.length === 0) return null;

    saveDirectory = result.filePaths[0];
    store.updateSettings({ saveDirectory });
    return saveDirectory;
});

// ---------------------------------------------------------------------------
// IPC: scraping
// ---------------------------------------------------------------------------

handle('scrape:start', async (event, payload) => {
    if (scrapeController) return { ok: false, error: 'A scan is already running.' };

    const url = parseHttpUrl(payload?.url);
    if (!url) return { ok: false, error: 'Enter a valid http(s) URL.' };

    const mode = FILTER_MODES.has(payload?.mode) ? payload.mode : 'smart';
    scrapeController = new AbortController();

    try {
        const result = await scrapeChapter(url.href, { mode, signal: scrapeController.signal });
        if (result.images.length === 0) {
            return { ok: false, error: 'No images were found on this page.' };
        }
        previewReferer = url.href;
        return { ok: true, url: url.href, title: result.title, images: result.images };
    } catch (error) {
        if (error.name === 'AbortError') return { ok: false, cancelled: true };
        return { ok: false, error: error.message };
    } finally {
        scrapeController = null;
    }
});

on('scrape:cancel', () => scrapeController?.abort());

// ---------------------------------------------------------------------------
// IPC: downloading
// ---------------------------------------------------------------------------

handle('download:start', async (event, payload) => {
    if (downloadController) return { ok: false, error: 'A download is already running.' };
    if (!saveDirectory) return { ok: false, error: 'Choose a download location first.' };

    const images = Array.isArray(payload?.images)
        ? payload.images
            .filter(value => typeof value === 'string' && value.length <= MAX_URL_LENGTH)
            .slice(0, MAX_PAGES)
        : [];
    if (images.length === 0) return { ok: false, error: 'Select at least one page.' };

    // The renderer never supplies a full path: the base directory is owned by
    // the main process and only the sanitized folder name is appended.
    const folderName = sanitizeName(payload?.folderName, 'Untitled Chapter');
    const directory = path.join(saveDirectory, folderName);
    const relative = path.relative(saveDirectory, directory);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        return { ok: false, error: 'Invalid folder name.' };
    }

    const referer = parseHttpUrl(payload?.referer)?.href || null;
    downloadController = new AbortController();

    try {
        const result = await downloadChapter({
            images,
            directory,
            referer,
            skipExisting: payload?.skipExisting !== false,
            signal: downloadController.signal,
            onProgress: progress => send('download:progress', progress)
        });

        const entry = store.addHistory({
            folder: folderName,
            directory,
            source: referer,
            total: result.total,
            completed: result.completed,
            skipped: result.skipped,
            failed: result.failed.length,
            cancelled: result.cancelled
        });

        notifyIfUnfocused(result);
        return { ok: true, historyId: entry.id, directory, ...result };
    } catch (error) {
        return { ok: false, error: error.message };
    } finally {
        downloadController = null;
    }
});

on('download:cancel', () => downloadController?.abort());

// ---------------------------------------------------------------------------
// IPC: history
// ---------------------------------------------------------------------------

handle('history:list', () => store.getHistory().slice().reverse());

handle('history:clear', () => {
    store.clearHistory();
    return true;
});

handle('history:open', async (event, id) => {
    const entry = typeof id === 'string' ? store.findHistory(id) : null;
    if (!entry || typeof entry.directory !== 'string') {
        return { ok: false, error: 'This entry is no longer available.' };
    }

    try {
        if (!fs.statSync(entry.directory).isDirectory()) throw new Error('Not a directory');
    } catch {
        return { ok: false, error: 'The folder no longer exists.' };
    }

    const error = await shell.openPath(entry.directory);
    return error ? { ok: false, error } : { ok: true };
});