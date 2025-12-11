#!/usr/bin/env node

/**
 * Test script to verify MCP server loads and registers tools correctly
 * Run this after building to catch schema issues before deployment
 * Also measures token usage for tool definitions
 */

import { spawn } from 'child_process';

const TIMEOUT_MS = 10000;

/**
 * Estimate token count for a string using cl100k_base approximation
 * ~4 characters per token for English text, ~3 for JSON/code
 * This is a rough estimate - actual tokenization varies
 */
function estimateTokens(text) {
  if (!text) return 0;
  const str = typeof text === 'string' ? text : JSON.stringify(text);
  // JSON/code tends to be ~3 chars per token due to punctuation
  // But descriptions are ~4 chars per token
  // Use 3.5 as a middle ground
  return Math.ceil(str.length / 3.5);
}

/**
 * Calculate detailed token breakdown for a tool
 */
function analyzeToolTokens(tool) {
  const nameTokens = estimateTokens(tool.name);
  const descTokens = estimateTokens(tool.description);
  const schemaTokens = estimateTokens(tool.inputSchema);

  return {
    name: tool.name,
    total: nameTokens + descTokens + schemaTokens,
    breakdown: {
      name: nameTokens,
      description: descTokens,
      schema: schemaTokens
    },
    chars: {
      name: tool.name?.length || 0,
      description: tool.description?.length || 0,
      schema: JSON.stringify(tool.inputSchema)?.length || 0
    }
  };
}

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
        const tools = parsed.result.tools;
        const toolCount = tools.length;
        console.log(`✓ Successfully registered ${toolCount} tools`);

        // Verify key tools exist
        const toolNames = tools.map(t => t.name);
        const keyTools = ['launchChrome', 'navigate', 'breakpoint', 'replay'];
        const missing = keyTools.filter(t => !toolNames.includes(t));

        if (missing.length > 0) {
          console.error('✗ Missing expected tools:', missing.join(', '));
          serverProcess.kill();
          process.exit(1);
        }

        console.log('✓ All key tools registered');

        // Token analysis
        const toolAnalysis = tools.map(analyzeToolTokens);
        const totalTokens = toolAnalysis.reduce((sum, t) => sum + t.total, 0);
        const totalChars = toolAnalysis.reduce((sum, t) =>
          sum + t.chars.name + t.chars.description + t.chars.schema, 0);

        // Sort by token usage
        const sortedByTokens = [...toolAnalysis].sort((a, b) => b.total - a.total);

        console.log('');
        console.log('=== Tool Token Analysis ===');
        console.log(`Total estimated tokens: ${totalTokens.toLocaleString()}`);
        console.log(`Total characters: ${totalChars.toLocaleString()}`);
        console.log(`Average tokens per tool: ${Math.round(totalTokens / toolCount)}`);
        console.log('');
        console.log('Top 10 tools by token usage:');
        for (const tool of sortedByTokens.slice(0, 10)) {
          console.log(`  ${tool.name}: ${tool.total} tokens (desc: ${tool.breakdown.description}, schema: ${tool.breakdown.schema})`);
        }

        // Category breakdown
        const descTokens = toolAnalysis.reduce((sum, t) => sum + t.breakdown.description, 0);
        const schemaTokens = toolAnalysis.reduce((sum, t) => sum + t.breakdown.schema, 0);
        console.log('');
        console.log('Breakdown by category:');
        console.log(`  Descriptions: ${descTokens.toLocaleString()} tokens (${Math.round(descTokens/totalTokens*100)}%)`);
        console.log(`  Schemas: ${schemaTokens.toLocaleString()} tokens (${Math.round(schemaTokens/totalTokens*100)}%)`);

        console.log('');
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
