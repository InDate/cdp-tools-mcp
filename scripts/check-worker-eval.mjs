/**
 * Evaluation and console inside a worker target, against real Chrome. The
 * vitest suite never spawns Chrome (src/persistent-profiles.test.ts:11), so
 * this covers what the fakes cannot: that a service worker is listed, that a
 * client on it evaluates in ServiceWorkerGlobalScope, and that its console
 * output is recorded. Needs a build first.
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
const { WorkerTargetRegistry } = await import(path.join(repo, 'build/worker-targets.js'));

function chromePath() {
  switch (os.platform()) {
    case 'darwin': return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    case 'win32': return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    case 'linux': return '/usr/bin/google-chrome';
    default: throw new Error(`Unsupported platform: ${os.platform()}`);
  }
}

const PORT = Number(process.env.CHECK_PORT || 45906);
const SW = `
  self.addEventListener('install', () => self.skipWaiting());
  self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
  self.addEventListener('fetch', () => {});
`;

const server = http.createServer((req, res) => {
  const body = {
    '/': ['text/html', '<!doctype html><meta charset=utf-8><title>worker eval</title>ok'],
    '/sw.js': ['text/javascript', SW],
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
const check = (name, expected, got) => results.push({ name, expected, got });

let registry;
try {
  const page = (await browser.pages())[0] || await browser.newPage();
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });
  await page.evaluate(async () => {
    await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
  });

  const port = Number(new URL(browser.wsEndpoint()).port);
  registry = new WorkerTargetRegistry('localhost', port);

  const targets = await registry.list();
  check('service worker listed', 'service_worker', targets.map((t) => t.type).find((t) => t === 'service_worker') ?? 'none');

  check(
    'evaluates in worker scope',
    'ServiceWorkerGlobalScope',
    await registry.evaluate('/sw.js', 'self.constructor.name')
  );
  check(
    'reads worker state',
    `http://localhost:${PORT}/`,
    await registry.evaluate('/sw.js', 'self.registration.scope')
  );
  await registry.evaluate('/sw.js', `console.log('inside', 42)`);
  const messages = await registry.messages('/sw.js');
  check('records worker console', 'inside 42', messages.map((m) => m.text).pop() ?? 'none');

  let ambiguous = 'not refused';
  try {
    await registry.evaluate('no-such-worker.js', '1');
  } catch (e) {
    ambiguous = e.name === 'WorkerTargetNotFoundError' || e.name === 'WorkerTargetAmbiguousError' ? e.name : `other: ${e.name}`;
  }
  check('unmatched reference refused', 'WorkerTargetNotFoundError', ambiguous);
} finally {
  if (registry) await registry.dispose();
  await browser.close();
  server.close();
}

let failed = 0;
for (const r of results) {
  const ok = r.got === r.expected;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(28)} got ${JSON.stringify(r.got)}${ok ? '' : `, expected ${JSON.stringify(r.expected)}`}`);
}
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
