#!/usr/bin/env node
// Server that takes 50 seconds to start (exceeds 30s timeout, will trigger blocking)
const http = require('http');

console.log('Starting very slow server (50s delay)...');
console.log('Performing extensive initialization...');

setTimeout(() => {
  console.log('Loading modules...');
}, 10000);

setTimeout(() => {
  console.log('Connecting to database...');
}, 20000);

setTimeout(() => {
  console.log('Warming up cache...');
}, 30000);

setTimeout(() => {
  console.log('Almost ready...');
}, 40000);

setTimeout(() => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Very slow server (50s) running!\n');
  });

  const PORT = 4003;
  server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}, 50000);
