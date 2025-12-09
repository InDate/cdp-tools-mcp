#!/usr/bin/env node
// Server that starts immediately (port reported in <1 second)
const http = require('http');

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Fast server running!\n');
});

const PORT = 4001;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
