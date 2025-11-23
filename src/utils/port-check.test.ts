import { describe, it, expect } from 'vitest';
import { checkPort, parseUrlForPortCheck, checkUrlPort } from './port-check.js';

describe('port-check', () => {
  describe('parseUrlForPortCheck', () => {
    it('should parse localhost URL with explicit port', () => {
      const result = parseUrlForPortCheck('http://localhost:3000');
      expect(result).toEqual({ host: 'localhost', port: 3000 });
    });

    it('should parse 127.0.0.1 URL with explicit port', () => {
      const result = parseUrlForPortCheck('http://127.0.0.1:8080/path');
      expect(result).toEqual({ host: '127.0.0.1', port: 8080 });
    });

    it('should use default port 80 for http', () => {
      const result = parseUrlForPortCheck('http://localhost');
      expect(result).toEqual({ host: 'localhost', port: 80 });
    });

    it('should use default port 443 for https', () => {
      const result = parseUrlForPortCheck('https://example.com');
      expect(result).toEqual({ host: 'example.com', port: 443 });
    });

    it('should return null for invalid URL', () => {
      const result = parseUrlForPortCheck('not-a-url');
      expect(result).toBeNull();
    });

    it('should return null for file:// URLs', () => {
      const result = parseUrlForPortCheck('file:///path/to/file');
      expect(result).toBeNull();
    });
  });

  describe('checkPort', () => {
    it('should return open: false for closed port', async () => {
      // Port 59999 is very unlikely to be in use
      const result = await checkPort(59999, 'localhost', 500);
      expect(result.open).toBe(false);
      expect(result.port).toBe(59999);
      expect(result.host).toBe('localhost');
      expect(result.error).toBeDefined();
    });

    it('should timeout for unreachable host', async () => {
      // Use a short timeout and non-routable IP
      const result = await checkPort(80, '10.255.255.1', 100);
      expect(result.open).toBe(false);
    });
  });

  describe('checkUrlPort', () => {
    it('should return null for non-localhost URLs', async () => {
      const result = await checkUrlPort('https://example.com');
      expect(result).toBeNull();
    });

    it('should check localhost URLs', async () => {
      const result = await checkUrlPort('http://localhost:59999', 500);
      expect(result).not.toBeNull();
      expect(result?.open).toBe(false);
    });

    it('should check 127.0.0.1 URLs', async () => {
      const result = await checkUrlPort('http://127.0.0.1:59999', 500);
      expect(result).not.toBeNull();
      expect(result?.open).toBe(false);
    });

    it('should return null for invalid URL', async () => {
      const result = await checkUrlPort('not-a-url');
      expect(result).toBeNull();
    });
  });
});
