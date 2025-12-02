/**
 * Config Tools
 * MCP tools for managing cdp-tools configuration
 */

import { z } from 'zod';
import { createTool } from '../validation-helpers.js';
import { configManager } from '../config.js';
import { createSuccessResponse, createErrorResponse } from '../messages.js';

const configSchema = z.object({
  action: z.enum(['status', 'useLocal', 'useGlobal', 'reset', 'backup', 'cloneFromGlobal', 'show'])
    .describe('Config action: status (show config location info), useLocal (switch to project config), useGlobal (switch to global config), reset (reset to defaults), backup (backup current config), cloneFromGlobal (copy global to local), show (display current config)'),
  seedFromGlobal: z.boolean().optional()
    .describe('For useLocal action: if true (default), seeds new local config from global if it exists'),
}).strict();

type ConfigArgs = z.infer<typeof configSchema>;

export function createConfigTools() {
  return {
    config: createTool(
      'Manage cdp-tools configuration. Actions: status (show where config is loaded from), useLocal (switch to project-local config), useGlobal (switch to global ~/.cdp-tools config), reset (reset to defaults), backup (create timestamped backup), cloneFromGlobal (copy global config to local), show (display current settings)',
      configSchema,
      async (args: ConfigArgs) => {
        switch (args.action) {
          case 'status': {
            const status = configManager.getStatus();
            return createSuccessResponse('CONFIG_STATUS', {
              loadedFrom: status.loadedFrom || 'In-memory defaults (no file)',
              location: status.isLocal ? 'local (project)' : 'global (~/.cdp-tools)',
              localPath: status.localPath,
              globalPath: status.globalPath,
              localExists: status.localExists ? 'yes' : 'no',
              globalExists: status.globalExists ? 'yes' : 'no',
            });
          }

          case 'useLocal': {
            const seedFromGlobal = args.seedFromGlobal !== false; // default true
            const result = await configManager.useLocal(seedFromGlobal);
            return createSuccessResponse('CONFIG_USE_LOCAL_SUCCESS', {
              path: result.path,
              seeded: result.seeded,
            });
          }

          case 'useGlobal': {
            const result = await configManager.useGlobal();
            return createSuccessResponse('CONFIG_USE_GLOBAL_SUCCESS', {
              path: result.path,
            });
          }

          case 'reset': {
            await configManager.reset();
            return createSuccessResponse('CONFIG_RESET_SUCCESS', {});
          }

          case 'backup': {
            const result = await configManager.backup();
            if (!result) {
              return createErrorResponse('CONFIG_BACKUP_FAILED', {});
            }
            return createSuccessResponse('CONFIG_BACKUP_SUCCESS', {
              path: result.path,
            });
          }

          case 'cloneFromGlobal': {
            const result = await configManager.cloneFromGlobal();
            if ('error' in result) {
              return createErrorResponse('CONFIG_CLONE_NO_GLOBAL', {});
            }
            return createSuccessResponse('CONFIG_CLONE_SUCCESS', {
              path: result.path,
            });
          }

          case 'show': {
            const config = configManager.getConfig();
            return createSuccessResponse('CONFIG_SHOW', {
              config: JSON.stringify(config, null, 2),
            });
          }

          default: {
            const _exhaustive: never = args.action;
            return createErrorResponse('UNKNOWN_ACTION', { action: args.action });
          }
        }
      }
    ),
  };
}
