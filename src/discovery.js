import dgram from 'node:dgram';
import os from 'node:os';

const MCAST = '239.255.77.83';

export const discoveryPort = () => parseInt(process.env.MYSYNC_DISCOVERY_PORT || '41234', 10);

function ipv4Interfaces() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family !== 'IPv4') continue;
      const ip = i.address.split('.').map(Number);
      const mask = i.netmask.split('.').map(Number);
      const broadcast = ip.map((b, n) => (b & mask[n]) | (~mask[n] & 255)).join('.');
      out.push({ address: i.address, internal: i.internal, broadcast });
    }
  }
  return out;
}

/**
 * Zero-config LAN discovery over UDP multicast + broadcast. Packets carry only
 * non-secret identity (folder id, device, port); trust comes from verifyPeer().
 *
 * @param {object} options
 * @param {() => ({ folderId: string, deviceId: string, device: string, port: number })|null} [options.announce]
 *   Identity to advertise; omit to only listen.
 * @param {(msg: object, address: string) => void} options.onPeer Called for every packet from another device.
 * @param {number} [options.every=5] Seconds between announcements.
 * @returns {{ query: () => void, stop: () => void }}
 */
export function startDiscovery({ announce = null, onPeer, every = 5 }) {
  const port = discoveryPort();
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  let ready = false;
  let stopped = false;

  const send = (payload) => {
    if (!ready || stopped) return;
    const data = Buffer.from(JSON.stringify(payload));
    const targets = ipv4Interfaces();
    const real = targets.filter((t) => !t.internal);
    for (const iface of real.length ? real : targets) {
      try { socket.setMulticastInterface(iface.address); } catch { /* interface can't multicast */ }
      socket.send(data, port, MCAST, () => {});
      socket.send(data, port, iface.broadcast, () => {});
    }
    socket.send(data, port, '255.255.255.255', () => {});
  };

  const sendAnnounce = () => {
    const me = announce?.();
    if (me) send({ mysync: 1, type: 'announce', ...me });
  };

  socket.on('error', () => {});
  socket.on('message', (buf, rinfo) => {
    let msg;
    try { msg = JSON.parse(buf.toString('utf8')); } catch { return; }
    if (!msg || msg.mysync !== 1) return;
    if (msg.type === 'query') {
      sendAnnounce();
      return;
    }
    if (msg.type !== 'announce' || !msg.deviceId || !Number.isInteger(msg.port)) return;
    if (msg.deviceId === announce?.()?.deviceId) return;
    onPeer(msg, rinfo.address);
  });

  socket.bind(port, () => {
    if (stopped) return;
    ready = true;
    try { socket.setBroadcast(true); } catch { /* ignore */ }
    try { socket.setMulticastLoopback(true); } catch { /* ignore */ }
    for (const iface of ipv4Interfaces()) {
      try { socket.addMembership(MCAST, iface.address); } catch { /* already joined or unsupported */ }
    }
    sendAnnounce();
    send({ mysync: 1, type: 'query' });
  });

  const timer = setInterval(sendAnnounce, every * 1000);
  timer.unref?.();

  return {
    query: () => send({ mysync: 1, type: 'query' }),
    stop() {
      stopped = true;
      clearInterval(timer);
      try { socket.close(); } catch { /* already closed */ }
    },
  };
}

/**
 * Listens for a short while and returns every distinct device that announced.
 * @returns {Promise<Array<{ url: string, device: string, deviceId: string, folderId: string }>>}
 */
export function scanNearby({ seconds = 2.5 } = {}) {
  return new Promise((resolve) => {
    const found = new Map();
    const d = startDiscovery({
      onPeer: (msg, address) => {
        found.set(msg.deviceId, {
          url: `http://${address}:${msg.port}`,
          device: msg.device,
          deviceId: msg.deviceId,
          folderId: msg.folderId,
        });
      },
    });
    setTimeout(() => d.query(), 400);
    setTimeout(() => {
      d.stop();
      resolve([...found.values()]);
    }, seconds * 1000);
  });
}
