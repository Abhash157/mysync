// The page gets a small allow-listed API and nothing else.
const { contextBridge, ipcRenderer } = require('electron');

const CALLS = ['info', 'pick', 'list', 'read', 'write', 'create', 'mkdir', 'rename', 'remove', 'search', 'session', 'reveal', 'external'];
const api = {};
for (const name of CALLS) api[name] = (...args) => ipcRenderer.invoke('n:' + name, ...args);
api.onFocus = (fn) => ipcRenderer.on('focus', () => fn());

contextBridge.exposeInMainWorld('api', api);
