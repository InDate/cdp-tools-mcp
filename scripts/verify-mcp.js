#!/usr/bin/env node

/**
 * Test script to verify MCP server loads and registers tools correctly
 * Run this after building to catch schema issues before deployment
 */

import { spawn } from 'child_process';

const TIMEOUT_MS = 10000;

console.log('Testing MCP server tool registration...');

const serverProcess = spawn('node', ['build/index.js'], {
  stdio: ['pipe', 'pipe', 'pipe']
});

let hasReceivedResponse = false;
let hasError = false;
let buffer = '';

serverProcess.stdout.on('data', (data) => {
  buffer += data.toString();

  // Try to parse each line as JSON
  const lines = buffer.split('\n');
  buffer = lines.pop() || ''; // Keep incomplete line in buffer

  for (const line of lines) {
    if (!line.trim()) continue;

    try {
      const parsed = JSON.parse(line);

      // Check if it's a response to our tools/list request
      if (parsed.result && parsed.result.tools && Array.isArray(parsed.result.tools)) {
        hasReceivedResponse = true;
        const toolCount = parsed.result.tools.length;
        console.log(`✓ Successfully registered ${toolCount} tools`);

        // Verify key tools exist
        const toolNames = parsed.result.tools.map(t => t.name);
        const keyTools = ['launchChrome', 'navigateTo', 'setBreakpoint', 'printToPDF'];
        const missing = keyTools.filter(t => !toolNames.includes(t));

        if (missing.length > 0) {
          console.error('✗ Missing expected tools:', missing.join(', '));
          serverProcess.kill();
          process.exit(1);
        }

        console.log('✓ All key tools registered');
        console.log('✓ MCP server is healthy');
        serverProcess.kill();
        process.exit(0);
      }
    } catch (e) {
      // Not JSON, ignore
    }
  }
});

serverProcess.stderr.on('data', (data) => {
  const str = data.toString();
  // Look for port reservation which indicates successful startup
  if (str.includes('Reserved debug port')) {
    console.log('✓ MCP server started successfully');

    // Now send the tools/list request
    const request = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list'
    };

    serverProcess.stdin.write(JSON.stringify(request) + '\n');
  }
});

serverProcess.on('error', (err) => {
  console.error('✗ Failed to start MCP server:', err.message);
  hasError = true;
  process.exit(1);
});

serverProcess.on('exit', (code, signal) => {
  if (!hasReceivedResponse && !hasError) {
    console.error('✗ MCP server exited unexpectedly');
    process.exit(1);
  }
});

// Timeout check
setTimeout(() => {
  if (!hasReceivedResponse && !hasError) {
    console.error('✗ Test timed out - MCP server may have hung during startup');
    console.error('This often indicates a schema issue preventing tool registration');
    serverProcess.kill();
    process.exit(1);
  }
}, TIMEOUT_MS);
