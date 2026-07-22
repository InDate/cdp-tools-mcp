/**
 * Tiny fixture process for child-manager.test.ts. Not part of the build -
 * run directly by Node during tests.
 *
 * argv[2] === 'ignore-sigterm': ignores SIGTERM so kill() must escalate to SIGKILL.
 * argv[2] === 'crash': exits non-zero immediately.
 * Otherwise: behaves normally (dies on SIGTERM).
 */
const mode = process.argv[2];

if (mode === 'ignore-sigterm') {
  process.on('SIGTERM', () => {
    // Deliberately do nothing.
  });
}

if (mode === 'crash') {
  process.exit(1);
}

// Stay alive until killed.
setInterval(() => {}, 1000 * 60 * 60);
