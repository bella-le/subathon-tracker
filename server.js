require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const ioClient = require('socket.io-client');

const app = express();
const PORT = process.env.PORT || 3000;
const STATE_FILE = path.join(__dirname, 'state.json');

// ── Timer config ──────────────────────────────────────────
const timerCfg = {
  start:       parseInt(process.env.TIMER_START_SECONDS)    || 7200,
  t1:          parseInt(process.env.SECS_T1_SUB)            || 300,
  t2:          parseInt(process.env.SECS_T2_SUB)            || 600,
  t3:          parseInt(process.env.SECS_T3_SUB)            || 900,
  per100Bits:  parseInt(process.env.SECS_PER_100_BITS)      || 30,
  perDollar:   parseInt(process.env.SECS_PER_DOLLAR_DONATION) || 60,
};

const twitchConfigured = !!(process.env.TWITCH_CLIENT_ID && process.env.TWITCH_CLIENT_SECRET);

// ── State ─────────────────────────────────────────────────
let state = { subs: 0, bits: 0, gifted: 0, events: 0, timerRemaining: timerCfg.start };
try {
  const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  state = { ...state, ...saved };
} catch (_) {
  state.subs = parseInt(process.env.SEED_SUBS) || 0;
  state.bits = parseInt(process.env.SEED_BITS) || 0;
}

function saveState() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state), 'utf8'); } catch (e) {
    console.error('Failed to save state:', e.message);
  }
}

setInterval(saveState, 60_000);

// ── Express ───────────────────────────────────────────────
app.use(express.static(path.join(__dirname)));
app.use(express.json());

app.get('/api/config', (_req, res) => {
  res.json({
    channel:       process.env.SE_CHANNEL || '',
    timerStart:    timerCfg.start,
    secsT1:        timerCfg.t1,
    secsT2:        timerCfg.t2,
    secsT3:        timerCfg.t3,
    secsPer100Bits: timerCfg.per100Bits,
    secsPerDollar:  timerCfg.perDollar,
  });
});

app.get('/api/state', (_req, res) => res.json(state));

// ── SSE ───────────────────────────────────────────────────
const sseClients = new Set();

app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

function broadcast(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of sseClients) client.write(data);
}

// ── SE Socket ─────────────────────────────────────────────
let seSocket = null;
let seConnected = false;
const seenIds = new Set();

function handleSEEvent(ev) {
  const id = ev._id || ev.activityId;
  if (id && seenIds.has(id)) return;
  if (id) seenIds.add(id);

  const type = ev.type || '';
  const d = ev.data || {};
  const user = d.username || d.displayName || d.name || 'Anonymous';
  const ts = ev.createdAt || new Date().toISOString();

  if (type === 'subscriber') {
    state.subs++;
    const tierNum = Number(d.tier || 1000);
    const tierIdx = Math.ceil(tierNum / 1000);
    const gifted = !!(d.gifted || d.isCommunityGift || d.gifter);
    if (gifted) state.gifted++;
    state.timerRemaining += [0, timerCfg.t1, timerCfg.t2, timerCfg.t3][tierIdx] || timerCfg.t1;
    broadcast({ type, user: gifted ? (d.gifter || user) : user, target: user, tier: tierIdx, gifted, ts });
  } else if (type === 'cheer') {
    const amount = Number(d.amount || d.bits || 0);
    state.bits += amount;
    state.timerRemaining += Math.floor(amount / 100) * timerCfg.per100Bits;
    broadcast({ type, user, amount, ts });
  } else if (type === 'tip') {
    const amount = Number(d.amount || 0);
    state.timerRemaining += Math.floor(amount) * timerCfg.perDollar;
    broadcast({ type, user, amount, ts });
  } else {
    return;
  }

  state.events++;
  saveState();
}

function connectSE() {
  if (seSocket) return;
  const jwt = process.env.SE_JWT;
  if (!jwt) { console.error('SE_JWT not set'); return; }

  seSocket = ioClient('https://realtime.streamelements.com', { transports: ['websocket'] });
  seSocket.on('connect', () => seSocket.emit('authenticate', { method: 'jwt', token: jwt }));
  seSocket.on('authenticated', () => { seConnected = true; console.log('StreamElements connected'); });
  seSocket.on('unauthorized', () => { seConnected = false; console.error('StreamElements auth failed'); });
  seSocket.on('event', handleSEEvent);
  seSocket.on('disconnect', () => { seConnected = false; console.log('StreamElements disconnected'); });
}

function disconnectSE() {
  if (seSocket) { seSocket.disconnect(); seSocket = null; seConnected = false; }
}

// ── Timer tick ────────────────────────────────────────────
let timerTickInterval = null;

function startTimerTick() {
  if (timerTickInterval) return;
  timerTickInterval = setInterval(() => {
    if (state.timerRemaining > 0) state.timerRemaining--;
  }, 1000);
}

function stopTimerTick() {
  if (timerTickInterval) { clearInterval(timerTickInterval); timerTickInterval = null; }
}

// ── Twitch live status ────────────────────────────────────
let twitchToken = null;
let twitchTokenExpiry = 0;
let isLive = false;

async function getTwitchToken() {
  if (twitchToken && Date.now() < twitchTokenExpiry) return twitchToken;
  const res = await fetch(
    `https://id.twitch.tv/oauth2/token?client_id=${process.env.TWITCH_CLIENT_ID}&client_secret=${process.env.TWITCH_CLIENT_SECRET}&grant_type=client_credentials`,
    { method: 'POST' }
  );
  const data = await res.json();
  twitchToken = data.access_token;
  twitchTokenExpiry = Date.now() + (data.expires_in - 300) * 1000;
  return twitchToken;
}

async function checkLiveStatus() {
  const channel = process.env.SE_CHANNEL;
  if (!channel) return;
  const wasLive = isLive;
  try {
    const token = await getTwitchToken();
    const res = await fetch(
      `https://api.twitch.tv/helix/streams?user_login=${encodeURIComponent(channel)}`,
      { headers: { 'Client-ID': process.env.TWITCH_CLIENT_ID, 'Authorization': `Bearer ${token}` } }
    );
    const data = await res.json();
    isLive = Array.isArray(data.data) && data.data.length > 0;
  } catch (e) {
    console.error('Twitch status check failed:', e.message);
    return;
  }

  if (isLive && !wasLive) {
    console.log('Stream live — connecting SE, starting timer');
    connectSE();
    startTimerTick();
  } else if (!isLive && wasLive) {
    console.log('Stream offline — disconnecting SE, stopping timer');
    disconnectSE();
    stopTimerTick();
    saveState();
  }
}

app.get('/api/live-status', (_req, res) => {
  res.json({ live: twitchConfigured ? isLive : true, configured: twitchConfigured, seConnected });
});

if (twitchConfigured) {
  checkLiveStatus();
  setInterval(checkLiveStatus, 60_000);
} else {
  connectSE();
  startTimerTick();
}

app.get('/overlay', (_req, res) => res.sendFile(path.join(__dirname, 'overlay.html')));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(PORT, () => console.log(`Subathon Tracker running on port ${PORT}`));
