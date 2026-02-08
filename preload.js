// preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    checkLanguage: (language) => ipcRenderer.invoke('check-language', language),
    checkAllLanguages: () => ipcRenderer.invoke('check-all-languages'),
    runCodeWithInput: (data) => ipcRenderer.invoke('run-code-with-input', data),
    startRun: (data) => ipcRenderer.invoke('start-run', data),
    sendInput: (sessionId, input) => ipcRenderer.invoke('send-input', { sessionId, input }),
    stopRun: (sessionId) => ipcRenderer.invoke('stop-run', { sessionId }),
    onRunOutput: (callback) => ipcRenderer.on('run-output', (_, data) => callback(data)),
    onRunExit: (callback) => ipcRenderer.on('run-exit', (_, data) => callback(data)),
    openFileDialog: () => ipcRenderer.invoke('open-file-dialog'),
    getFiles: (folderPath) => ipcRenderer.invoke('get-files', folderPath),
    readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
    saveFile: (filePath, content) => ipcRenderer.invoke('save-file', filePath, content),
    createFile: (folderPath, fileName) => ipcRenderer.invoke('create-file', folderPath, fileName)
});
