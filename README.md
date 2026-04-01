# Signal Bot Pro — Deploy Guide

## What's in this folder

- `server.js` — the backend that fetches real Binance data
- `package.json` — tells Railway what to install
- `public/index.html` — the dashboard your browser opens

---

## STEP 1 — Upload to GitHub (5 minutes)

1. Go to **github.com** and sign in
2. Click the **+** button (top right) → **New repository**
3. Name it: `signal-bot-pro`
4. Make sure it's set to **Public**
5. Click **Create repository**
6. On the next page, click **uploading an existing file**
7. Drag and drop ALL THREE files:
   - `server.js`
   - `package.json`
   - The `public` folder (containing `index.html`)
8. Click **Commit changes**

---

## STEP 2 — Deploy on Railway (3 minutes)

1. Go to **railway.app**
2. Click **Start a New Project**
3. Click **Deploy from GitHub repo**
4. Sign in with your GitHub account when prompted
5. Select **signal-bot-pro** from the list
6. Railway will automatically detect it's a Node.js app and deploy it
7. Wait about 2 minutes for the build to complete
8. Click **Settings** → **Domains** → **Generate Domain**
9. Railway gives you a URL like `signal-bot-pro.up.railway.app`

---

## STEP 3 — Open your bot

Visit the URL Railway gave you. Your bot is live with:
- Real Binance data (RSI, MACD, Bollinger Bands from actual klines)
- No CORS errors
- Auto-scans every 60 seconds
- Works from any browser, anywhere in the world

---

## That's it. No coding required.
