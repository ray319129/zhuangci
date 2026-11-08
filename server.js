// 撞詞 —— 多人同詞聯想遊戲伺服器（靜態檔 + WebSocket）
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = path.join(__dirname, 'public');
const REVEAL_MS = 5000;     // 揭曉後停留多久進下一輪
const MAX_WORD = 20;
const MAX_NAME = 12;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = path.normalize(path.join(PUBLIC, urlPath === '/' ? 'index.html' : urlPath));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) {
      // 不認得的路徑一律回首頁（例如 /r/ABCD）
      return fs.readFile(path.join(PUBLIC, 'index.html'), (e2, html) => {
        if (e2) { res.writeHead(500); return res.end(); }
        res.writeHead(200, { 'Content-Type': MIME['.html'] }); res.end(html);
      });
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });
const rooms = new Map();        // code -> room
const sockets = new Map();      // playerId -> ws
let matchQueue = [];            // { playerId, name }
const playerRoom = new Map();  // playerId -> room code

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode() {
  let c;
  do { c = Array.from({ length: 4 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join(''); } while (rooms.has(c));
  return c;
}
const clean = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
// 比對用：全形轉半形、忽略大小寫、空白與標點
const norm = (w) => w.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');

function send(ws, msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }

function publicState(room, forId) {
  const cur = room.current;
  return {
    code: room.code, size: room.size, seconds: room.seconds, phase: room.phase,
    round: room.round, deadline: room.deadline, revealUntil: room.revealUntil,
    hostId: room.hostId,
    players: room.players.map(p => ({ id: p.id, name: p.name, online: sockets.has(p.id), submitted: !!(cur && cur[p.id] != null) })),
    mine: cur && cur[forId] != null ? cur[forId] : null,
    prev: room.prev,           // 上一輪有效的詞（聯想依據）
    history: room.history,
  };
}
function broadcast(room) { for (const p of room.players) send(sockets.get(p.id), { t: 'state', state: publicState(room, p.id) }); }

function createRoom(size, seconds) {
  const room = { code: newCode(), size, seconds, players: [], phase: 'lobby', round: 0, current: null, prev: null, history: [], deadline: 0, revealUntil: 0, timer: null, hostId: null };
  rooms.set(room.code, room);
  return room;
}

function addPlayer(room, playerId, name) {
  let p = room.players.find(x => x.id === playerId);
  if (p) { p.name = name || p.name; return true; }
  if (room.phase !== 'lobby' || room.players.length >= room.size) return false;
  room.players.push({ id: playerId, name: name || `玩家${room.players.length + 1}` });
  if (!room.hostId) room.hostId = playerId;
  return true;
}

function startRound(room) {
  clearTimeout(room.timer);
  room.phase = 'playing';
  room.round += 1;
  room.current = {};
  room.deadline = Date.now() + room.seconds * 1000;
  room.revealUntil = 0;
  room.timer = setTimeout(() => reveal(room), room.seconds * 1000 + 300);
  broadcast(room);
}

function reveal(room) {
  if (room.phase !== 'playing') return;
  clearTimeout(room.timer);
  const words = room.players.map(p => ({ id: p.id, name: p.name, word: room.current[p.id] ?? null }));
  const complete = words.every(w => w.word != null);
  const matched = complete && new Set(words.map(w => norm(w.word))).size === 1;
  room.history.push({ round: room.round, words, complete, matched });
  if (complete) room.prev = words.map(w => w.word);
  room.current = null;
  if (matched) {
    room.phase = 'won';
    room.revealUntil = 0;
  } else {
    room.phase = 'reveal';
    room.revealUntil = Date.now() + REVEAL_MS;
    room.timer = setTimeout(() => startRound(room), REVEAL_MS);
  }
  broadcast(room);
}

function resetRoom(room) {
  clearTimeout(room.timer);
  Object.assign(room, { phase: 'lobby', round: 0, current: null, prev: null, history: [], deadline: 0, revealUntil: 0 });
}

function leaveQueue(playerId) { matchQueue = matchQueue.filter(q => q.playerId !== playerId); }

function tryMatch() {
  matchQueue = matchQueue.filter(q => sockets.has(q.playerId));
  while (matchQueue.length >= 2) {
    const [a, b] = matchQueue.splice(0, 2);
    const room = createRoom(2, 60);
    addPlayer(room, a.playerId, a.name);
    addPlayer(room, b.playerId, b.name);
    playerRoom.set(a.playerId, room.code); playerRoom.set(b.playerId, room.code);
    for (const q of [a, b]) send(sockets.get(q.playerId), { t: 'joined', code: room.code });
    startRound(room);
  }
}

// 清掉沒人在線的房間
setInterval(() => {
  for (const [code, room] of rooms) {
    if (!room.players.some(p => sockets.has(p.id))) {
      room.emptySince ??= Date.now();
      if (Date.now() - room.emptySince > 10 * 60 * 1000) { clearTimeout(room.timer); rooms.delete(code); }
    } else room.emptySince = null;
  }
}, 60 * 1000);

wss.on('connection', (ws) => {
  let playerId = null;


  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'hello') {
      playerId = /^[a-f0-9-]{36}$/.test(m.playerId) ? m.playerId : crypto.randomUUID();
      const old = sockets.get(playerId);
      if (old && old !== ws) old.close();
      sockets.set(playerId, ws);
      send(ws, { t: 'hello', playerId });
      return;
    }
    if (!playerId) return;
    const name = clean(m.name, MAX_NAME);

    switch (m.t) {
      case 'create': {
        const size = [2, 3, 4].includes(m.size) ? m.size : 2;
        const seconds = [30, 60].includes(m.seconds) ? m.seconds : 60;
        const room = createRoom(size, seconds);
        addPlayer(room, playerId, name);
        playerRoom.set(playerId, room.code);
        send(ws, { t: 'joined', code: room.code });
        broadcast(room);
        break;
      }
      case 'join': {
        const room = rooms.get(String(m.code || '').toUpperCase());
        if (!room) return send(ws, { t: 'error', msg: '找不到這個房間' });
        if (!addPlayer(room, playerId, name)) return send(ws, { t: 'error', msg: room.phase === 'lobby' ? '房間已滿' : '遊戲已經開始了' });
        playerRoom.set(playerId, room.code);
        send(ws, { t: 'joined', code: room.code });
        // 人齊自動開局
        if (room.phase === 'lobby' && room.players.length === room.size) startRound(room); else broadcast(room);
        break;
      }
      case 'match': {
        leaveQueue(playerId);
        matchQueue.push({ playerId, name });
        send(ws, { t: 'matching' });
        tryMatch();
        break;
      }
      case 'cancelMatch': leaveQueue(playerId); break;
      case 'submit': {
        const room = rooms.get(playerRoom.get(playerId));
        if (!room || room.phase !== 'playing' || !room.players.some(p => p.id === playerId)) return;
        if (room.current[playerId] != null) return;           // 提交後不可修改
        const word = clean(m.word, MAX_WORD);
        if (!word || !norm(word)) return send(ws, { t: 'error', msg: '請輸入一個詞' });
        room.current[playerId] = word;
        if (room.players.every(p => room.current[p.id] != null)) reveal(room); else broadcast(room);
        break;
      }
      case 'again': {
        const room = rooms.get(playerRoom.get(playerId));
        if (!room || room.phase !== 'won') return;
        resetRoom(room);
        if (room.players.length === room.size) startRound(room); else broadcast(room);
        break;
      }
      case 'leave': {
        const room = rooms.get(playerRoom.get(playerId));
        if (room && room.phase === 'lobby') {
          room.players = room.players.filter(p => p.id !== playerId);
          if (room.hostId === playerId) room.hostId = room.players[0]?.id ?? null;
          broadcast(room);
        }
        playerRoom.delete(playerId);
        break;
      }
    }
  });

  ws.on('close', () => {
    if (!playerId) return;
    if (sockets.get(playerId) === ws) sockets.delete(playerId);
    leaveQueue(playerId);
    const room = rooms.get(playerRoom.get(playerId));
    if (room) broadcast(room);
  });
});

server.listen(PORT, () => console.log(`撞詞 running at http://localhost:${PORT}`));
