/**
 * Runners Index
 * Export all runner types and factory function
 */

export * from './types.js';
export { NativeRunner } from './native-runner.js';
export { DockerRunner, resetDockerCheck } from './docker-runner.js';
export { DockerComposeRunner, resetComposeCheck } from './docker-compose-runner.js';

import type { Runner, RunnerType } from './types.js';
import { NativeRunner } from './native-runner.js';
import { DockerRunner, resetDockerCheck } from './docker-runner.js';
import { DockerComposeRunner, resetComposeCheck } from './docker-compose-runner.js';

/**
 * Create a runner instance based on type
 */
export function createRunner(type: RunnerType, id: string): Runner {
  switch (type) {
    case 'native':
      return new NativeRunner(id);
    case 'docker':
      return new DockerRunner(id);
    case 'docker-compose':
      return new DockerComposeRunner(id);
    default:
      throw new Error(`Unknown runner type: ${type}`);
  }
}

/**
 * Reset Docker availability caches.
 * Called before autoRun to ensure Docker is checked fresh each time.
 */
export function resetDockerCaches(): void {
  resetDockerCheck();
  resetComposeCheck();
}
