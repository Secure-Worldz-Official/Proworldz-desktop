const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const { exec, spawn } = require('child_process');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const os = require('os');

let mainWindow;
const tempDir = path.join(os.tmpdir(), 'proworldz-lab');
const runSessions = new Map();

if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
}

function createSessionId() {
    return `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function sendRunOutput(sessionId, type, data) {
    if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('run-output', {
            sessionId,
            type,
            data: data.toString()
        });
    }
}

function sendRunExit(sessionId, code, signal) {
    if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('run-exit', { sessionId, code, signal });
    }
}

function safeUnlink(filePath) {
    try {
        fs.unlinkSync(filePath);
    } catch {}
}

function execPromise(command) {
    return new Promise((resolve, reject) => {
        exec(command, (error, stdout, stderr) => {
            if (error) {
                return reject(stderr || stdout || error.message);
            }
            resolve(stdout || stderr || '');
        });
    });
}

function checkLanguage(language) {
    return new Promise((resolve) => {
        const commands = {
            c: process.platform === 'win32' ? 'gcc --version 2>nul' : 'gcc --version 2>/dev/null',
            cpp: process.platform === 'win32' ? 'g++ --version 2>nul' : 'g++ --version 2>/dev/null',
            python: process.platform === 'win32' ? 'python --version 2>nul' : 'python3 --version 2>/dev/null',
            java: process.platform === 'win32' ? 'java -version 2>nul' : 'java -version 2>/dev/null',
            javascript: process.platform === 'win32' ? 'node --version 2>nul' : 'node --version 2>/dev/null',
            go: process.platform === 'win32' ? 'go version 2>nul' : 'go version 2>/dev/null',
            php: process.platform === 'win32' ? 'php --version 2>nul' : 'php --version 2>/dev/null'
        };

        if (!commands[language]) return resolve(false);

        exec(commands[language], (error, stdout, stderr) => {
            if (language === 'java') {
                const output = stdout + stderr;
                resolve(output.toLowerCase().includes('java'));
            } else {
                resolve(!error);
            }
        });
    });
}

async function checkAllLanguages() {
    const languages = ['c', 'cpp', 'python', 'java', 'javascript', 'go', 'php'];
    const results = {};
    
    for (const lang of languages) {
        results[lang] = await checkLanguage(lang);
    }
    
    return results;
}

function getSupportedLanguages() {
    return ['c', 'cpp', 'python', 'java', 'javascript', 'php', 'go'];
}

function getPythonCommand() {
    if (process.platform === 'win32') {
        for (const cmd of ['python', 'python3', 'py']) {
            try {
                require('child_process').execSync(`${cmd} --version 2>nul`);
                return cmd;
            } catch {}
        }
        return 'python';
    }
    return 'python3';
}

function execWithInput(cmd, args, inputs) {
    return new Promise(resolve => {
        const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], shell: true });
        let out = '', err = '', killed = false;

        if (inputs?.length) {
            inputs.forEach((i, x) => setTimeout(() => !killed && child.stdin.write(i + '\n'), x * 100));
            setTimeout(() => child.stdin.end(), inputs.length * 100 + 100);
        } else child.stdin.end();

        child.stdout.on('data', d => out += d);
        child.stderr.on('data', d => err += d);

        const timer = setTimeout(() => {
            killed = true;
            child.kill('SIGTERM');
            setTimeout(() => child.kill('SIGKILL'), 1000);
        }, 10000);

        child.on('close', c => {
            clearTimeout(timer);
            resolve({ success: c === 0, output: (err || out).trim() || 'Execution failed' });
        });
    });
}

const runJavaScriptWithInput = (c, f, i) => fs.writeFileSync(f + '.js', c) || execWithInput('node', [f + '.js'], i);
const runPythonWithInput = (c, f, i) => fs.writeFileSync(f + '.py', c) || execWithInput(getPythonCommand(), [f + '.py'], i);
const runPHPWithInput = (c, f, i) => fs.writeFileSync(f + '.php', c) || execWithInput('php', [f + '.php'], i);
const runGoWithInput = (c, f, i) => fs.writeFileSync(f + '.go', c) || execWithInput('go', ['run', f + '.go'], i);

async function compileAndRun(src, exe, compile, inputs) {
    return new Promise(resolve => {
        exec(compile, (e, _, s) => {
            if (e) return resolve({ success: false, output: s || e.message });
            execWithInput(exe, [], inputs).then(resolve);
        });
    });
}

const runCWithInput = (c, f, i) => fs.writeFileSync(f + '.c', c) || compileAndRun(f + '.c', f + '.exe', `gcc "${f}.c" -o "${f}.exe"`, i);
const runCppWithInput = (c, f, i) => fs.writeFileSync(f + '.cpp', c) || compileAndRun(f + '.cpp', f + '.exe', `g++ "${f}.cpp" -o "${f}.exe"`, i);

function runJavaWithInput(code, base, inputs) {
    try {
        const m = code.match(/public\s+class\s+(\w+)/);
        if (!m) return Promise.resolve({ success: false, output: 'No public class found' });
        
        const className = m[1];
        const f = path.join(tempDir, `${className}.java`);
        
        fs.writeFileSync(f, code);
        
        return new Promise(resolve => {
            exec(`javac "${f}"`, (compileError, compileStdout, compileStderr) => {
                if (compileError) {
                    resolve({ 
                        success: false, 
                        output: compileStderr || compileStdout || 'Compilation failed' 
                    });
                    return;
                }
                
                const runCommand = `java -cp "${tempDir}" ${className}`;
                execWithInput(runCommand, [], inputs).then(resolve);
            });
        });
    } catch (error) {
        return Promise.resolve({ success: false, output: error.message });
    }
}

function cleanupTempFiles(b) {
    fs.readdirSync(tempDir).forEach(f => f.includes(path.basename(b)) && fs.unlinkSync(path.join(tempDir, f)));
}

async function runCodeWithInput(language, code, inputs = []) {
    const supported = getSupportedLanguages();
    
    if (!supported.includes(language)) {
        return {
            success: false,
            output: `Language "${language}" is not supported. Supported languages: ${supported.join(', ')}`
        };
    }
    
    const t = Date.now();
    const base = path.join(tempDir, `temp_${t}`);
    
    try {
        const runners = {
            javascript: runJavaScriptWithInput,
            python: runPythonWithInput,
            java: runJavaWithInput,
            c: runCWithInput,
            cpp: runCppWithInput,
            go: runGoWithInput,
            php: runPHPWithInput
        };
        
        if (!runners[language]) {
            return {
                success: false,
                output: `No runner found for language "${language}"`
            };
        }
        
        return await runners[language](code, base, inputs);
    } finally {
        cleanupTempFiles(base);
    }
}

function registerRunSession(sessionId, proc, cleanup) {
    const session = {
        proc,
        cleanup,
        timer: null,
        resetTimer: null
    };

    const resetTimer = () => {
        clearTimeout(session.timer);
        session.timer = setTimeout(() => {
            stopRunSession(sessionId, true);
        }, 120000);
    };

    session.resetTimer = resetTimer;
    runSessions.set(sessionId, session);
    resetTimer();

    proc.stdout.on('data', (data) => {
        sendRunOutput(sessionId, 'stdout', data);
        resetTimer();
    });

    proc.stderr.on('data', (data) => {
        sendRunOutput(sessionId, 'stderr', data);
        resetTimer();
    });

    proc.on('close', (code, signal) => {
        clearTimeout(session.timer);
        if (cleanup) cleanup();
        runSessions.delete(sessionId);
        sendRunExit(sessionId, code, signal);
    });
}

function stopRunSession(sessionId, silent = false) {
    const session = runSessions.get(sessionId);
    if (!session) return false;
    try {
        session.proc.kill('SIGTERM');
        setTimeout(() => {
            try {
                session.proc.kill('SIGKILL');
            } catch {}
        }, 1000);
    } catch {}
    if (silent) {
        return true;
    }
    return true;
}

async function startRunSession(language, code) {
    const supported = getSupportedLanguages();
    if (!supported.includes(language)) {
        return { error: `Language "${language}" is not supported. Supported languages: ${supported.join(', ')}` };
    }

    const sessionId = createSessionId();
    const base = path.join(tempDir, `temp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
    const cleanupFiles = (files) => () => files.forEach(safeUnlink);

    let proc;
    let cleanup = null;

    try {
        switch (language) {
            case 'javascript': {
                const file = `${base}.js`;
                fs.writeFileSync(file, code);
                proc = spawn('node', [file], { stdio: ['pipe', 'pipe', 'pipe'], shell: true });
                cleanup = cleanupFiles([file]);
                break;
            }
            case 'python': {
                const file = `${base}.py`;
                fs.writeFileSync(file, code);
                proc = spawn(getPythonCommand(), [file], { stdio: ['pipe', 'pipe', 'pipe'], shell: true });
                cleanup = cleanupFiles([file]);
                break;
            }
            case 'php': {
                const file = `${base}.php`;
                fs.writeFileSync(file, code);
                proc = spawn('php', [file], { stdio: ['pipe', 'pipe', 'pipe'], shell: true });
                cleanup = cleanupFiles([file]);
                break;
            }
            case 'go': {
                const file = `${base}.go`;
                fs.writeFileSync(file, code);
                proc = spawn('go', ['run', file], { stdio: ['pipe', 'pipe', 'pipe'], shell: true });
                cleanup = cleanupFiles([file]);
                break;
            }
            case 'c': {
                const src = `${base}.c`;
                const out = process.platform === 'win32' ? `${base}.exe` : `${base}.out`;
                fs.writeFileSync(src, code);
                await execPromise(`gcc "${src}" -o "${out}"`);
                proc = spawn(out, [], { stdio: ['pipe', 'pipe', 'pipe'], shell: true });
                cleanup = cleanupFiles([src, out]);
                break;
            }
            case 'cpp': {
                const src = `${base}.cpp`;
                const out = process.platform === 'win32' ? `${base}.exe` : `${base}.out`;
                fs.writeFileSync(src, code);
                await execPromise(`g++ "${src}" -o "${out}"`);
                proc = spawn(out, [], { stdio: ['pipe', 'pipe', 'pipe'], shell: true });
                cleanup = cleanupFiles([src, out]);
                break;
            }
            case 'java': {
                const match = code.match(/public\s+class\s+(\w+)/);
                if (!match) {
                    return { error: 'No public class found. Java requires a public class name to run.' };
                }
                const className = match[1];
                const file = path.join(tempDir, `${className}.java`);
                fs.writeFileSync(file, code);
                await execPromise(`javac "${file}"`);
                proc = spawn('java', ['-cp', tempDir, className], { stdio: ['pipe', 'pipe', 'pipe'], shell: true });
                cleanup = cleanupFiles([file, path.join(tempDir, `${className}.class`)]);
                break;
            }
            default:
                return { error: `No runner found for language "${language}"` };
        }
    } catch (error) {
        if (cleanup) cleanup();
        return { error: error.toString() };
    }

    if (!proc) {
        if (cleanup) cleanup();
        return { error: 'Failed to start process.' };
    }

    registerRunSession(sessionId, proc, cleanup);
    return { sessionId };
}

ipcMain.handle('open-file-dialog', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile'],
        title: 'Open File',
        filters: [
            { name: 'All Files', extensions: ['*'] },
            { name: 'Code Files', extensions: ['py', 'js', 'java', 'c', 'cpp', 'php', 'go', 'txt'] }
        ]
    });
    
    if (!result.canceled && result.filePaths.length > 0) {
        return { filePath: result.filePaths[0] };
    }
    return { filePath: null };
});

ipcMain.handle('get-files', async (event, folderPath) => {
    try {
        function readDir(dir) {
            const items = fs.readdirSync(dir, { withFileTypes: true });
            const tree = [];
            
            for (const item of items) {
                if (item.name.startsWith('.') || item.name === 'node_modules') {
                    continue;
                }
                
                const itemPath = path.join(dir, item.name);
                const treeItem = {
                    name: item.name,
                    type: item.isDirectory() ? 'folder' : 'file',
                    path: itemPath,
                    ext: path.extname(item.name)
                };
                
                if (item.isDirectory()) {
                    treeItem.children = readDir(itemPath);
                }
                
                tree.push(treeItem);
            }
            
            return tree;
        }
        
        const tree = readDir(folderPath);
        return { tree };
    } catch (error) {
        return { error: error.message };
    }
});

ipcMain.handle('read-file', async (event, filePath) => {
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        return { content };
    } catch (error) {
        return { error: error.message };
    }
});

ipcMain.handle('save-file', async (event, filePath, content) => {
    try {
        fs.writeFileSync(filePath, content, 'utf-8');
        return { success: true };
    } catch (error) {
        return { error: error.message };
    }
});

ipcMain.handle('create-file', async (event, folderPath, fileName) => {
    try {
        const fullPath = path.join(folderPath, fileName);
        fs.writeFileSync(fullPath, '', 'utf-8');
        return { path: fullPath };
    } catch (error) {
        return { error: error.message };
    }
});

ipcMain.handle('check-language', (_, l) => checkLanguage(l));
ipcMain.handle('check-all-languages', () => checkAllLanguages());
ipcMain.handle('get-supported-languages', () => {
    return { 
        languages: ['c', 'cpp', 'python', 'java', 'javascript', 'php', 'go'],
        displayNames: {
            'c': 'C',
            'cpp': 'C++',
            'python': 'Python',
            'java': 'Java',
            'javascript': 'JavaScript',
            'php': 'PHP',
            'go': 'Go'
        }
    };
});
ipcMain.handle('run-code-with-input', (_, d) => runCodeWithInput(d.language, d.code, d.inputs || []));
ipcMain.handle('start-run', async (_, d) => startRunSession(d.language, d.code));
ipcMain.handle('send-input', (_, d) => {
    const session = runSessions.get(d.sessionId);
    if (!session || !session.proc || session.proc.killed || !session.proc.stdin || !session.proc.stdin.writable) {
        return { error: 'No active session.' };
    }
    try {
        session.proc.stdin.write((d.input ?? '') + '\n');
        if (session.resetTimer) session.resetTimer();
        return { ok: true };
    } catch (error) {
        return { error: error.message };
    }
});
ipcMain.handle('stop-run', (_, d) => {
    const ok = stopRunSession(d.sessionId);
    return { ok };
});

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        webPreferences: {
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        },
        icon: path.join(__dirname, 'assets/icon.png')
    });
    mainWindow.loadFile('index.html');
}

app.whenReady().then(() => {
    createWindow();

    if (app.isPackaged) {
        // Silent background updates: download automatically, install on app quit.
        autoUpdater.autoDownload = true;
        autoUpdater.autoInstallOnAppQuit = true;

        autoUpdater.on('error', (err) => {
            console.error('Auto update error:', err?.message || String(err));
        });

        autoUpdater.on('update-available', (info) => {
            const version = info?.version ? `v${info.version}` : 'unknown version';
            console.log(`Update available: ${version}. Downloading in background...`);
        });

        autoUpdater.on('update-downloaded', () => {
            console.log('Update downloaded. It will be installed on app exit.');
        });

        autoUpdater.checkForUpdates();
    } else {
        console.log('Auto update disabled in dev mode.');
    }
});

app.on('window-all-closed', () => process.platform !== 'darwin' && app.quit());
