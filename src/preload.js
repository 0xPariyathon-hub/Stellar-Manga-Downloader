'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
    const listener = (event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('stellar', {
    window: {
        minimize: () => ipcRenderer.send('window:minimize'),
        toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
        close: () => ipcRenderer.send('window:close')
    },
    app: {
        getState: () => ipcRenderer.invoke('app:get-state'),
        updateSettings: patch => ipcRenderer.invoke('settings:update', patch),
        selectFolder: () => ipcRenderer.invoke('dialog:select-folder')
    },
    scraper: {
        start: (url, mode) => ipcRenderer.invoke('scrape:start', { url, mode }),
        cancel: () => ipcRenderer.send('scrape:cancel')
    },
    downloader: {
        start: options => ipcRenderer.invoke('download:start', options),
        cancel: () => ipcRenderer.send('download:cancel'),
        onProgress: callback => subscribe('download:progress', callback)
    },
    history: {
        list: () => ipcRenderer.invoke('history:list'),
        clear: () => ipcRenderer.invoke('history:clear'),
        open: id => ipcRenderer.invoke('history:open', id)
    }
});