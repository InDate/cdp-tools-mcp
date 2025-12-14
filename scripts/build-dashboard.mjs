#!/usr/bin/env node

/**
 * Build script for the dashboard frontend
 * Bundles Preact app into a single JS file
 */

import * as esbuild from 'esbuild';
import { mkdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

const outDir = join(rootDir, 'build', 'dashboard');

// Ensure output directory exists
if (!existsSync(outDir)) {
  mkdirSync(outDir, { recursive: true });
}

try {
  await esbuild.build({
    entryPoints: [join(rootDir, 'src', 'dashboard', 'frontend', 'app.tsx')],
    bundle: true,
    minify: true,
    outfile: join(outDir, 'bundle.js'),
    format: 'esm',
    target: ['es2020'],
    jsx: 'automatic',
    jsxImportSource: 'preact',
    define: {
      'process.env.NODE_ENV': '"production"',
    },
  });

  console.log('Dashboard frontend built successfully');
} catch (error) {
  console.error('Dashboard build failed:', error);
  process.exit(1);
}
