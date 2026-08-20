/**
 * Auto-attach holds every target related to the page before its first line
 * (src/network-monitor.ts), so the resume decides whether the target ever runs.
 * A service worker's Network.enable responds only once the target runs, so a
 * resume that waits on that response never arrives and the registration that
 * started the worker never settles.
 *
 * This drives the built NetworkMonitor against real Chrome, which the vitest
 * suite never does (src/persistent-profiles.test.ts:11). Needs a build first.
 * Run it whenever the Target.attachedToTarget handler changes.
 */
import http from 'node:http';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const require = createRequire(path.join(repo, 'package.json'));
const puppeteer = require('puppeteer-core');
const { NetworkMonitor } = await import(path.join(repo, 'build/network-monitor.js'));

/** Same paths as ChromeLauncher.getChromePath (src/chrome-launcher.ts:281). */
function chromePath() {
  switch (os.platform()) {
    case 'darwin': return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    case 'win32': return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    case 'linux': return '/usr/bin/google-chrome';
    default: throw new Error(`Unsupported platform: ${os.platform()}`);
  }
}

const PORT = Number(process.env.CHECK_PORT || 45901);
const BUDGET_MS = 8000;

const server = http.createServer((req, res) => {
  const body = {
    '/': ['text/html', '<!doctype html><meta charset=utf-8><title>target resume</title>ok'],
    '/sw.js': ['text/javascript', `self.addEventListener('install', () => self.skipWaiting());`],
    '/worker.js': ['text/javascript', `self.postMessage('up');`],
  }[req.url];
  if (!body) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('nope'); return; }
  res.writeHead(200, { 'content-type': body[0] });
  res.end(body[1]);
});
await new Promise((resolve) => server.listen(PORT, resolve));

const browser = await puppeteer.launch({
  executablePath: chromePath(),
  headless: !process.argv.includes('--headful'),
  args: ['--no-first-run', '--no-default-browser-check'],
});

const results = [];
try {
  const page = (await browser.pages())[0] || await browser.newPage();
  new NetworkMonitor().startMonitoring(page);
  // startSocketMonitoring arms the auto-attach behind two awaits.
  await new Promise((resolve) => setTimeout(resolve, 300));
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });

  const cases = [
    ['service worker registers', 'resolved', `async () => {
      const r = await Promise.race([
        navigator.serviceWorker.register('/sw.js').then(() => 'resolved', e => 'rejected: ' + e.message),
        new Promise(r => setTimeout(() => r('TIMEOUT'), ${BUDGET_MS})),
      ]);
      return r;
    }`],
    ['missing script rejects', 'rejected-404', `async () => {
      const r = await Promise.race([
        navigator.serviceWorker.register('/missing.js').then(
          () => 'resolved',
          e => /404/.test(e.message) ? 'rejected-404' : 'rejected: ' + e.message),
        new Promise(r => setTimeout(() => r('TIMEOUT'), ${BUDGET_MS})),
      ]);
      return r;
    }`],
    ['dedicated worker runs', 'message:up', `async () => {
      const w = new Worker('/worker.js');
      const r = await Promise.race([
        new Promise(r => { w.onmessage = e => r('message:' + e.data); }),
        new Promise(r => setTimeout(() => r('TIMEOUT'), ${BUDGET_MS})),
      ]);
      return r;
    }`],
  ];

  for (const [name, expected, body] of cases) {
    const started = Date.now();
    const got = await page.evaluate(`(${body})()`);
    results.push({ name, expected, got, ms: Date.now() - started });
  }
} finally {
  await browser.close();
  server.close();
}

let failed = 0;
for (const r of results) {
  const ok = r.got === r.expected;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(26)} ${String(r.ms + 'ms').padStart(7)}  got ${JSON.stringify(r.got)}${ok ? '' : `, expected ${JSON.stringify(r.expected)}`}`);
}
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
