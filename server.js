require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const STATE_FILE = path.join(__dirname, 'state.json');

app.use(express.static(path.join(__dirname)));
app.use(express.json());

app.get('/api/config', (req, res) => {
  res.json({
    jwt: process.env.SE_JWT || '',
    channel: process.env.SE_CHANNEL || '',
    timerStart: parseInt(process.env.TIMER_START_SECONDS) || 7200,
    secsT1: parseInt(process.env.SECS_T1_SUB) || 300,
    secsT2: parseInt(process.env.SECS_T2_SUB) || 600,
    secsT3: parseInt(process.env.SECS_T3_SUB) || 900,
    secsPer100Bits: parseInt(process.env.SECS_PER_100_BITS) || 30,
    secsPerDollar: parseInt(process.env.SECS_PER_DOLLAR_DONATION) || 60,
  });
});

app.get('/api/state', (req, res) => {
  if (fs.existsSync(STATE_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      return res.json(data);
    } catch (_) { /* fall through to env seeds */ }
  }
  res.json({
    subs: parseInt(process.env.SEED_SUBS) || 0,
    bits: parseInt(process.env.SEED_BITS) || 0,
    gifted: 0,
    events: 0,
  });
});

app.post('/api/state', (req, res) => {
  const { subs, bits, gifted, events, timerRemaining } = req.body;
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ subs, bits, gifted, events, timerRemaining }), 'utf8');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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
  twitchTokenExpiry = Date.now() + (data.expires_in - 300) * 1000; // refresh 5 min early
  return twitchToken;
}

async function checkLiveStatus() {
  const channel = process.env.SE_CHANNEL;
  if (!channel) return;
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
  }
}

const twitchConfigured = !!(process.env.TWITCH_CLIENT_ID && process.env.TWITCH_CLIENT_SECRET);
if (twitchConfigured) {
  checkLiveStatus();
  setInterval(checkLiveStatus, 60_000);
}

app.get('/api/live-status', (req, res) => {
  // If credentials aren't set, treat as always live so the timer still runs
  res.json({ live: twitchConfigured ? isLive : true, configured: twitchConfigured });
});

app.get('/overlay', (_req, res) => {
  res.sendFile(path.join(__dirname, 'overlay.html'));
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Subathon Tracker running on port ${PORT}`);
});
