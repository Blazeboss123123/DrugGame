// Underworld Empire multiplayer server. No dependencies: Node's http module plus a minimal
// WebSocket implementation. Serves the built game and relays players between rooms.
//
//   node server/server.mjs            (serves ./dist on PORT or 8080)
//   STATIC_DIR=build node server/server.mjs
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const PORT = Number(process.env.PORT) || 8080;
const ROOT = resolve(process.env.STATIC_DIR || 'dist');
const MAX_PER_ROOM = 8;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

// ---------------------------------------------------------------------------------- static files
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/rooms') {
      // Public world browser: every open, public room with its host, players and in-game time.
      const list = [...rooms.entries()]
        .filter(([, r]) => r.public && r.players.size > 0)
        .map(([code, r]) => ({
          code,
          name: r.name,
          host: r.players.get(r.host)?.name ?? '',
          players: r.players.size,
          max: MAX_PER_ROOM,
          names: [...r.players.values()].map((p) => p.name),
          day: r.day,
          minutes: r.minutes,
          since: r.createdAt,
        }))
        .sort((a, b) => b.players - a.players || a.since - b.since);
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ rooms: list, online: [...rooms.values()].reduce((s, r) => s + r.players.size, 0) }));
      return;
    }
    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, rooms: rooms.size, players: [...rooms.values()].reduce((s, r) => s + r.players.size, 0) }));
      return;
    }
    let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    if (path.endsWith('/')) path += 'index.html';
    let file = join(ROOT, path);
    if (!file.startsWith(ROOT)) throw new Error('outside root');
    let info = await stat(file).catch(() => null);
    if (!info || info.isDirectory()) {
      file = join(ROOT, 'index.html');
      info = await stat(file).catch(() => null);
    }
    if (!info) {
      res.writeHead(404);
      res.end('Not found. Build the game first (npm run build).');
      return;
    }
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': extname(file) === '.html' ? 'no-cache' : 'public, max-age=3600' });
    res.end(body);
  } catch {
    res.writeHead(400);
    res.end('Bad request');
  }
});

// ---------------------------------------------------------------------------------- websocket
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function frame(text) {
  const payload = Buffer.from(text);
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x81, n]) : n < 65536 ? Buffer.from([0x81, 126, n >> 8, n & 255]) : Buffer.concat([Buffer.from([0x81, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; })()]);
  return Buffer.concat([head, payload]);
}

class Socket {
  constructor(sock) {
    this.sock = sock;
    this.buf = Buffer.alloc(0);
    this.parts = [];
    this.open = true;
    this.onmessage = () => {};
    this.onclose = () => {};
    sock.on('data', (d) => this.data(d));
    sock.on('close', () => this.closed());
    sock.on('error', () => this.closed());
  }
  data(d) {
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= 2) {
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const op = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        len = Number(this.buf.readBigUInt64BE(2));
        off = 10;
      }
      if (len > 1 << 20) return this.close();
      const mask = masked ? this.buf.subarray(off, off + 4) : null;
      if (masked) off += 4;
      if (this.buf.length < off + len) return;
      const payload = Buffer.from(this.buf.subarray(off, off + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buf = this.buf.subarray(off + len);
      if (op === 8) return this.close();
      if (op === 9) {
        this.sock.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload]));
        continue;
      }
      if (op === 1 || op === 0) {
        this.parts.push(payload);
        if (fin) {
          const text = Buffer.concat(this.parts).toString('utf8');
          this.parts = [];
          try {
            this.onmessage(JSON.parse(text));
          } catch {
            /* ignore malformed */
          }
        }
      }
    }
  }
  send(obj) {
    if (this.open) this.sock.write(frame(typeof obj === 'string' ? obj : JSON.stringify(obj)));
  }
  close() {
    if (!this.open) return;
    try {
      this.sock.write(Buffer.from([0x88, 0]));
    } catch {
      /* ignore */
    }
    this.sock.end();
    this.closed();
  }
  closed() {
    if (!this.open) return;
    this.open = false;
    this.onclose();
  }
}

// ---------------------------------------------------------------------------------- rooms
/** @type {Map<string, {players: Map<string, any>, host: string | null}>} */
const rooms = new Map();

function roomOf(code) {
  let r = rooms.get(code);
  if (!r) {
    r = { players: new Map(), host: null, name: '', public: true, createdAt: Date.now(), day: 1, minutes: 0, cheats: true };
    rooms.set(code, r);
  }
  return r;
}

function broadcast(room, msg, except) {
  const text = JSON.stringify(msg);
  for (const p of room.players.values()) if (p.id !== except) p.ws.send(text);
}

const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);

server.on('upgrade', (req, sock) => {
  const url = new URL(req.url, 'http://x');
  const key = req.headers['sec-websocket-key'];
  if (url.pathname !== '/ws' || !key) {
    sock.destroy();
    return;
  }
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  sock.setNoDelay(true);
  const ws = new Socket(sock);
  const code = clean(url.searchParams.get('room') || 'HARLOW', 12).toUpperCase() || 'HARLOW';
  const room = roomOf(code);
  if (room.players.size >= MAX_PER_ROOM) {
    ws.send({ t: 'error', text: `Room ${code} is full (${MAX_PER_ROOM} players).` });
    ws.close();
    return;
  }
  const id = randomBytes(4).toString('hex');
  const me = { id, ws, name: 'Player', outfit: 'Casual_Hoodie', state: null };
  ws.onmessage = (m) => {
    switch (m.t) {
      case 'hello':
        me.name = clean(m.name, 20) || 'Player';
        me.outfit = clean(m.outfit, 24) || 'Casual_Hoodie';
        // The first player in a room sets its name and whether it's listed publicly.
        if (!room.players.size) {
          room.name = clean(m.world, 32) || `${me.name}'s world`;
          room.public = m.public !== false;
          room.createdAt = Date.now();
          room.cheats = m.cheats !== false;
        }
        room.players.set(id, me);
        if (!room.host) room.host = id;
        ws.send({ t: 'welcome', id, room: code, world: room.name, public: room.public, host: room.host, cheats: room.cheats, day: room.day, minutes: room.minutes, players: [...room.players.values()].filter((p) => p.id !== id).map((p) => ({ id: p.id, name: p.name, outfit: p.outfit })) });
        broadcast(room, { t: 'join', id, name: me.name, outfit: me.outfit }, id);
        break;
      case 'st':
        me.state = m.s;
        break;
      case 'chat':
        broadcast(room, { t: 'chat', id, name: me.name, text: clean(m.text, 200) });
        break;
      case 'time':
        if (room.host === id) {
          room.day = Number(m.day) || 1;
          room.minutes = Number(m.minutes) || 0;
          broadcast(room, { t: 'time', day: m.day, minutes: m.minutes, speed: m.speed }, id);
        }
        break;
      case 'cfg':
        // Host-only room settings: whether cheats are allowed for everyone.
        if (room.host === id) {
          room.cheats = m.cheats !== false;
          broadcast(room, { t: 'cfg', cheats: room.cheats, name: me.name });
        }
        break;
      case 'wipe':
        // "Remove everyone's money": only while cheats are allowed (or from the host).
        if (room.cheats || room.host === id) broadcast(room, { t: 'wipe', id, name: me.name }, id);
        break;
      case 'w':
        // Shared-world change: everyone else applies it.
        broadcast(room, { t: 'w', ops: m.ops, reset: m.reset === true && room.host === id }, id);
        break;
      case 'pev':
        // Someone talked to a person or a customer used product: everyone else sees it.
        broadcast(room, { ...m, from: id }, id);
        break;
      case 'peds':
        // Pedestrian positions come from the host only.
        if (room.host === id) broadcast(room, { t: 'peds', p: m.p }, id);
        break;
      case 'timeset': {
        // A guest's time cheat goes to the host, whose clock everyone follows.
        const host = room.players.get(room.host);
        if (host && host.id !== id && room.cheats) host.ws.send({ t: 'timeset', hour: m.hour, from: id, name: me.name });
        break;
      }
      case 'wreq': {
        // A newcomer asks the host for the current world.
        const host = room.players.get(room.host);
        if (host && host.id !== id) host.ws.send({ t: 'wreq', from: id });
        break;
      }
      case 'trade':
      case 'trade-reply':
      case 'wsnap':
      case 'fx': {
        const to = room.players.get(m.to);
        if (to) to.ws.send({ ...m, from: id, name: me.name });
        break;
      }
    }
  };
  ws.onclose = () => {
    if (!room.players.delete(id)) return;
    broadcast(room, { t: 'leave', id });
    if (room.host === id) {
      room.host = room.players.keys().next().value ?? null;
      if (room.host) broadcast(room, { t: 'host', id: room.host });
    }
    if (!room.players.size) rooms.delete(code);
  };
});

// Snapshot broadcast: 12 times a second, every player's latest state to everyone in the room.
setInterval(() => {
  for (const room of rooms.values()) {
    const s = {};
    for (const p of room.players.values()) if (p.state) s[p.id] = p.state;
    broadcast(room, { t: 'states', s });
  }
}, 1000 / 12);

server.listen(PORT, () => console.log(`Underworld Empire server on http://localhost:${PORT} (serving ${ROOT})`));
