// Local runner only (npm start). Vercel uses the functions in /api instead.
const http = require('http');
const { handler, KEY, PORT } = require('./lib/core.js');
http.createServer(handler).listen(PORT, '127.0.0.1', () =>
  console.log(`Sparky Screener on http://localhost:${PORT}  (GMGN key ${KEY ? 'loaded' : 'not set, optional'})`));
