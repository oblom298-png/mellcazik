/**
 * Mellstroy Casino — Real-time WebSocket Server
 * Optimized for Railway.app | Memory-safe version
 *
 * Fixes applied:
 *  - gzip compression (reduces memory when serving large index.html)
 *  - Cached static file buffer
 *  - Strict limits on all in-memory arrays
 *  - Reduced console.log spam
 *  - Memory monitor with auto-cleanup
 *  - Debounced online-count broadcast
 *  - Hard cap on connected clients
 */

'use strict';

const express    = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const { v4: uuidv4 } = require('uuid');
const path       = require('path');
const http       = require('http');
const fs         = require('fs');
const zlib       = require('zlib');

// ─── Express + HTTP ──────────────────────────────────────────────────────────

const app    = express();
const server = http.createServer(app);

// ─── Gzip compression middleware (manual, no extra deps) ─────────────────────

app.use((req, res, next) => {
  const ae = req.headers['accept-encoding'] || '';
  if (!ae.includes('gzip')) return next();
  const _send = res.send.bind(res);
  res.send = (body) => {
    if (typeof body !== 'string' && !Buffer.isBuffer(body)) return _send(body);
    if (res.headersSent) return;
    res.setHeader('Content-Encoding', 'gzip');
    res.removeHeader('Content-Length');
    zlib.gzip(body, (err, compressed) => {
      if (err) { res.removeHeader('Content-Encoding'); _send(body); return; }
      _send(compressed);
    });
  };
  next();
});

// ─── Sounds folder ───────────────────────────────────────────────────────────

const soundsDir = path.join(__dirname, 'sounds');
if (!fs.existsSync(soundsDir)) {
  fs.mkdirSync(soundsDir, { recursive: true });
}

// Serve sounds with long cache
app.use('/sounds', express.static(soundsDir, {
  maxAge: '30d',
  immutable: true,
  setHeaders: (res, fp) => {
    if (fp.endsWith('.mp3')) res.setHeader('Content-Type', 'audio/mpeg');
  }
}));

// ─── Serve index.html (cached buffer to avoid repeated disk I/O) ─────────────

const indexPath = path.join(__dirname, 'index.html');
let indexBuffer = null;

function loadIndex() {
  try {
    indexBuffer = fs.readFileSync(indexPath);
    console.log(`[✓] index.html loaded (${(indexBuffer.length / 1024).toFixed(0)} KB)`);
  } catch (e) {
    console.error('[!] Could not read index.html:', e.message);
  }
}
loadIndex();

// Watch for changes in development
fs.watch(indexPath, () => {
  setTimeout(loadIndex, 200);
});

app.get('/', (req, res) => {
  if (!indexBuffer) return res.status(503).send('Loading...');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(indexBuffer);
});

// ─── JSON body parser (small limit) ─────────────────────────────────────────

app.use(express.json({ limit: '16kb' }));

// ─── WebSocket Server ────────────────────────────────────────────────────────

const wss = new WebSocketServer({
  server,
  perMessageDeflate: false,   // saves memory vs per-message deflate
  maxPayload: 8 * 1024,       // 8 KB max incoming message
  backlog: 100
});

// ─── In-Memory Store (strictly bounded) ─────────────────────────────────────

// ws → ClientInfo
const clients = new Map();

// Bounded ring-buffer style arrays
const chatHistory = [];
const winHistory  = [];
const MAX_CHAT    = 40;   // was 50
const MAX_WINS    = 50;   // was 100

// Rate limits
const rateLimits  = new Map();
const RL_WINDOW   = 10_000;  // ms
const RL_MAX_CHAT = 6;       // messages per window (was 8)

// Hard cap: refuse connections beyond this
const MAX_CLIENTS = 500;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function pushBounded(arr, item, max) {
  arr.push(item);
  if (arr.length > max) arr.shift();
}

function sendTo(ws, data) {
  if (ws.readyState !== WebSocket.OPEN) return;
  try { ws.send(JSON.stringify(data)); } catch (_) {}
}

let broadcastTimer = null;
function broadcast(data, excludeWs) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(ws => {
    if (ws !== excludeWs && ws.readyState === WebSocket.OPEN) {
      try { ws.send(msg); } catch (_) {}
    }
  });
}
function broadcastAll(data) { broadcast(data, null); }

// Debounced online-count broadcast (avoid flooding on mass connect/disconnect)
function scheduleOnlineBroadcast() {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    const count = getOnlineCount();
    broadcastAll({ type: 'online_count', count });
  }, 500);
}

function getOnlineCount() {
  let n = 0;
  wss.clients.forEach(ws => { if (ws.readyState === WebSocket.OPEN) n++; });
  return n;
}

function sanitize(str, maxLen = 200) {
  if (typeof str !== 'string') return '';
  return str.trim().slice(0, maxLen)
    .replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function sanitizeNick(str) {
  if (typeof str !== 'string') return '';
  return str.trim().slice(0, 24)
    .replace(/[<>"'/\\`]/g, '').replace(/\s+/g, ' ').trim();
}

function isNickTaken(nick, excludeId) {
  const low = nick.toLowerCase();
  for (const [, c] of clients) {
    if (c.id !== excludeId && c.nickname && c.nickname.toLowerCase() === low) return true;
  }
  return false;
}

const BAD_NICKS = ['admin', 'moderator', 'система', 'system', 'server', 'bot'];

function formatTime() {
  return new Date().toLocaleTimeString('ru-RU', {
    hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow'
  });
}

function checkRate(clientId) {
  const now = Date.now();
  let rl = rateLimits.get(clientId);
  if (!rl || now - rl.t > RL_WINDOW) {
    rl = { count: 0, t: now };
    rateLimits.set(clientId, rl);
  }
  return ++rl.count <= RL_MAX_CHAT;
}

// ─── Connection Handler ───────────────────────────────────────────────────────

wss.on('connection', (ws, req) => {
  // Hard cap
  if (wss.clients.size > MAX_CLIENTS) {
    ws.close(1013, 'Server full');
    return;
  }

  const clientId = uuidv4();
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
          || req.socket.remoteAddress
          || 'unknown';

  clients.set(ws, { id: clientId, nickname: null, ip, registered: false });

  // Send init (slice to avoid sending full arrays)
  sendTo(ws, {
    type:        'init',
    clientId,
    chatHistory: chatHistory.slice(-25),
    winHistory:  winHistory.slice(-15),
    onlineCount: getOnlineCount()
  });

  scheduleOnlineBroadcast();

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  // ── Message handler ──────────────────────────────────────────────────────

  ws.on('message', (raw) => {
    let data;
    try {
      const str = raw.toString('utf8');
      if (str.length > 8192) return;
      data = JSON.parse(str);
    } catch { return; }

    const client = clients.get(ws);
    if (!client) return;

    switch (data.type) {

      case 'register': {
        if (client.registered) return; // already registered, ignore
        const nick = sanitizeNick(data.nickname || '');
        if (nick.length < 2)  { sendTo(ws, { type: 'register_error', message: 'Минимум 2 символа' }); return; }
        if (nick.length > 24) { sendTo(ws, { type: 'register_error', message: 'Максимум 24 символа' }); return; }
        if (isNickTaken(nick, clientId)) { sendTo(ws, { type: 'register_error', message: 'Этот никнейм уже занят' }); return; }
        if (BAD_NICKS.some(b => nick.toLowerCase().includes(b))) { sendTo(ws, { type: 'register_error', message: 'Этот никнейм запрещён' }); return; }

        client.nickname   = nick;
        client.registered = true;

        sendTo(ws, { type: 'register_ok', nickname: nick, clientId });

        const joinMsg = { type: 'system_message', text: `🎰 ${nick} присоединился к казино!`, time: formatTime() };
        pushBounded(chatHistory, joinMsg, MAX_CHAT);
        broadcastAll(joinMsg);
        scheduleOnlineBroadcast();
        break;
      }

      case 'chat': {
        if (!client.registered) { sendTo(ws, { type: 'error', message: 'Сначала войдите' }); return; }
        if (!checkRate(client.id)) { sendTo(ws, { type: 'error', message: 'Слишком много сообщений' }); return; }
        const text = sanitize(data.text || '', 200);
        if (!text) return;
        const msg = { type: 'chat', id: uuidv4(), clientId: client.id, nickname: client.nickname, text, time: formatTime() };
        pushBounded(chatHistory, msg, MAX_CHAT);
        broadcastAll(msg);
        break;
      }

      case 'win': {
        if (!client.registered) return;
        const amount = Math.floor(Number(data.amount) || 0);
        if (amount <= 0 || amount > 1_000_000) return;
        const game = sanitize(data.game || 'Игра', 40);
        const win  = { type: 'win', clientId: client.id, nickname: client.nickname, amount, game, time: formatTime() };
        pushBounded(winHistory, win, MAX_WINS);
        broadcastAll(win);
        if (amount >= 500) {
          const sys = { type: 'system_message', text: `🎉 ${client.nickname} выиграл $${amount.toLocaleString('en-US')} в ${game}!`, time: formatTime() };
          pushBounded(chatHistory, sys, MAX_CHAT);
          broadcastAll(sys);
        }
        break;
      }

      case 'ping':
        sendTo(ws, { type: 'pong' });
        break;
    }
  });

  // ── Disconnect ─────────────────────────────────────────────────────────────

  ws.on('close', () => {
    const client = clients.get(ws);
    if (client) {
      if (client.registered && client.nickname) {
        const bye = { type: 'system_message', text: `👋 ${client.nickname} покинул казино`, time: formatTime() };
        pushBounded(chatHistory, bye, MAX_CHAT);
        broadcast(bye, ws);
      }
      rateLimits.delete(client.id);
      clients.delete(ws);
    }
    scheduleOnlineBroadcast();
  });

  ws.on('error', () => {}); // suppress individual socket errors
});

// ─── REST Endpoints ───────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  const mem = process.memoryUsage();
  res.json({
    status:  'ok',
    online:  getOnlineCount(),
    uptime:  Math.floor(process.uptime()),
    heapMB:  Math.round(mem.heapUsed / 1024 / 1024),
    rssMB:   Math.round(mem.rss      / 1024 / 1024),
    clients: clients.size,
    wins:    winHistory.length,
    chats:   chatHistory.length
  });
});

app.get('/api/wins',   (_req, res) => res.json(winHistory.slice(-20)));
app.get('/api/online', (_req, res) => res.json({ count: getOnlineCount() }));

// SPA fallback
app.get('*', (_req, res) => {
  if (!indexBuffer) return res.status(503).send('Loading...');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(indexBuffer);
});

// ─── Ping / Keepalive ─────────────────────────────────────────────────────────

const PING_IV = setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, 20_000); // every 20 s (Railway kills at 30 s idle)

// Periodic online count broadcast
const COUNT_IV = setInterval(() => {
  broadcastAll({ type: 'online_count', count: getOnlineCount() });
}, 15_000);

// ─── Memory watchdog ──────────────────────────────────────────────────────────
// If heap > 400 MB, trim history arrays and force GC (if --expose-gc passed)

const MEM_IV = setInterval(() => {
  const heapMB = process.memoryUsage().heapUsed / 1024 / 1024;
  if (heapMB > 380) {
    console.warn(`[MEM] Heap ${heapMB.toFixed(0)} MB — trimming caches`);
    // Trim arrays aggressively
    while (chatHistory.length > 20) chatHistory.shift();
    while (winHistory.length  > 20) winHistory.shift();
    // Try GC if available
    if (typeof global.gc === 'function') {
      try { global.gc(); } catch (_) {}
    }
  }
}, 30_000);

// Clean stale rate limits every 2 minutes
const RL_IV = setInterval(() => {
  const cutoff = Date.now() - RL_WINDOW * 5;
  for (const [id, rl] of rateLimits) {
    if (rl.t < cutoff) rateLimits.delete(id);
  }
}, 120_000);

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT, 10) || 3000;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[✓] MELLSTROY CASINO running on port ${PORT}`);
  console.log(`[✓] Health: http://localhost:${PORT}/health`);
  console.log(`[✓] Sounds: ${soundsDir}`);
  console.log(`[✓] Node:   ${process.version}  PID: ${process.pid}`);
});

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

function shutdown(sig) {
  console.log(`\n[${sig}] Shutting down…`);
  clearInterval(PING_IV);
  clearInterval(COUNT_IV);
  clearInterval(MEM_IV);
  clearInterval(RL_IV);
  if (broadcastTimer) clearTimeout(broadcastTimer);

  wss.clients.forEach(ws => { try { ws.close(1001, 'Restarting'); } catch (_) {} });
  wss.close(() => {
    server.close(() => { console.log('[✓] Stopped.'); process.exit(0); });
  });
  setTimeout(() => process.exit(1), 6_000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('uncaughtException',  err => console.error('[ERR] Uncaught:',   err.message));
process.on('unhandledRejection', err => console.error('[ERR] Rejection:',  err));
