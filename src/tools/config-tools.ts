/**
 * Config Tools
 * MCP tools for managing cdp-tools configuration
 */

import { z } from 'zod';
import { createTool } from '../validation-helpers.js';
import { configManager } from '../config.js';
import { createSuccessResponse, createErrorResponse } from '../messages.js';

const configSchema = z.object({
  action: z.enum(['status', 'useLocal', 'useGlobal', 'reset', 'backup', 'cloneFromGlobal', 'show', 'listTools', 'reload'])
    .describe('Config action: status (show config location info), useLocal (switch to project config), useGlobal (switch to global config), reset (reset to defaults), backup (backup current config), cloneFromGlobal (copy global to local), show (display current config), listTools (list all toggleable tools with status and dependencies), reload (re-read config.json from disk now - also happens automatically on file edits)'),
  seedFromGlobal: z.boolean().optional()
    .describe('For useLocal action: if true (default), seeds new local config from global if it exists'),
  path: z.string().optional()
    .describe('useLocal: explicit project dir to use as "local" (overrides server cwd)'),
}).strict();

type ConfigArgs = z.infer<typeof configSchema>;

export function createConfigTools() {
  return {
    config: createTool(
      'Manage cdp-tools configuration. Actions: status (show where config is loaded from), useLocal (switch to project-local config), useGlobal (switch to global ~/.cdp-tools config), reset (reset to defaults), backup (create timestamped backup), cloneFromGlobal (copy global config to local), show (display current settings), listTools (list all toggleable tools with their status and dependencies), reload (re-read config.json now; edits also hot-reload automatically within ~250ms)',
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
            try {
              const result = await configManager.useLocal(seedFromGlobal, args.path);
              return createSuccessResponse('CONFIG_USE_LOCAL_SUCCESS', {
                path: result.path,
                seeded: result.seeded,
              });
            } catch (error) {
              return createErrorResponse('CONFIG_USE_LOCAL_FAILED', {
                error: error instanceof Error ? error.message : String(error),
              });
            }
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

          case 'reload': {
            const result = await configManager.reload();
            return createSuccessResponse('CONFIG_RELOAD', {
              changed: result.changed,
              path: result.path || 'in-memory defaults (no file)',
            });
          }

          case 'listTools': {
            const tools = configManager.getToggleableTools();
            const conflicts = configManager.getDependencyConflicts();
            const toolsJson = JSON.stringify(tools, null, 2);
            if (conflicts.length > 0) {
              return createErrorResponse('TOOLS_LIST_CONFLICT', {
                toolsJson,
                conflicts,
              });
            }
            return createSuccessResponse('TOOLS_LIST', {
              toolsJson,
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
