/**
 * Mellstroy Casino — Real-time WebSocket Server
 * Optimized for Railway.app deployment
 * 
 * Handles: Registration, Chat, Live Wins, Online Count
 */

const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const http = require('http');
const fs = require('fs');

// ─── Express + HTTP Server ──────────────────────────────────────────────────

const app = express();
const server = http.createServer(app);

// ─── Static Files ───────────────────────────────────────────────────────────

// Serve index.html and other root files
app.use(express.static(path.join(__dirname), {
  maxAge: '1h',
  etag: true
}));

// Serve sounds folder (win.mp3 etc.)
const soundsDir = path.join(__dirname, 'sounds');
if (!fs.existsSync(soundsDir)) {
  fs.mkdirSync(soundsDir, { recursive: true });
  console.log('[FS] Created sounds/ directory');
}
app.use('/sounds', express.static(soundsDir, {
  maxAge: '7d',
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.mp3')) {
      res.setHeader('Content-Type', 'audio/mpeg');
    }
  }
}));

app.use(express.json());

// ─── WebSocket Server ───────────────────────────────────────────────────────

const wss = new WebSocketServer({ 
  server,
  perMessageDeflate: false,
  maxPayload: 16 * 1024 // 16KB max message
});

// ─── In-Memory Store ────────────────────────────────────────────────────────

const clients = new Map();    // ws -> { id, nickname, ip, joinedAt, registered }
const chatHistory = [];       // last N chat messages
const winHistory = [];        // last N win events
const MAX_CHAT = 50;
const MAX_WINS = 100;

// Rate limiting per client
const rateLimits = new Map(); // clientId -> { chatCount, lastReset }
const RATE_LIMIT_WINDOW = 10000; // 10 seconds
const RATE_LIMIT_MAX_CHAT = 8;   // max 8 messages per 10 seconds

// ─── Helpers ────────────────────────────────────────────────────────────────

function broadcast(data, excludeWs = null) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(ws => {
    if (ws !== excludeWs && ws.readyState === WebSocket.OPEN) {
      try { ws.send(msg); } catch(e) {}
    }
  });
}

function broadcastAll(data) {
  broadcast(data, null);
}

function sendTo(ws, data) {
  if (ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(data)); } catch(e) {}
  }
}

function getOnlineCount() {
  let count = 0;
  wss.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) count++;
  });
  return count;
}

function broadcastOnlineCount() {
  broadcastAll({ type: 'online_count', count: getOnlineCount() });
}

function sanitize(str) {
  if (typeof str !== 'string') return '';
  return str
    .trim()
    .slice(0, 200)
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sanitizeNick(str) {
  if (typeof str !== 'string') return '';
  return str
    .trim()
    .slice(0, 24)
    .replace(/[<>"'/\\`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isNicknameUsed(nick, excludeId = null) {
  const lower = nick.toLowerCase();
  for (const [, client] of clients) {
    if (client.id !== excludeId && 
        client.nickname && 
        client.nickname.toLowerCase() === lower) {
      return true;
    }
  }
  return false;
}

function formatTime() {
  return new Date().toLocaleTimeString('ru-RU', { 
    hour: '2-digit', 
    minute: '2-digit',
    timeZone: 'Europe/Moscow'
  });
}

function checkRateLimit(clientId) {
  const now = Date.now();
  let rl = rateLimits.get(clientId);
  if (!rl || now - rl.lastReset > RATE_LIMIT_WINDOW) {
    rl = { chatCount: 0, lastReset: now };
    rateLimits.set(clientId, rl);
  }
  rl.chatCount++;
  return rl.chatCount <= RATE_LIMIT_MAX_CHAT;
}

// ─── WebSocket Connection Handler ───────────────────────────────────────────

wss.on('connection', (ws, req) => {
  const clientId = uuidv4();
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 
             req.headers['x-real-ip'] || 
             req.socket.remoteAddress || 
             'unknown';

  clients.set(ws, {
    id: clientId,
    nickname: null,
    ip,
    joinedAt: Date.now(),
    registered: false
  });

  console.log(`[+] Connected: ${clientId} from ${ip} | Online: ${getOnlineCount()}`);

  // Send initial state
  sendTo(ws, {
    type: 'init',
    clientId,
    chatHistory: chatHistory.slice(-30),
    winHistory: winHistory.slice(-20),
    onlineCount: getOnlineCount()
  });

  broadcastOnlineCount();

  // ── Alive tracking ──
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  // ── Message Handler ──
  ws.on('message', (raw) => {
    let data;
    try {
      const str = raw.toString();
      if (str.length > 16384) return; // Drop oversized messages
      data = JSON.parse(str);
    } catch {
      return;
    }

    const client = clients.get(ws);
    if (!client) return;

    switch (data.type) {

      // ═══ REGISTER ═══
      case 'register': {
        const nick = sanitizeNick(data.nickname || '');
        
        if (nick.length < 2) {
          sendTo(ws, { type: 'register_error', message: 'Минимум 2 символа' });
          return;
        }
        if (nick.length > 24) {
          sendTo(ws, { type: 'register_error', message: 'Максимум 24 символа' });
          return;
        }
        if (isNicknameUsed(nick, clientId)) {
          sendTo(ws, { type: 'register_error', message: 'Этот никнейм уже занят' });
          return;
        }

        // Check for bad words (basic)
        const badWords = ['admin', 'moderator', 'система', 'system'];
        if (badWords.some(w => nick.toLowerCase().includes(w))) {
          sendTo(ws, { type: 'register_error', message: 'Этот никнейм запрещён' });
          return;
        }

        client.nickname = nick;
        client.registered = true;

        sendTo(ws, { type: 'register_ok', nickname: nick, clientId });

        // Announce
        const joinMsg = {
          type: 'system_message',
          text: `🎰 ${nick} присоединился к казино!`,
          time: formatTime()
        };
        chatHistory.push(joinMsg);
        if (chatHistory.length > MAX_CHAT) chatHistory.shift();
        broadcastAll(joinMsg);
        broadcastOnlineCount();

        console.log(`[✓] Registered: "${nick}" (${clientId})`);
        break;
      }

      // ═══ CHAT ═══
      case 'chat': {
        if (!client.registered || !client.nickname) {
          sendTo(ws, { type: 'error', message: 'Сначала зарегистрируйтесь' });
          return;
        }

        // Rate limit
        if (!checkRateLimit(client.id)) {
          sendTo(ws, { type: 'error', message: 'Слишком много сообщений, подождите' });
          return;
        }

        const text = sanitize(data.text || '');
        if (!text || text.length > 200) return;

        const msg = {
          type: 'chat',
          id: uuidv4(),
          clientId: client.id,
          nickname: client.nickname,
          text,
          time: formatTime()
        };

        chatHistory.push(msg);
        if (chatHistory.length > MAX_CHAT) chatHistory.shift();
        broadcastAll(msg);
        break;
      }

      // ═══ WIN ═══
      case 'win': {
        if (!client.registered || !client.nickname) return;

        const amount = Math.floor(Number(data.amount) || 0);
        const game = sanitize(data.game || 'Игра');

        if (amount <= 0 || amount > 10000000) return;

        const win = {
          type: 'win',
          id: uuidv4(),
          clientId: client.id,
          nickname: client.nickname,
          amount,
          game,
          time: formatTime()
        };

        winHistory.push(win);
        if (winHistory.length > MAX_WINS) winHistory.shift();
        broadcastAll(win);

        // Big win announcement
        if (amount >= 500) {
          const sysMsg = {
            type: 'system_message',
            text: `🎉 ${client.nickname} выиграл $${amount.toLocaleString('en-US')} в ${game}!`,
            time: formatTime()
          };
          chatHistory.push(sysMsg);
          if (chatHistory.length > MAX_CHAT) chatHistory.shift();
          broadcastAll(sysMsg);
        }
        break;
      }

      // ═══ PING ═══
      case 'ping': {
        sendTo(ws, { type: 'pong', time: Date.now() });
        break;
      }

      default:
        break;
    }
  });

  // ── Disconnect ──
  ws.on('close', () => {
    const client = clients.get(ws);
    if (client) {
      if (client.registered && client.nickname) {
        const leaveMsg = {
          type: 'system_message',
          text: `👋 ${client.nickname} покинул казино`,
          time: formatTime()
        };
        chatHistory.push(leaveMsg);
        if (chatHistory.length > MAX_CHAT) chatHistory.shift();
        broadcast(leaveMsg, ws);
      }
      rateLimits.delete(client.id);
      clients.delete(ws);
    }
    console.log(`[-] Disconnected: ${client?.id || '?'} | Online: ${getOnlineCount()}`);
    broadcastOnlineCount();
  });

  ws.on('error', (err) => {
    console.error(`[WS Error] ${err.message}`);
  });
});

// ─── REST Endpoints ─────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    online: getOnlineCount(),
    uptime: Math.floor(process.uptime()),
    memory: Math.floor(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
    wins: winHistory.length,
    chats: chatHistory.length
  });
});

app.get('/api/wins', (req, res) => {
  res.json(winHistory.slice(-20));
});

app.get('/api/online', (req, res) => {
  res.json({ count: getOnlineCount() });
});

// Fallback — serve index.html for any unknown route (SPA style)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ─── Keepalive & Cleanup ────────────────────────────────────────────────────

// Ping all clients every 25 seconds (Railway closes idle connections at 30s)
const PING_INTERVAL = setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) {
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 25000);

// Broadcast online count every 10 seconds
const COUNT_INTERVAL = setInterval(() => {
  broadcastOnlineCount();
}, 10000);

// Clean up rate limits every minute
const CLEANUP_INTERVAL = setInterval(() => {
  const now = Date.now();
  for (const [id, rl] of rateLimits) {
    if (now - rl.lastReset > RATE_LIMIT_WINDOW * 3) {
      rateLimits.delete(id);
    }
  }
}, 60000);

// ─── Start Server ───────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = '0.0.0.0'; // Railway requires binding to 0.0.0.0

server.listen(PORT, HOST, () => {
  console.log(`
╔═══════════════════════════════════════════════╗
║   🎰  MELLSTROY CASINO SERVER  🎰             ║
║                                               ║
║   Host:      ${HOST}                          ║
║   Port:      ${PORT}                              ║
║   Status:    ✅ Running                        ║
║   Node:      ${process.version}                       ║
║   PID:       ${process.pid}                           ║
║                                               ║
║   HTTP:      http://localhost:${PORT}              ║
║   Health:    http://localhost:${PORT}/health        ║
║                                               ║
║   📂 sounds/ folder ready for win.mp3         ║
╚═══════════════════════════════════════════════╝
  `);
});

// ─── Graceful Shutdown ──────────────────────────────────────────────────────

function shutdown(signal) {
  console.log(`\n[${signal}] Shutting down gracefully...`);
  
  clearInterval(PING_INTERVAL);
  clearInterval(COUNT_INTERVAL);
  clearInterval(CLEANUP_INTERVAL);
  
  // Close all WebSocket connections
  wss.clients.forEach(ws => {
    try {
      ws.close(1001, 'Server shutting down');
    } catch(e) {}
  });
  
  wss.close(() => {
    server.close(() => {
      console.log('[✓] Server stopped cleanly');
      process.exit(0);
    });
  });
  
  // Force exit after 5 seconds
  setTimeout(() => {
    console.log('[!] Forcing exit...');
    process.exit(1);
  }, 5000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Prevent crash on unhandled errors
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err.message);
});
process.on('unhandledRejection', (err) => {
  console.error('[FATAL] Unhandled rejection:', err);
});
