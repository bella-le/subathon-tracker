# Subathon Tracker

Live subathon dashboard powered by StreamElements. Tracks subs and bits in real time.

## Deploy to Railway

### Option A — GitHub (recommended)

1. Push this folder to a GitHub repo
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub repo
3. Select your repo — Railway auto-detects Node.js and runs `npm start`
4. Your dashboard will be live at the Railway URL in ~1 minute

### Option B — Railway CLI

```bash
npm install -g @railway/cli
railway login
railway init
railway up
```

## Usage

1. Open your Railway URL
2. Enter your Twitch channel name
3. Paste your StreamElements JWT token
   - Get it at: streamelements.com/dashboard → Account Settings → Channels → Show Secret
4. Adjust the start time if needed (defaults to 12:30 PM EST today)
5. Click Start Tracking

## Notes

- Polls StreamElements every 20 seconds
- Tracks: subscribers, gifted subs, bits/cheers
- All events are deduplicated — no double-counting
- JWT token is never stored or sent anywhere except StreamElements API
