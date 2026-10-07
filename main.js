const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const cheerio = require('cheerio');
let mainWindow;

// ============================================================
// CREATE WINDOW
// ============================================================

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1150,
        height: 780,
        minWidth: 900,
        minHeight: 600,

        frame: false,

        backgroundColor: '#0f111a',

        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    mainWindow.loadFile(
        path.join(__dirname, 'index.html')
    );

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

// ============================================================
// APP
// ============================================================

app.whenReady().then(() => {
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

// ============================================================
// WINDOW CONTROL
// ============================================================

ipcMain.on('window-close', () => {
    if (mainWindow) {
        mainWindow.close();
    }
});

ipcMain.on('window-minimize', () => {
    if (mainWindow) {
        mainWindow.minimize();
    }
});

ipcMain.on('window-maximize', () => {
    if (!mainWindow) return;

    if (mainWindow.isMaximized()) {
        mainWindow.unmaximize();
    } else {
        mainWindow.maximize();
    }
});

// ============================================================
// SELECT FOLDER
// ============================================================

ipcMain.handle('dialog-select-folder', async () => {
    try {
        if (!mainWindow) {
            return null;
        }

        const result = await dialog.showOpenDialog(
            mainWindow,
            {
                title: 'เลือกโฟลเดอร์สำหรับบันทึก',
                properties: [
                    'openDirectory',
                    'createDirectory'
                ]
            }
        );

        if (
            result.canceled ||
            result.filePaths.length === 0
        ) {
            return null;
        }

        return result.filePaths[0];

    } catch (error) {
        console.error(
            'dialog-select-folder:',
            error
        );

        return null;
    }
});

// ============================================================
// FETCH MANGA
// ============================================================

ipcMain.handle('fetch-manga', async (event, url) => {
    let browser = null;

    try {
        if (!url || typeof url !== 'string') {
            throw new Error('กรุณาระบุ URL');
        }

        url = url.trim();

        let parsedUrl;

        try {
            parsedUrl = new URL(url);
        } catch {
            throw new Error('URL ไม่ถูกต้อง');
        }

        if (
            parsedUrl.protocol !== 'http:' &&
            parsedUrl.protocol !== 'https:'
        ) {
            throw new Error('รองรับเฉพาะ HTTP และ HTTPS');
        }

        // โหลด Puppeteer แบบ ESM จาก CommonJS
        const puppeteerModule = await import('puppeteer');

        const puppeteer = puppeteerModule.default || puppeteerModule;

        browser = await puppeteer.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage'
            ]
        });

        const page = await browser.newPage();

        await page.setViewport({
            width: 1366,
            height: 900,
            deviceScaleFactor: 1
        });

        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
            'AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) ' +
            'Chrome/120.0.0.0 Safari/537.36'
        );

        await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9'
        });

        await page.goto(parsedUrl.href, {
            waitUntil: 'domcontentloaded',
            timeout: 30000
        });

        // รอ JavaScript โหลด
        await new Promise(resolve =>
            setTimeout(resolve, 2000)
        );

        // Scroll เพื่อกระตุ้น Lazy Load
        await page.evaluate(async () => {
            await new Promise(resolve => {
                let lastHeight = 0;
                let stableCount = 0;

                const timer = setInterval(() => {
                    window.scrollBy(0, 500);

                    const currentHeight =
                        document.body.scrollHeight;

                    if (currentHeight === lastHeight) {
                        stableCount++;
                    } else {
                        stableCount = 0;
                        lastHeight = currentHeight;
                    }

                    if (stableCount >= 5) {
                        clearInterval(timer);

                        window.scrollTo(0, 0);

                        setTimeout(resolve, 1000);
                    }
                }, 300);
            });
        });

        // รอรูปโหลดเพิ่ม
        await new Promise(resolve =>
            setTimeout(resolve, 1500)
        );

        const html = await page.content();

        await browser.close();
        browser = null;

        const $ = cheerio.load(html);

        let images = [];
        let maxImgs = 0;
        let bestContainer = null;

        $('div, article, section, ul, main').each((i, el) => {
            const imgs = $(el).find('img');

            if (imgs.length > maxImgs) {
                maxImgs = imgs.length;
                bestContainer = el;
            }
        });

        const target = bestContainer
            ? $(bestContainer).find('img')
            : $('img');

        target.each((i, img) => {
            let imgUrl =
                $(img).attr('data-src') ||
                $(img).attr('data-lazy-src') ||
                $(img).attr('data-original') ||
                $(img).attr('data-url') ||
                $(img).attr('data-image') ||
                $(img).attr('src');

            if (!imgUrl) {
                return;
            }

            imgUrl = imgUrl.trim();

            try {
                imgUrl = new URL(
                    imgUrl,
                    parsedUrl.href
                ).href;
            } catch {
                return;
            }

            const lowerUrl = imgUrl.toLowerCase();

            if (
                lowerUrl.includes('.gif') ||
                lowerUrl.includes('logo') ||
                lowerUrl.includes('icon') ||
                lowerUrl.includes('avatar') ||
                lowerUrl.includes('favicon') ||
                lowerUrl.includes('banner')
            ) {
                return;
            }

            if (!images.includes(imgUrl)) {
                images.push(imgUrl);
            }
        });

        console.log(
            `พบรูปทั้งหมด ${images.length} รูป`
        );

        if (images.length === 0) {
            return {
                success: false,
                error: 'ไม่พบรูปภาพในหน้านี้'
            };
        }

        return {
            success: true,
            images,
            count: images.length
        };

    } catch (error) {
        console.error(
            'fetch-manga error:',
            error
        );

        if (browser) {
            try {
                await browser.close();
            } catch {}
        }

        return {
            success: false,
            error:
                error.message ||
                'ไม่สามารถดึงข้อมูลได้'
        };
    }
});


// ============================================================
// DOWNLOAD IMAGES
// ============================================================

ipcMain.handle(
    'download-images',
    async (
        event,
        data
    ) => {

        try {

            const {
                images,
                savePath,
                folderName
            } = data || {};

            // ----------------------------------------------------
            // Validate
            // ----------------------------------------------------

            if (
                !Array.isArray(images) ||
                images.length === 0
            ) {
                throw new Error(
                    'ไม่พบรูปภาพสำหรับดาวน์โหลด'
                );
            }

            if (!savePath) {
                throw new Error(
                    'ไม่ได้เลือกโฟลเดอร์ปลายทาง'
                );
            }

            if (!folderName) {
                throw new Error(
                    'ไม่ได้ระบุชื่อโฟลเดอร์'
                );
            }

            // ----------------------------------------------------
            // Safe folder name
            // ----------------------------------------------------

            let safeFolderName =
                String(folderName)
                    .replace(
                        /[<>:"/\\|?*]/g,
                        '_'
                    )
                    .replace(
                        /\s+/g,
                        ' '
                    )
                    .trim();

            if (!safeFolderName) {
                safeFolderName =
                    'Manga';
            }

            // ----------------------------------------------------
            // Create folder
            // ----------------------------------------------------

            const fullPath =
                path.join(
                    savePath,
                    safeFolderName
                );

            if (
                !fs.existsSync(fullPath)
            ) {
                fs.mkdirSync(
                    fullPath,
                    {
                        recursive: true
                    }
                );
            }

            let count = 0;
            let failed = 0;

            // ----------------------------------------------------
            // Download each image
            // ----------------------------------------------------

            for (
                let i = 0;
                i < images.length;
                i++
            ) {

                const imgUrl =
                    images[i];

                try {

                    const parsedUrl =
                        new URL(imgUrl);

                    // ------------------------------------------------
                    // Filename
                    // ------------------------------------------------

                    let originalName =
                        path.basename(
                            parsedUrl.pathname
                        );

                    if (
                        !originalName ||
                        originalName === '/'
                    ) {
                        originalName =
                            `image_${i + 1}.jpg`;
                    }

                    originalName =
                        decodeURIComponent(
                            originalName
                        );

                    originalName =
                        originalName.replace(
                            /[<>:"/\\|?*]/g,
                            '_'
                        );

                    // ถ้าไม่มี extension
                    if (
                        !path.extname(
                            originalName
                        )
                    ) {
                        originalName +=
                            '.jpg';
                    }

                    const fileName =
                        `page_${String(
                            i + 1
                        ).padStart(
                            3,
                            '0'
                        )}_${originalName}`;

                    const filePath =
                        path.join(
                            fullPath,
                            fileName
                        );

                    // ------------------------------------------------
                    // Request
                    // ------------------------------------------------

                    const response =
                        await axios({
                            url:
                                parsedUrl.href,

                            method:
                                'GET',

                            responseType:
                                'stream',

                            timeout:
                                30000,

                            maxRedirects:
                                5,

                            headers: {

                                'User-Agent':
                                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',

                                'Accept':
                                    'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',

                                'Referer':
                                    parsedUrl.origin +
                                    '/'
                            }
                        });

                    // ------------------------------------------------
                    // Write file
                    // ------------------------------------------------

                    const writer =
                        fs.createWriteStream(
                            filePath
                        );

                    response.data.pipe(
                        writer
                    );

                    await new Promise(
                        (
                            resolve,
                            reject
                        ) => {

                            writer.on(
                                'finish',
                                resolve
                            );

                            writer.on(
                                'error',
                                reject
                            );

                            response.data.on(
                                'error',
                                reject
                            );

                        }
                    );

                    count++;

                } catch (imageError) {

                    failed++;

                    console.error(
                        `Failed to download image ${i + 1}:`,
                        imageError.message
                    );

                }

                // ----------------------------------------------------
                // Progress
                // ----------------------------------------------------

                if (
                    mainWindow &&
                    !mainWindow.isDestroyed()
                ) {

                    mainWindow.webContents.send(
                        'download-progress',
                        {
                            current:
                                i + 1,

                            total:
                                images.length,

                            count,

                            failed,

                            percent:
                                Math.round(
                                    ((i + 1) /
                                        images.length) *
                                    100
                                )
                        }
                    );

                }
            }

            // ----------------------------------------------------
            // History
            // ----------------------------------------------------

            const historyFile =
                path.join(
                    app.getPath(
                        'userData'
                    ),
                    'history.json'
                );

            let history = [];

            if (
                fs.existsSync(
                    historyFile
                )
            ) {

                try {

                    const data =
                        fs.readFileSync(
                            historyFile,
                            'utf8'
                        );

                    if (
                        data.trim()
                    ) {

                        history =
                            JSON.parse(
                                data
                            );

                    }

                    if (
                        !Array.isArray(
                            history
                        )
                    ) {
                        history = [];
                    }

                } catch {

                    history = [];

                }

            }

            history.push({
                time:
                    new Date()
                        .toLocaleString(),

                folder:
                    safeFolderName,

                count,

                failed,

                total:
                    images.length,

                path:
                    fullPath
            });

            fs.writeFileSync(
                historyFile,
                JSON.stringify(
                    history,
                    null,
                    2
                ),
                'utf8'
            );

            // ----------------------------------------------------
            // Result
            // ----------------------------------------------------

            return {
                success: true,
                count,
                failed,
                total:
                    images.length,
                path:
                    fullPath
            };

        } catch (error) {

            console.error(
                'download-images error:',
                error
            );

            return {
                success: false,
                error:
                    error.message ||
                    'ดาวน์โหลดไม่สำเร็จ'
            };
        }
    }
);

// ============================================================
// GET HISTORY
// ============================================================

ipcMain.handle(
    'get-history',
    async () => {

        try {

            const historyFile =
                path.join(
                    app.getPath(
                        'userData'
                    ),
                    'history.json'
                );

            if (
                !fs.existsSync(
                    historyFile
                )
            ) {
                return [];
            }

            const data =
                fs.readFileSync(
                    historyFile,
                    'utf8'
                );

            if (!data.trim()) {
                return [];
            }

            const history =
                JSON.parse(data);

            return Array.isArray(
                history
            )
                ? history
                : [];

        } catch (error) {

            console.error(
                'get-history error:',
                error
            );

            return [];
        }
    }
);

// ============================================================
// CLEAR HISTORY
// ============================================================

ipcMain.handle(
    'clear-history',
    async () => {

        try {

            const historyFile =
                path.join(
                    app.getPath(
                        'userData'
                    ),
                    'history.json'
                );

            if (
                fs.existsSync(
                    historyFile
                )
            ) {
                fs.unlinkSync(
                    historyFile
                );
            }

            return true;

        } catch (error) {

            console.error(
                'clear-history error:',
                error
            );

            return false;
        }
    }
);
