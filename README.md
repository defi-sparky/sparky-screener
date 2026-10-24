# Sparky Screener (Node 18+, no dependencies)
1. cp .env.example .env  and paste your RUGCHECK_API_KEY
2. npm start  ->  http://localhost:3000

Data: DexScreener + GeckoTerminal (market data, candles, ATH) and RugCheck (authorities, holders, insiders, LP lock).
Optional: GMGN_API_KEY + `npm install -g gmgn-cli` adds smart-money, sniper and bundler data.
Home page = paste-a-CA checker. /scanner.html = multi-token scanner.
If a column shows "?" open http://localhost:3000/api/debug/<token_address> to see the raw responses.
