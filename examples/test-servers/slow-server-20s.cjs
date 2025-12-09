#!/usr/bin/env node
// Server that takes 20 seconds to start (should complete within 30s timeout)
const http = require('http');

console.log('Starting slow server (20s delay)...');
console.log('Initializing...');

setTimeout(() => {
  console.log('Still initializing...');
}, 5000);

setTimeout(() => {
  console.log('Almost ready...');
}, 15000);

setTimeout(() => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Slow server (20s) running!\n');
  });

  const PORT = 4002;
  server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}, 20000);
