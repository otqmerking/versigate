const { app, BrowserWindow, ipcMain, clipboard, Menu, session, shell, Tray, dialog, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');

// Auto-update configuration
const AUTO_UPDATE_INTERVAL = 30000; // Check every 30 seconds
let updateCheckInterval = null;
let isUpdating = false;

app.commandLine.appendSwitch('disable-features', 'CookiesWithoutSameSiteMustBeSecure');

let mainWindow;
let tray = null;
let findWindow = null;

// App version
const APP_VERSION = '1.0.0';

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        fullscreen: true,
        icon: path.join(__dirname, 'icon.ico'),
        webPreferences: {
            contextIsolation: true,
            enableRemoteModule: false,
            nodeIntegration: false,
            preload: path.join(__dirname, 'preload.js')
        },
    });

    // Session and cache configuration - NO CACHE
    session.defaultSession.clearCache();
    mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
        callback({
            responseHeaders: Object.assign(
                {
                    'Cache-Control': ['no-store', 'no-cache', 'must-revalidate', 'proxy-revalidate'],
                    'Pragma': ['no-cache'],
                    'Expires': ['0'],
                },
                details.responseHeaders
            ),
        });
    });

    // Load main URL
    mainWindow.loadURL('http://versigate.my-board.org/index.php');

    // Security handling - accept all certificates
    app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
        event.preventDefault();
        callback(true);
    });

    // Window event handlers
    mainWindow.on('close', (event) => {
        event.preventDefault();
        mainWindow.destroy();
        app.quit();
    });

    // IPC handlers
    ipcMain.on('copy-to-clipboard', (event, text) => {
        clipboard.writeText(text);
    });

    ipcMain.on('find-text', (event, text) => {
        if (mainWindow && text.trim() !== '') {
            mainWindow.webContents.findInPage(text);
        }
    });

    ipcMain.on('close-find', () => {
        if (findWindow) {
            findWindow.close();
            findWindow = null;
        }
        if (mainWindow) {
            mainWindow.webContents.stopFindInPage('clearSelection');
        }
    });

    // Keyboard shortcuts
    mainWindow.webContents.on('before-input-event', (event, input) => {
        if (input.key === 'Escape' && input.type === 'keyDown') {
            mainWindow.minimize();
        } else if (input.key === 'F5' && input.type === 'keyDown') {
            mainWindow.reload();
        }
    });

    // New window handling - open in external browser
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (url.endsWith('.pdf')) {
            shell.openExternal(url);
            return { action: 'deny' };
        }
        
        // Open in same window for internal links
        if (url.includes('versigate.my-board.org')) {
            mainWindow.loadURL(url);
            return { action: 'deny' };
        }
        
        shell.openExternal(url);
        return { action: 'deny' };
    });

    // Handle page title
    mainWindow.webContents.on('page-title-updated', (event, title) => {
        mainWindow.setTitle(`VersiGate - ${title}`);
    });
}

function openFindWindow() {
    if (findWindow) {
        findWindow.focus();
        return;
    }

    findWindow = new BrowserWindow({
        parent: mainWindow,
        modal: false,
        width: 450,
        height: 130,
        frame: false,
        resizable: false,
        alwaysOnTop: true,
        movable: true,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    findWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`
        <!DOCTYPE html>
        <html>
        <head>
            <style>
                * { margin: 0; padding: 0; box-sizing: border-box; }
                body { 
                    font-family: 'Segoe UI', Arial, sans-serif; 
                    background: linear-gradient(135deg, #1a1a2e, #16213e);
                    display: flex;
                    flex-direction: column;
                    -webkit-app-region: drag;
                    height: 100vh;
                }
                .title-bar {
                    height: 28px;
                    background: rgba(0,0,0,0.3);
                    display: flex;
                    align-items: center;
                    justify-content: flex-end;
                    padding: 0 8px;
                    -webkit-app-region: drag;
                }
                .title-text {
                    flex: 1;
                    text-align: center;
                    color: #f5a623;
                    font-size: 12px;
                    font-weight: 600;
                }
                .search-container {
                    display: flex;
                    padding: 12px;
                    align-items: center;
                    gap: 10px;
                    -webkit-app-region: no-drag;
                }
                input { 
                    flex: 1;
                    height: 38px;
                    padding: 8px 14px;
                    font-size: 14px;
                    border: 2px solid #f5a623;
                    border-radius: 8px;
                    background: white;
                }
                input:focus {
                    outline: none;
                    border-color: #3b82f6;
                }
                .close-btn {
                    width: 38px;
                    height: 38px;
                    background: #ef4444;
                    color: white;
                    border: none;
                    border-radius: 8px;
                    cursor: pointer;
                    font-size: 16px;
                    font-weight: bold;
                    transition: all 0.2s;
                }
                .close-btn:hover {
                    background: #dc2626;
                    transform: scale(1.02);
                }
                .hint {
                    padding: 0 12px 12px 12px;
                    font-size: 10px;
                    color: #94a3b8;
                    -webkit-app-region: no-drag;
                }
            </style>
        </head>
        <body>
            <div class="title-bar">
                <div class="title-text">🔍 Find in Page</div>
            </div>
            <div class="search-container">
                <input id="findInput" type="text" placeholder="Type to search..." autofocus />
                <button class="close-btn" id="closeBtn">✕</button>
            </div>
            <div class="hint">Press Enter to search • Escape to close • Drag from top to move</div>
            <script>
                const { ipcRenderer } = require('electron');
                const input = document.getElementById('findInput');
                const closeBtn = document.getElementById('closeBtn');

                input.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') {
                        ipcRenderer.send('find-text', input.value);
                    } else if (e.key === 'Escape') {
                        ipcRenderer.send('close-find');
                    }
                });
                
                closeBtn.addEventListener('click', () => {
                    ipcRenderer.send('close-find');
                });
                
                setTimeout(() => {
                    input.focus();
                    input.select();
                }, 100);
            </script>
        </body>
        </html>
    `));

    findWindow.on('closed', () => {
        findWindow = null;
    });

    findWindow.setOpacity(0.98);
}

// Calculate file hash for version checking
function calculateFileHash(filePath) {
    return new Promise((resolve, reject) => {
        if (!fs.existsSync(filePath)) {
            resolve(null);
            return;
        }
        
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        
        stream.on('data', data => hash.update(data));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', reject);
    });
}

// Download file helper
function downloadFile(url, destPath) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(destPath);
        const protocol = url.startsWith('https') ? https : require('http');
        
        protocol.get(url, (response) => {
            if (response.statusCode === 200) {
                response.pipe(file);
                file.on('finish', () => {
                    file.close();
                    resolve();
                });
                file.on('error', reject);
            } else if (response.statusCode === 301 || response.statusCode === 302) {
                file.close();
                fs.unlink(destPath, () => {});
                downloadFile(response.headers.location, destPath).then(resolve).catch(reject);
            } else {
                file.close();
                fs.unlink(destPath, () => {});
                reject(new Error(`HTTP ${response.statusCode}`));
            }
        }).on('error', (err) => {
            file.close();
            fs.unlink(destPath, () => {});
            reject(err);
        });
    });
}

// Silent auto-update function - checks main.js only
async function checkAndUpdateSilently() {
    if (isUpdating) {
        console.log('Update already in progress, skipping...');
        return;
    }
    
    const mainJsPath = path.join(__dirname, 'main.js');
    const remoteMainUrl = 'https://raw.githubusercontent.com/otqmerking/versigate/refs/heads/main/main.js'; // CHANGE THIS URL
    
    try {
        // Get current file hash
        const currentHash = await calculateFileHash(mainJsPath);
        
        // Download remote file to temp location
        const tempPath = mainJsPath + '.temp';
        await downloadFile(remoteMainUrl, tempPath);
        
        // Calculate remote file hash
        const remoteHash = await calculateFileHash(tempPath);
        
        // Compare hashes
        if (currentHash !== remoteHash && remoteHash !== null) {
            console.log('Update available for main.js');
            isUpdating = true;
            
            // Create backup
            const backupPath = mainJsPath + '.backup';
            fs.copyFileSync(mainJsPath, backupPath);
            
            // Replace with new file
            fs.copyFileSync(tempPath, mainJsPath);
            fs.unlinkSync(tempPath);
            
            console.log('Update applied. Restarting app in 2 seconds...');
            
            // Show notification about update
            new Notification({
                title: 'VersiGate Update',
                body: 'A new version has been installed. The app will restart automatically.'
            }).show();
            
            setTimeout(() => {
                app.relaunch();
                app.exit();
            }, 2000);
        } else {
            // No update needed
            if (fs.existsSync(tempPath)) {
                fs.unlinkSync(tempPath);
            }
            console.log('No update needed for main.js');
        }
    } catch (err) {
        console.error('Error checking for updates:', err.message);
        isUpdating = false;
    }
}

// Manual update check with user feedback
async function checkForUpdatesManually() {
    if (isUpdating) {
        dialog.showMessageBox(mainWindow, {
            type: 'info',
            title: 'Update Check',
            message: 'An update is already in progress. Please wait.',
            buttons: ['OK']
        });
        return;
    }
    
    dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'Checking for Updates',
        message: 'Checking for updates... This may take a few seconds.',
        buttons: ['OK']
    });
    
    await checkAndUpdateSilently();
    
    if (!isUpdating) {
        dialog.showMessageBox(mainWindow, {
            type: 'info',
            title: 'No Updates',
            message: 'You are running the latest version of VersiGate.',
            buttons: ['OK']
        });
    }
}

// Start auto-update checker
function startAutoUpdateChecker() {
    if (updateCheckInterval) {
        clearInterval(updateCheckInterval);
    }
    
    // Initial check after 30 seconds
    setTimeout(() => {
        checkAndUpdateSilently();
    }, 30000);
    
    // Periodic checks
    updateCheckInterval = setInterval(() => {
        checkAndUpdateSilently();
    }, AUTO_UPDATE_INTERVAL);
}

// Navigation functions
function goHome() {
    mainWindow.loadURL('http://versigate.my-board.org/index.php');
}

function goLogout() {
    mainWindow.loadURL('http://versigate.my-board.org/logout.php');
}

function goUsers() {
    mainWindow.loadURL('http://versigate.my-board.org/admin/manage_users.php');
}

function goClients() {
    mainWindow.loadURL('http://versigate.my-board.org/admin/manage_clients.php');
}

function goSuppliers() {
    mainWindow.loadURL('http://versigate.my-board.org/admin/manage_suppliers.php');
}

function goAbout() {
    mainWindow.loadURL('http://versigate.my-board.org/support.php');
}

function goTutorial() {
    mainWindow.loadURL('http://versigate.my-board.org/tutorial.html');
}

function goDeveloper() {
    mainWindow.loadURL('http://versigate.my-board.org/developer.html');
}

function goGateLog() {
    mainWindow.loadURL('http://versigate.my-board.org/gatelog.html');
}

function goValues() {
    mainWindow.loadURL('http://versigate.my-board.org/values.html');
}

function createMenu() {
    const menuTemplate = [
        {
            label: 'File',
            submenu: [
                {
                    label: '🏠 Home',
                    accelerator: 'CmdOrCtrl+H',
                    click: () => goHome()
                },
                { type: 'separator' },
                {
                    label: '🔒 Sign Out',
                    accelerator: 'CmdOrCtrl+Shift+Q',
                    click: () => goLogout()
                },
                { type: 'separator' },
                {
                    label: '🚪 Exit',
                    accelerator: 'CmdOrCtrl+Q',
                    click: () => app.quit()
                }
            ]
        },
        {
            label: 'Edit',
            submenu: [
                {
                    label: '🔄 Reload',
                    accelerator: 'CmdOrCtrl+R',
                    click: () => {
                        if (mainWindow) mainWindow.reload();
                    }
                },
                { type: 'separator' },
                { role: 'undo', label: '↩️ Undo' },
                { role: 'redo', label: '↪️ Redo' },
                { type: 'separator' },
                { role: 'cut', label: '✂️ Cut' },
                { role: 'copy', label: '📋 Copy' },
                { role: 'paste', label: '📌 Paste' },
                { role: 'selectAll', label: '✅ Select All' },
                { type: 'separator' },
                { role: 'zoomIn', label: '🔍 Zoom In', accelerator: 'CmdOrCtrl+=' },
                { role: 'zoomOut', label: '🔍 Zoom Out', accelerator: 'CmdOrCtrl+-' },
                { role: 'resetZoom', label: '🖼️ Actual Size', accelerator: 'CmdOrCtrl+0' },
                { type: 'separator' },
                {
                    label: '🔎 Find in Page',
                    accelerator: 'CmdOrCtrl+F',
                    click: () => openFindWindow()
                }
            ]
        },
		{
            label: 'Manage',
            submenu: [
                {
                    label: '👥 Users',
                    accelerator: 'Alt+U',
                    click: () => goUsers()
                },
                {
                    label: '🏢 Clients',
                    accelerator: 'Alt+C',
                    click: () => goClients()
                },
                {
                    label: '📦 Suppliers',
                    accelerator: 'Alt+S',
                    click: () => goSuppliers()
                }
            ]
        },
        {
            label: 'Help',
            submenu: [
                {
                    label: '🔄 Check for Updates',
                    click: () => checkForUpdatesManually()
                },
                { type: 'separator' },
                {
                    label: 'ℹ️ About',
                    accelerator: 'CmdOrCtrl+I',
                    click: () => goAbout()
                },
                {
                    label: '📚 Tutorial',
                    click: () => goTutorial()
                },
                {
                    label: '👨‍💻 Developer',
                    click: () => goDeveloper()
                },
                {
                    label: '🛡️ GateLog',
                    click: () => goGateLog()
                },
                {
                    label: '💎 Our Values',
                    click: () => goValues()
                }
            ]
        }
    ];

    const menu = Menu.buildFromTemplate(menuTemplate);
    Menu.setApplicationMenu(menu);
}

// App lifecycle events
app.on('ready', () => {
    createWindow();
    createMenu();
    
    // Start auto-update checker
    startAutoUpdateChecker();
    
    console.log(`VersiGate Electron App v${APP_VERSION} started`);
    console.log(`Silent auto-update enabled - checking every ${AUTO_UPDATE_INTERVAL / 1000} seconds`);

    // Tray icon setup (optional)
    try {
        if (fs.existsSync(path.join(__dirname, 'icon.ico'))) {
            tray = new Tray(path.join(__dirname, 'icon.ico'));
            const contextMenu = Menu.buildFromTemplate([
                { label: 'Show VersiGate', click: () => mainWindow.show() },
                { label: 'Check for Updates', click: () => checkForUpdatesManually() },
                { label: 'Quit', click: () => app.quit() }
            ]);
            tray.setToolTip('VersiGate - Logistics Management');
            tray.setContextMenu(contextMenu);
            tray.on('click', () => {
                mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
            });
        }
    } catch (err) {
        console.error('Tray icon initialization failed:', err);
    }
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (mainWindow === null) {
        createWindow();
    }
});

app.on('before-quit', () => {
    if (updateCheckInterval) {
        clearInterval(updateCheckInterval);
    }
    if (mainWindow) {
        mainWindow.destroy();
    }
});

// Error handling
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
});

// Handle beforeunload to prevent accidental navigation
app.on('web-contents-created', (event, contents) => {
    contents.on('will-navigate', (event, navigationUrl) => {
        // Allow navigation within the app domain
        if (navigationUrl.includes('versigate.my-board.org')) {
            return;
        }
        // Block external navigation
        event.preventDefault();
        shell.openExternal(navigationUrl);
    });
});
