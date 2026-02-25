/**
 * Mellstroy Casino - Real-time WebSocket Server
 * Handles: Chat, Live Wins Feed, Online Count, Nicknames
 */

const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const http = require('http');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Serve static files
app.use(express.static(path.join(__dirname)));
app.use('/sounds', express.static(path.join(__dirname, 'sounds')));
app.use(express.json());

// In-memory store (resets on server restart)
const clients = new Map(); // ws -> { id, nickname, joinedAt }
const chatHistory = []; // last 50 messages
const winHistory = []; // last 100 wins
const MAX_CHAT = 50;
const MAX_WINS = 100;

// ─── Helpers ────────────────────────────────────────────────────────────────

function broadcast(data, excludeWs = null) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(ws => {
    if (ws !== excludeWs && ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  });
}

function broadcastAll(data) {
  broadcast(data, null);
}

function sendTo(ws, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function getOnlineCount() {
  return [...wss.clients].filter(ws => ws.readyState === WebSocket.OPEN).length;
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
    .replace(/"/g, '&quot;');
}

function sanitizeNick(str) {
  if (typeof str !== 'string') return 'Игрок';
  return str
    .trim()
    .slice(0, 24)
    .replace(/[<>"'/\\]/g, '')
    .replace(/\s+/g, ' ') || 'Игрок';
}

function isNicknameUsed(nick, excludeId = null) {
  for (const [, client] of clients) {
    if (client.id !== excludeId && client.nickname.toLowerCase() === nick.toLowerCase()) {
      return true;
    }
  }
  return false;
}

function formatTime() {
  return new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

// ─── WebSocket Connection ────────────────────────────────────────────────────

wss.on('connection', (ws, req) => {
  const clientId = uuidv4();
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  // Register client (no nickname yet)
  clients.set(ws, {
    id: clientId,
    nickname: null,
    ip,
    joinedAt: Date.now(),
    registered: false
  });

  console.log(`[+] Client connected: ${clientId} (${ip}), total: ${getOnlineCount()}`);

  // Send initial state
  sendTo(ws, {
    type: 'init',
    clientId,
    chatHistory: chatHistory.slice(-30),
    winHistory: winHistory.slice(-20),
    onlineCount: getOnlineCount()
  });

  broadcastOnlineCount();

  // ─── Message Handler ───────────────────────────────────────────────────────

  ws.on('message', (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const client = clients.get(ws);
    if (!client) return;

    switch (data.type) {

      // ── Registration ──────────────────────────────────────────────────────
      case 'register': {
        const nick = sanitizeNick(data.nickname || '');
        if (!nick || nick.length < 2) {
          sendTo(ws, { type: 'register_error', message: 'Никнейм слишком короткий (минимум 2 символа)' });
          return;
        }
        if (nick.length > 24) {
          sendTo(ws, { type: 'register_error', message: 'Никнейм слишком длинный (максимум 24 символа)' });
          return;
        }
        if (isNicknameUsed(nick, clientId)) {
          sendTo(ws, { type: 'register_error', message: 'Этот никнейм уже занят' });
          return;
        }

        client.nickname = nick;
        client.registered = true;

        sendTo(ws, {
          type: 'register_ok',
          nickname: nick,
          clientId
        });

        // Announce join to everyone
        const joinMsg = {
          type: 'system_message',
          text: `🎰 ${nick} присоединился к казино!`,
          time: formatTime()
        };
        chatHistory.push(joinMsg);
        if (chatHistory.length > MAX_CHAT) chatHistory.shift();
        broadcastAll(joinMsg);

        broadcastOnlineCount();
        console.log(`[✓] Registered: ${nick} (${clientId})`);
        break;
      }

      // ── Chat Message ──────────────────────────────────────────────────────
      case 'chat': {
        if (!client.registered || !client.nickname) {
          sendTo(ws, { type: 'error', message: 'Сначала зарегистрируйтесь' });
          return;
        }

        const text = sanitize(data.text || '');
        if (!text) return;
        if (text.length > 200) return;

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

      // ── Win Broadcast ─────────────────────────────────────────────────────
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

        // Broadcast win to all (for ticker + chat notification)
        broadcastAll(win);

        // Big win system message in chat
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

      // ── Ping ──────────────────────────────────────────────────────────────
      case 'ping': {
        sendTo(ws, { type: 'pong', time: Date.now() });
        break;
      }

      default:
        break;
    }
  });

  // ─── Disconnect ────────────────────────────────────────────────────────────

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
      clients.delete(ws);
    }
    console.log(`[-] Client disconnected: ${client?.id || '?'}, total: ${getOnlineCount()}`);
    broadcastOnlineCount();
  });

  ws.on('error', (err) => {
    console.error('[WS Error]', err.message);
  });
});

// ─── REST Endpoints ──────────────────────────────────────────────────────────

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    online: getOnlineCount(),
    uptime: process.uptime(),
    wins: winHistory.length,
    chats: chatHistory.length
  });
});

// Get recent wins
app.get('/api/wins', (req, res) => {
  res.json(winHistory.slice(-20));
});

// Get online count
app.get('/api/online', (req, res) => {
  res.json({ count: getOnlineCount() });
});

// ─── Periodic cleanup & keepalive ────────────────────────────────────────────

// Ping all clients every 30 seconds to keep connections alive
setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
    }
  });
}, 30000);

// Broadcast online count every 10 seconds
setInterval(() => {
  broadcastOnlineCount();
}, 10000);

// ─── Start Server ─────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════╗
║   🎰  MELLSTROY CASINO SERVER  🎰        ║
║   Порт: ${PORT}                               ║
║   Статус: Запущен                        ║
║   WebSocket: ws://localhost:${PORT}           ║
║   HTTP:      http://localhost:${PORT}         ║
╚══════════════════════════════════════════╝
  `);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing server...');
  server.close(() => process.exit(0));
});
process.on('SIGINT', () => {
  console.log('SIGINT received, closing server...');
  server.close(() => process.exit(0));
});
