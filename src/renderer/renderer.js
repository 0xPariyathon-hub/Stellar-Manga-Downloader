'use strict';

(() => {
    const api = window.stellar;
    const $ = id => document.getElementById(id);

    const DEFAULT_EMPTY_MESSAGE = 'Paste a chapter URL and press Scan to load pages.';
    const FALLBACK_IMAGE = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="150" height="200">' +
        '<rect width="100%" height="100%" fill="#1d212c"/>' +
        '<text x="50%" y="50%" fill="#8a92a6" font-family="sans-serif" font-size="12" ' +
        'text-anchor="middle" dominant-baseline="middle">Preview unavailable</text></svg>'
    );

    const state = {
        pages: [],
        sourceUrl: '',
        saveDirectory: null,
        scanning: false,
        downloading: false
    };

    let lastClickedIndex = null;
    let resolveModal = null;

    // -------------------------------------------------------------------------
    // Status and modal
    // -------------------------------------------------------------------------

    function setStatus(text, tone = 'idle') {
        $('statusText').textContent = text;
        $('statusDot').className = tone === 'idle' ? 'status-dot' : `status-dot ${tone}`;
    }

    function showModal(title, message, buttons = [{ label: 'OK', value: true, variant: 'primary' }]) {
        if (resolveModal) closeModal(undefined);

        $('modalTitle').textContent = title;
        $('modalMessage').textContent = message;

        const elements = buttons.map(button => {
            const element = document.createElement('button');
            element.className = `btn btn-${button.variant || 'ghost'}`;
            element.textContent = button.label;
            element.addEventListener('click', () => closeModal(button.value));
            return element;
        });
        $('modalActions').replaceChildren(...elements);
        $('modal').classList.remove('hidden');

        const primaryIndex = buttons.findIndex(button => button.variant === 'primary');
        (elements[primaryIndex] || elements[0]).focus();

        return new Promise(resolve => { resolveModal = resolve; });
    }

    function closeModal(value) {
        $('modal').classList.add('hidden');
        const resolve = resolveModal;
        resolveModal = null;
        resolve?.(value);
    }

    const alertBox = (title, message) => showModal(title, message);

    const confirmBox = (title, message, confirmLabel, variant = 'primary') => showModal(title, message, [
        { label: 'Cancel', value: false },
        { label: confirmLabel, value: true, variant }
    ]);

    // -------------------------------------------------------------------------
    // Navigation
    // -------------------------------------------------------------------------

    function showView(name) {
        document.querySelectorAll('.nav-item').forEach(item => {
            item.classList.toggle('active', item.dataset.view === name);
        });
        document.querySelectorAll('.view').forEach(view => {
            view.classList.toggle('active', view.id === `view-${name}`);
        });
        if (name === 'history') renderHistory();
    }

    // -------------------------------------------------------------------------
    // Page grid
    // -------------------------------------------------------------------------

    function renderGrid(emptyMessage) {
        const grid = $('grid');
        lastClickedIndex = null;

        if (state.pages.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'empty';
            empty.textContent = emptyMessage || DEFAULT_EMPTY_MESSAGE;
            grid.replaceChildren(empty);
        } else {
            const fragment = document.createDocumentFragment();
            state.pages.forEach((page, index) => fragment.appendChild(createCard(page, index)));
            grid.replaceChildren(fragment);
        }

        updateControls();
    }

    function createCard(page, index) {
        const card = document.createElement('div');
        card.className = page.selected ? 'card selected' : 'card';
        card.title = page.url;

        const img = document.createElement('img');
        img.loading = 'lazy';
        img.decoding = 'async';
        img.alt = `Page ${index + 1}`;
        img.addEventListener('error', () => { img.src = FALLBACK_IMAGE; }, { once: true });
        img.src = page.url;

        const label = document.createElement('div');
        label.className = 'card-label';

        const text = document.createElement('span');
        text.textContent = `Page ${index + 1}`;

        const check = document.createElement('input');
        check.type = 'checkbox';
        check.className = 'card-check';
        check.tabIndex = -1;
        check.checked = page.selected;

        label.append(text, check);
        card.append(img, label);

        card.addEventListener('click', event => {
            if (state.downloading) return;

            const value = !page.selected;
            if (event.shiftKey && lastClickedIndex !== null) {
                const start = Math.min(lastClickedIndex, index);
                const end = Math.max(lastClickedIndex, index);
                for (let i = start; i <= end; i++) state.pages[i].selected = value;
            } else {
                page.selected = value;
            }

            lastClickedIndex = index;
            syncSelection();
        });

        return card;
    }

    function syncSelection() {
        $('grid').querySelectorAll('.card').forEach((card, index) => {
            const selected = state.pages[index].selected;
            card.classList.toggle('selected', selected);
            card.querySelector('.card-check').checked = selected;
        });
        updateControls();
    }

    function updateControls() {
        const total = state.pages.length;
        const selected = state.pages.filter(page => page.selected).length;
        const busy = state.scanning || state.downloading;

        $('selectionInfo').textContent = total ? `${selected} of ${total} pages selected` : 'No pages loaded';

        $('btnToggleAll').textContent = total > 0 && selected === total ? 'Select none' : 'Select all';
        $('btnToggleAll').disabled = total === 0 || busy;
        $('btnRemove').disabled = selected === 0 || busy;

        const scan = $('btnScan');
        scan.textContent = state.scanning ? 'Stop' : 'Scan';
        scan.disabled = state.downloading;
        scan.classList.toggle('btn-danger', state.scanning);
        scan.classList.toggle('btn-primary', !state.scanning);

        const download = $('btnDownload');
        download.textContent = state.downloading ? 'Cancel' : 'Download';
        download.disabled = !state.downloading && (selected === 0 || state.scanning);
        download.classList.toggle('btn-danger', state.downloading);
        download.classList.toggle('btn-success', !state.downloading);

        $('urlInput').disabled = busy;
        $('modeSelect').disabled = busy;
        $('btnLocation').disabled = state.downloading;
        $('folderInput').disabled = state.downloading;
        $('skipExisting').disabled = state.downloading;
    }

    function toggleAll() {
        const selectAll = !state.pages.every(page => page.selected);
        state.pages.forEach(page => { page.selected = selectAll; });
        syncSelection();
    }

    async function removeSelected() {
        const count = state.pages.filter(page => page.selected).length;
        if (count === 0) return;

        const message = count === state.pages.length
            ? `Remove all ${count} pages from the list?`
            : `Remove ${count} selected page${count === 1 ? '' : 's'} from the list?`;

        if (!await confirmBox('Remove pages', message, 'Remove', 'danger')) return;

        state.pages = state.pages.filter(page => !page.selected);
        renderGrid();
    }

    // -------------------------------------------------------------------------
    // Scanning
    // -------------------------------------------------------------------------

    function suggestFolderName(title) {
        return title
            .split(/\s+[|\u2013\u2014-]\s+/)[0]
            .replace(/[<>:"/\\|?*]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 100);
    }

    async function scan() {
        if (state.scanning) {
            api.scraper.cancel();
            setStatus('Stopping scan...', 'busy');
            return;
        }

        const url = $('urlInput').value.trim();
        if (!/^https?:\/\//i.test(url)) {
            await alertBox('Invalid URL', 'Enter a full chapter URL starting with http:// or https://.');
            $('urlInput').focus();
            return;
        }

        state.scanning = true;
        state.pages = [];
        hideProgress();
        renderGrid('Loading the page and collecting images. Long chapters can take up to a minute.');
        setStatus('Scanning page...', 'busy');

        let result;
        try {
            result = await api.scraper.start(url, $('modeSelect').value);
        } catch (error) {
            result = { ok: false, error: error.message };
        } finally {
            state.scanning = false;
        }

        if (result.ok) {
            state.sourceUrl = result.url;
            state.pages = result.images.map(src => ({ url: src, selected: true }));
            const suggested = result.title ? suggestFolderName(result.title) : '';
            if (suggested) $('folderInput').value = suggested;
            setStatus(`Found ${result.images.length} pages`);
            renderGrid();
        } else if (result.cancelled) {
            setStatus('Scan stopped');
            renderGrid();
        } else {
            setStatus('Scan failed', 'error');
            renderGrid();
            alertBox('Scan failed', result.error);
        }
    }

    // -------------------------------------------------------------------------
    // Downloading
    // -------------------------------------------------------------------------

    function setLocation(directory) {
        state.saveDirectory = directory || null;
        $('locationLabel').textContent = directory || 'No location selected';
        $('locationLabel').title = directory || '';
    }

    async function chooseLocation() {
        const directory = await api.app.selectFolder();
        if (directory) setLocation(directory);
    }

    function hideProgress() {
        $('progress').classList.add('hidden');
    }

    function updateProgress(progress) {
        const percent = progress.total ? Math.round((progress.processed / progress.total) * 100) : 0;
        $('progressFill').style.width = `${percent}%`;

        const parts = [`${progress.processed} / ${progress.total}`, `${percent}%`];
        if (progress.skipped) parts.push(`${progress.skipped} skipped`);
        if (progress.failed) parts.push(`${progress.failed} failed`);
        $('progressLabel').textContent = parts.join('  \u00b7  ');
    }

    async function download() {
        if (state.downloading) {
            api.downloader.cancel();
            $('btnDownload').disabled = true;
            setStatus('Cancelling...', 'busy');
            return;
        }

        if (!state.saveDirectory) {
            await chooseLocation();
            if (!state.saveDirectory) return;
        }

        const folderName = $('folderInput').value.trim();
        if (!folderName) {
            await alertBox('Folder name required', 'Enter a name for the chapter folder.');
            $('folderInput').focus();
            return;
        }

        const images = state.pages.filter(page => page.selected).map(page => page.url);
        if (images.length === 0) return;

        state.downloading = true;
        updateControls();
        $('progress').classList.remove('hidden');
        updateProgress({ processed: 0, total: images.length, skipped: 0, failed: 0 });
        setStatus('Downloading...', 'busy');

        let result;
        try {
            result = await api.downloader.start({
                images,
                folderName,
                referer: state.sourceUrl,
                skipExisting: $('skipExisting').checked
            });
        } catch (error) {
            result = { ok: false, error: error.message };
        } finally {
            state.downloading = false;
            updateControls();
        }

        if (!result.ok) {
            setStatus('Download failed', 'error');
            alertBox('Download failed', result.error);
            return;
        }

        await reportDownload(result);
    }

    async function reportDownload(result) {
        const saved = result.completed + result.skipped;
        const lines = [`${saved} of ${result.total} pages saved to:`, result.directory];

        if (result.skipped) {
            lines.push('', `${result.skipped} existing page${result.skipped === 1 ? '' : 's'} skipped.`);
        }

        if (result.failed.length) {
            const pages = result.failed.map(item => item.page);
            const listed = pages.slice(0, 30).join(', ') + (pages.length > 30 ? ', ...' : '');
            const reasons = [...new Set(result.failed.map(item => item.reason))].slice(0, 3);
            lines.push('', `Failed pages: ${listed}`, `Reason: ${reasons.join('; ')}`);
        }

        let title = 'Download complete';
        if (result.cancelled) {
            title = 'Download cancelled';
            setStatus('Download cancelled');
        } else if (result.failed.length) {
            title = 'Download finished with errors';
            setStatus(`Finished with ${result.failed.length} failed`, 'error');
        } else {
            setStatus('Download complete');
        }

        const action = await showModal(title, lines.join('\n'), [
            { label: 'Close', value: 'close' },
            { label: 'Open folder', value: 'open', variant: 'primary' }
        ]);

        if (action === 'open') openHistoryEntry(result.historyId);
    }

    // -------------------------------------------------------------------------
    // History
    // -------------------------------------------------------------------------

    function formatDate(entry) {
        if (entry.createdAt) {
            const date = new Date(entry.createdAt);
            if (!Number.isNaN(date.getTime())) return date.toLocaleString();
        }
        return entry.time || '-';
    }

    function createHistoryRow(entry) {
        const row = document.createElement('tr');
        const saved = (entry.completed ?? entry.count ?? 0) + (entry.skipped ?? 0);
        const failed = typeof entry.failed === 'number' ? entry.failed : 0;
        const pages = `${saved} / ${entry.total ?? saved}` + (entry.cancelled ? ' (cancelled)' : '');

        const cells = [
            [formatDate(entry)],
            [entry.folder || '-'],
            [pages],
            [failed ? String(failed) : '-', failed ? 'warn' : ''],
            [entry.directory || entry.path || '-', 'path']
        ];

        for (const [text, className] of cells) {
            const cell = document.createElement('td');
            cell.textContent = text;
            if (className) cell.className = className;
            row.appendChild(cell);
        }

        const actionCell = document.createElement('td');
        const openButton = document.createElement('button');
        openButton.className = 'btn btn-ghost btn-sm';
        openButton.textContent = 'Open';
        openButton.disabled = !entry.id;
        openButton.addEventListener('click', () => openHistoryEntry(entry.id));
        actionCell.appendChild(openButton);
        row.appendChild(actionCell);

        return row;
    }

    async function renderHistory() {
        const entries = await api.history.list();
        const body = $('historyBody');
        $('btnClearHistory').disabled = entries.length === 0;

        if (entries.length === 0) {
            const row = document.createElement('tr');
            const cell = document.createElement('td');
            cell.colSpan = 6;
            cell.className = 'empty-row';
            cell.textContent = 'No downloads yet.';
            row.appendChild(cell);
            body.replaceChildren(row);
            return;
        }

        body.replaceChildren(...entries.map(createHistoryRow));
    }

    async function openHistoryEntry(id) {
        const result = await api.history.open(id);
        if (!result.ok) alertBox('Cannot open folder', result.error);
    }

    async function clearHistory() {
        const confirmed = await confirmBox(
            'Clear history',
            'Remove all download history? Downloaded files are not affected.',
            'Clear',
            'danger'
        );
        if (!confirmed) return;

        await api.history.clear();
        renderHistory();
    }

    // -------------------------------------------------------------------------
    // Startup
    // -------------------------------------------------------------------------

    function bindEvents() {
        $('btnMinimize').addEventListener('click', () => api.window.minimize());
        $('btnMaximize').addEventListener('click', () => api.window.toggleMaximize());
        $('btnClose').addEventListener('click', () => api.window.close());

        document.querySelectorAll('.nav-item').forEach(item => {
            item.addEventListener('click', () => showView(item.dataset.view));
        });

        $('btnScan').addEventListener('click', scan);
        $('urlInput').addEventListener('keydown', event => {
            if (event.key === 'Enter') scan();
        });

        $('btnLocation').addEventListener('click', chooseLocation);
        $('btnToggleAll').addEventListener('click', toggleAll);
        $('btnRemove').addEventListener('click', removeSelected);
        $('btnDownload').addEventListener('click', download);
        $('btnClearHistory').addEventListener('click', clearHistory);

        $('modeSelect').addEventListener('change', event => {
            api.app.updateSettings({ filterMode: event.target.value });
        });
        $('skipExisting').addEventListener('change', event => {
            api.app.updateSettings({ skipExisting: event.target.checked });
        });

        $('modal').addEventListener('click', event => {
            if (event.target === $('modal')) closeModal(false);
        });
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape' && !$('modal').classList.contains('hidden')) closeModal(false);
        });

        api.downloader.onProgress(updateProgress);
    }

    async function init() {
        bindEvents();

        const appState = await api.app.getState();
        $('appVersion').textContent = `Version ${appState.version}`;
        $('modeSelect').value = appState.filterMode;
        $('skipExisting').checked = appState.skipExisting;
        setLocation(appState.saveDirectory);

        renderGrid();
        $('urlInput').focus();
    }

    init();
})();