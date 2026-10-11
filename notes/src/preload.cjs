// The page gets a small allow-listed API and nothing else.
const { contextBridge, ipcRenderer } = require('electron');

const CALLS = ['info', 'pick', 'list', 'read', 'write', 'create', 'mkdir', 'rename', 'remove', 'search', 'session', 'reveal', 'external',
  'pickFolder', 'clipboard', 'copy', 'syncState', 'syncRetry', 'syncEnable', 'syncJoin', 'syncInvite', 'syncPublish', 'syncInspect', 'syncNow', 'syncPause', 'syncResume', 'syncStop', 'syncDevice', 'syncHub', 'syncTestHub'];
const api = {};
for (const name of CALLS) api[name] = (...args) => ipcRenderer.invoke('n:' + name, ...args);
api.onSync = (fn) => ipcRenderer.on('sync', (_e, s) => fn(s));
api.onSyncNotify = (fn) => ipcRenderer.on('sync-notify', (_e, i) => fn(i));
api.onFocus = (fn) => ipcRenderer.on('focus', () => fn());

contextBridge.exposeInMainWorld('api', api);
