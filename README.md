# Sparky Screener (Node 18+, no dependencies)
1. cp .env.example .env  and paste your RUGCHECK_API_KEY
2. npm start  ->  http://localhost:3000

Data: DexScreener + GeckoTerminal (market data, candles, ATH) and RugCheck (authorities, holders, insiders, LP lock).
Optional: GMGN_API_KEY + `npm install -g gmgn-cli` adds smart-money, sniper and bundler data.
Home page = paste-a-CA checker. /scanner.html = multi-token scanner.
If a column shows "?" open http://localhost:3000/api/debug/<token_address> to see the raw responses.

## Deploy on Vercel
1. Push to GitHub and import the repo in Vercel (no build command needed).
2. Project Settings > Environment Variables: add RUGCHECK_API_KEY (and GMGN_API_KEY if you have one), then redeploy.
3. The .env file is not uploaded, so the variables must be set in Vercel.
Notes: holder-growth history is stored in /tmp on Vercel, so "Holders growing" will often show Unknown. The gmgn-cli tool is not available on Vercel, so GMGN extras only work locally.
