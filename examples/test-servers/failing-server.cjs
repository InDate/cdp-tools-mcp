#!/usr/bin/env node
// Server that fails immediately on startup
console.log('Starting failing server...');
console.log('Checking configuration...');

setTimeout(() => {
  console.error('ERROR: Critical configuration missing!');
  console.error('Cannot start server without DATABASE_URL environment variable.');
  process.exit(1);
}, 500);
