// Runs in the window before the page loads. It exposes a tiny, allow-listed API:
// the page can ask the app to do specific things, and nothing else.
const { contextBridge, ipcRenderer } = require('electron');

const INVOKE = new Set([
  'state:get',
  'folder:pick',
  'folder:inspect',
  'folder:add',
  'folder:join',
  'folder:invite',
  'folder:open',
  'folder:reveal',
  'folder:pause',
  'folder:resume',
  'folder:sync',
  'folder:remove',
  'folder:publish',
  'invite:inspect',
  'invite:clipboard',
  'clipboard:write',
  'settings:save',
  'hub:set',
  'hub:test',
  'app:logs',
  'onboarding:done',
]);

contextBridge.exposeInMainWorld('mysync', {
  invoke(channel, payload) {
    if (!INVOKE.has(channel)) return Promise.reject(new Error(`blocked channel: ${channel}`));
    return ipcRenderer.invoke(channel, payload);
  },
  onState(callback) {
    const handler = (_event, state) => callback(state);
    ipcRenderer.on('state:changed', handler);
    return () => ipcRenderer.removeListener('state:changed', handler);
  },
  onSelect(callback) {
    const handler = (_event, root) => callback(root);
    ipcRenderer.on('select-folder', handler);
    return () => ipcRenderer.removeListener('select-folder', handler);
  },
});
