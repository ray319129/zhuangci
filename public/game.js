// 撞詞 —— 純前端 P2P 版本
// 架構：開房的人當「房主」，在自己瀏覽器裡跑遊戲邏輯；其他玩家用 WebRTC（trystero）連到房主。
// 房主狀態存在 sessionStorage，房主重新整理也能接回同一局。
import { joinRoom, selfId } from 'https://cdn.jsdelivr.net/npm/trystero@0.26.0/+esm';

const APP_ID = 'zhuangci-same-word-v1';
const REVEAL_MS = 5000;
const MAX_WORD = 20, MAX_NAME = 12;
const HOST_WAIT_MS = 15000;    // 加入時等房主回應多久
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const mkStore = (s) => ({ get(k) { try { return s.getItem(k); } catch { return null; } }, set(k, v) { try { s.setItem(k, v); } catch {} }, del(k) { try { s.removeItem(k); } catch {} } });
const local = mkStore(window.localStorage), session = mkStore(window.sessionStorage);
const clean = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const norm = (w) => w.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
const newCode = () => Array.from({ length: 4 }, () => CODE_CHARS[crypto.getRandomValues(new Uint32Array(1))[0] % CODE_CHARS.length]).join('');

// 玩家 ID：每個分頁一個，重新整理不變
let myPid = session.get('pid');
if (!myPid) { myPid = crypto.randomUUID(); session.set('pid', myPid); }
$('name').value = local.get('name') || '';
const myName = () => { const n = clean($('name').value, MAX_NAME); local.set('name', n); return n; };

// ---------- 連線層 ----------
let room = null, chan = null;      // trystero room / action
let hostPeer = null;               // 非房主：房主的 peerId
let host = null;                   // 房主：遊戲狀態
let view = null;                   // 目前畫面用的狀態
let joinTimer = null;

function connect(code) {
  disconnect();
  room = joinRoom({ appId: APP_ID }, 'room-' + code, {
    onJoinError: (d) => console.warn('join error', d),
  });
  chan = room.makeAction('m');
  chan.onMessage = (msg, ctx) => onPeerMsg(msg, ctx.peerId);
  room.onPeerJoin = (peerId) => { if (!host) chan.send({ t: 'hello', pid: myPid, name: myName() }, { target: peerId }); };
  room.onPeerLeave = (peerId) => {
    if (host) {
      const p = host.players.find(x => x.peer === peerId);
      if (p) { p.peer = null; hostBroadcast(); }
    } else if (peerId === hostPeer) {
      banner('房主斷線了，等待重新連線…');
    }
  };
}
function disconnect() {
  clearTimeout(joinTimer);
  if (room) room.leave();
  room = chan = hostPeer = null;
}

function onPeerMsg(msg, peerId) {
  if (!msg || typeof msg !== 'object') return;
  if (host) return hostHandle(msg, peerId);
  // 非房主
  if (msg.t === 'state') {
    clearTimeout(joinTimer);
    hostPeer = peerId;
    banner();
    receiveView(msg.state);
  } else if (msg.t === 'error' && peerId) {
    clearTimeout(joinTimer);
    goHome(msg.msg);
  }
}

// 對房主送指令（房主自己就直接處理）
function act(msg) {
  if (host) hostHandle(msg, null);
  else if (chan && hostPeer) chan.send(msg, { target: hostPeer });
}

// ---------- 房主邏輯 ----------
function hostSave() {
  const { timer, ...data } = host;
  session.set('host:' + host.code, JSON.stringify(data));
}

function createHost(code, size, seconds) {
  host = { code, size, seconds, players: [], phase: 'lobby', round: 0, current: null, prev: null, history: [], deadline: 0, revealUntil: 0, timer: null };
  addPlayer(myPid, myName(), null);
}

function restoreHost(code) {
  const raw = session.get('host:' + code);
  if (!raw) return false;
  try { host = JSON.parse(raw); } catch { return false; }
  host.timer = null;
  for (const p of host.players) if (p.id !== myPid) p.peer = null;
  const now = Date.now();
  if (host.phase === 'playing') {
    if (host.deadline <= now) hostReveal(); else host.timer = setTimeout(hostReveal, host.deadline - now + 300);
  } else if (host.phase === 'reveal') {
    if (host.revealUntil <= now) hostStartRound(); else host.timer = setTimeout(hostStartRound, host.revealUntil - now);
  }
  return true;
}

function addPlayer(pid, name, peer) {
  let p = host.players.find(x => x.id === pid);
  if (p) { p.peer = peer; if (name) p.name = name; return true; }
  if (host.phase !== 'lobby' || host.players.length >= host.size) return false;
  host.players.push({ id: pid, name: name || `玩家${host.players.length + 1}`, peer });
  return true;
}

function stateFor(pid) {
  const now = Date.now();
  return {
    code: host.code, size: host.size, seconds: host.seconds, phase: host.phase, round: host.round,
    remaining: host.phase === 'playing' ? host.deadline - now : 0,
    revealLeft: host.phase === 'reveal' ? host.revealUntil - now : 0,
    players: host.players.map(p => ({ id: p.id, name: p.name, online: p.id === myPid || !!p.peer, submitted: !!(host.current && host.current[p.id] != null) })),
    mine: host.current && host.current[pid] != null ? host.current[pid] : null,
    prev: host.prev, history: host.history,
  };
}

function hostBroadcast() {
  hostSave();
  for (const p of host.players) {
    if (p.id === myPid) receiveView(stateFor(myPid));
    else if (p.peer && chan) chan.send({ t: 'state', state: stateFor(p.id) }, { target: p.peer });
  }
}

function hostStartRound() {
  clearTimeout(host.timer);
  Object.assign(host, { phase: 'playing', round: host.round + 1, current: {}, deadline: Date.now() + host.seconds * 1000, revealUntil: 0 });
  host.timer = setTimeout(hostReveal, host.seconds * 1000 + 300);
  hostBroadcast();
}

function hostReveal() {
  if (host.phase !== 'playing') return;
  clearTimeout(host.timer);
  const words = host.players.map(p => ({ id: p.id, name: p.name, word: host.current[p.id] ?? null }));
  const complete = words.every(w => w.word != null);
  const matched = complete && new Set(words.map(w => norm(w.word))).size === 1;
  host.history.push({ round: host.round, words, complete, matched });
  if (complete) host.prev = words.map(w => w.word);
  host.current = null;
  if (matched) { host.phase = 'won'; host.revealUntil = 0; }
  else {
    host.phase = 'reveal';
    host.revealUntil = Date.now() + REVEAL_MS;
    host.timer = setTimeout(hostStartRound, REVEAL_MS);
  }
  hostBroadcast();
}

function hostHandle(msg, peerId) {
  const pid = peerId ? host.players.find(p => p.peer === peerId)?.id : myPid;
  switch (msg.t) {
    case 'hello': {
      if (!peerId || typeof msg.pid !== 'string') return;
      if (!addPlayer(msg.pid.slice(0, 64), clean(msg.name, MAX_NAME), peerId)) {
        return chan.send({ t: 'error', msg: host.phase === 'lobby' ? '房間已滿' : '遊戲已經開始了' }, { target: peerId });
      }
      if (host.phase === 'lobby' && host.players.length === host.size) hostStartRound(); else hostBroadcast();
      break;
    }
    case 'submit': {
      if (!pid || host.phase !== 'playing' || host.current[pid] != null) return;   // 提交後不可修改
      const word = clean(msg.word, MAX_WORD);
      if (!word || !norm(word)) return;
      host.current[pid] = word;
      if (host.players.every(p => host.current[p.id] != null)) hostReveal(); else hostBroadcast();
      break;
    }
    case 'again': {
      if (host.phase !== 'won') return;
      clearTimeout(host.timer);
      Object.assign(host, { phase: 'lobby', round: 0, current: null, prev: null, history: [], deadline: 0, revealUntil: 0 });
      if (host.players.length === host.size) hostStartRound(); else hostBroadcast();
      break;
    }
    case 'leave': {
      if (!pid || pid === myPid || host.phase !== 'lobby') return;
      host.players = host.players.filter(p => p.id !== pid);
      hostBroadcast();
      break;
    }
  }
}

// ---------- 進出房間 ----------
const urlCode = () => (new URLSearchParams(location.search).get('r') || '').toUpperCase();
function setUrl(code) { const u = new URL(location.href); if (code) u.searchParams.set('r', code); else u.searchParams.delete('r'); history.replaceState(null, '', u); }

function startAsHost(code, size, seconds) {
  if (!restoreHost(code)) createHost(code, size, seconds);
  setUrl(code);
  connect(code);
  hostBroadcast();
}

function joinAsGuest(code) {
  host = null;
  setUrl(code);
  show('connecting');
  $('connMsg').textContent = `正在連到房間 ${code}…`;
  connect(code);
  joinTimer = setTimeout(() => goHome('找不到這個房間，或房主已經離開'), HOST_WAIT_MS);
}

function goHome(errMsg) {
  if (host && host.phase === 'lobby') {/* 房主離開大廳：房間就此解散 */}
  else if (!host && chan && hostPeer && view?.phase === 'lobby') act({ t: 'leave' });
  if (host) { clearTimeout(host.timer); session.del('host:' + host.code); }
  disconnect(); stopMatch();
  host = null; view = null;
  setUrl(null); clearInterval(tick); banner();
  show('home');
  switchTab(errMsg && urlCode() ? 'join' : currentTab);
  err(errMsg);
}

// ---------- 隨機配對（公共大廳裡兩兩配對，peerId 小的當房主） ----------
let lobby = null;
function startMatch() {
  stopMatch();
  show('matching');
  lobby = joinRoom({ appId: APP_ID }, 'match-lobby');
  const pair = lobby.makeAction('p');
  let stateM = 'free', pendingTo = null, offerCode = null, offerTimer = null;
  const tryOffer = () => {
    if (stateM !== 'free' || !lobby) return;
    const target = Object.keys(lobby.getPeers()).filter(id => selfId < id).sort()[0];
    if (!target) return;
    stateM = 'offering'; pendingTo = target; offerCode = newCode();
    pair.send({ t: 'offer', code: offerCode }, { target });
    offerTimer = setTimeout(() => { if (stateM === 'offering') { stateM = 'free'; pendingTo = null; } }, 5000);
  };
  const finish = (code, asHost) => { stopMatch(); asHost ? startAsHost(code, 2, 60) : joinAsGuest(code); };
  lobby.onPeerJoin = () => tryOffer();
  pair.onMessage = (d, { peerId }) => {
    if (d?.t === 'offer' && typeof d.code === 'string') {
      if (stateM === 'free') { stateM = 'done'; pair.send({ t: 'ok' }, { target: peerId }).finally(() => finish(d.code.slice(0, 4), false)); }
      else pair.send({ t: 'no' }, { target: peerId });
    } else if (d?.t === 'ok' && stateM === 'offering' && peerId === pendingTo) {
      clearTimeout(offerTimer); stateM = 'done'; finish(offerCode, true);
    } else if (d?.t === 'no' && peerId === pendingTo) {
      clearTimeout(offerTimer); stateM = 'free'; pendingTo = null; setTimeout(tryOffer, 300 + Math.random() * 700);
    }
  };
  lobby.retry = setInterval(tryOffer, 4000);
}
function stopMatch() { if (lobby) { clearInterval(lobby.retry); lobby.leave(); lobby = null; } }

// ---------- 畫面 ----------
let tick = null, currentTab = 'create';
const opts = { size: 2, seconds: 60 };
function show(id) { for (const s of ['home', 'matching', 'connecting', 'lobby', 'game', 'reveal', 'won']) $(s)?.classList.toggle('hidden', s !== id); }
function err(msg) { $('err').textContent = msg || ''; }
function banner(msg) { $('banner').textContent = msg || ''; $('banner').classList.toggle('hidden', !msg); }

function receiveView(s) {
  const now = Date.now();
  s.deadline = now + s.remaining;
  s.revealUntil = now + s.revealLeft;
  view = s;
  render();
}

function playerList(el, withStatus) {
  const s = view;
  el.innerHTML = s.players.map(p => `<li><span class="dot ${p.online ? 'on' : ''}"></span>${esc(p.name)}${p.id === myPid ? '（你）' : ''}${
    withStatus ? `<span class="st ${p.submitted ? 'done' : ''}">${p.submitted ? '已送出' : '思考中…'}</span>` : ''}</li>`).join('')
    + (withStatus ? '' : Array.from({ length: s.size - s.players.length }, () => '<li style="color:var(--muted)"><span class="dot"></span>等待加入…</li>').join(''));
}

function render() {
  clearInterval(tick);
  const s = view;
  if (s.phase === 'lobby') {
    show('lobby');
    $('lobbyCode').textContent = s.code;
    $('link').value = location.origin + location.pathname + '?r=' + s.code;
    playerList($('lobbyPlayers'), false);
    $('lobbyHint').textContent = `${s.size} 人房 · 每輪 ${s.seconds} 秒 · 還差 ${s.size - s.players.length} 人` + (host ? ' · 你是房主，請保持這個分頁開著' : '');
  } else if (s.phase === 'playing') {
    const wasHidden = $('game').classList.contains('hidden');
    show('game');
    $('roundNo').textContent = `第 ${s.round} 輪`;
    const first = !s.prev;
    $('prevBox').classList.toggle('hidden', first);
    $('firstPrompt').classList.toggle('hidden', !first);
    if (!first) $('prev').innerHTML = s.prev.map(w => `<span class="chip">${esc(w)}</span>`).join('<span class="plus">＋</span>');
    const done = s.mine != null;
    $('form').classList.toggle('hidden', done);
    $('sent').classList.toggle('hidden', !done);
    if (done) $('sentWord').textContent = s.mine;
    else if (wasHidden || $('form').dataset.round != s.round) { $('word').value = ''; $('form').dataset.round = s.round; $('word').focus(); }
    playerList($('gamePlayers'), true);
    const upd = () => {
      const left = Math.max(0, s.deadline - Date.now());
      $('timer').textContent = Math.ceil(left / 1000) + ' 秒';
      $('timer').classList.toggle('low', left < 10000);
      $('barFill').style.width = (left / (s.seconds * 1000) * 100) + '%';
    };
    upd(); tick = setInterval(upd, 250);
  } else if (s.phase === 'reveal') {
    show('reveal');
    const h = s.history[s.history.length - 1];
    $('revRound').textContent = `第 ${h.round} 輪揭曉`;
    $('revList').innerHTML = h.words.map((w, i) => `<div class="rv" style="animation-delay:${i * .25}s"><span class="n">${esc(w.name)}</span><span class="w ${w.word == null ? 'none' : ''}">${w.word == null ? '沒送出' : esc(w.word)}</span></div>`).join('');
    $('verdict').textContent = h.complete ? '還沒撞上，繼續聯想！' : '有人沒送出，這輪不算，用上一輪的詞重來';
    const upd = () => { $('revTimer').textContent = Math.max(0, Math.ceil((s.revealUntil - Date.now()) / 1000)) + ' 秒後下一輪'; };
    upd(); tick = setInterval(upd, 250);
  } else if (s.phase === 'won') {
    show('won');
    const h = s.history[s.history.length - 1];
    $('wonSub').textContent = `第 ${h.round} 輪，你們都寫了`;
    $('wonWord').textContent = h.words[0].word;
    $('hist').innerHTML = s.history.map(r => `<li><span class="r">#${r.round}</span><span class="${r.matched ? 'ok' : ''}">${r.words.map(w => esc(w.word ?? '—')).join(' · ')}</span></li>`).join('');
  }
}

function switchTab(t) {
  currentTab = t;
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  document.querySelectorAll('[data-pane]').forEach(p => p.classList.toggle('hidden', p.dataset.pane !== t));
  err();
}

// ---------- 事件 ----------
document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => switchTab(b.dataset.tab));
for (const [id, key] of [['size', 'size'], ['secs', 'seconds']]) {
  $(id).querySelectorAll('button').forEach(b => b.onclick = () => {
    $(id).querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    opts[key] = Number(b.dataset.v);
  });
}
$('btnCreate').onclick = () => { myName(); startAsHost(newCode(), opts.size, opts.seconds); };
$('btnJoin').onclick = () => {
  const c = $('code').value.trim().toUpperCase();
  if (!/^[A-Z0-9]{4}$/.test(c)) return err('房號是 4 碼英數');
  myName(); joinAsGuest(c);
};
$('code').onkeydown = (e) => { if (e.key === 'Enter') $('btnJoin').click(); };
$('btnMatch').onclick = () => { myName(); startMatch(); };
$('btnCancelMatch').onclick = () => { stopMatch(); show('home'); };
$('btnCancelConn').onclick = () => goHome();
$('btnCopy').onclick = async () => { try { await navigator.clipboard.writeText($('link').value); $('btnCopy').textContent = '已複製'; } catch { $('link').select(); } setTimeout(() => $('btnCopy').textContent = '複製', 1500); };
$('form').onsubmit = (e) => { e.preventDefault(); const w = $('word').value.trim(); if (w) act({ t: 'submit', word: w }); };
$('btnAgain').onclick = () => act({ t: 'again' });
$('btnHome').onclick = () => goHome();
$('btnLeave').onclick = () => goHome();
window.addEventListener('beforeunload', (e) => { if (host && host.phase !== 'lobby' && host.phase !== 'won') e.preventDefault(); });

// ---------- 啟動 ----------
const c0 = urlCode();
if (c0 && session.get('host:' + c0)) startAsHost(c0);              // 房主重新整理
else if (c0) {
  $('code').value = c0; switchTab('join');
  if (myName()) joinAsGuest(c0); else $('name').focus();          // 第一次從連結進來先填暱稱
}
