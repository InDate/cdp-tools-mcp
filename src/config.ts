/**
 * Configuration Manager
 * Manages user-editable configuration in .cdp-tools/config.json
 */

import * as fs from 'fs';
import { join } from 'path';
import { getOutputPath, setOutputDir } from './helpers/paths.js';
import { debugLog } from './debug-logger.js';

/**
 * Port monitoring frequency configuration - interval per level in ms
 */
export interface PortMonitoringFreqMs {
  block: number;
  error: number;
  inform: number;
}

/**
 * Port monitoring configuration
 */
export interface PortMonitoringConfig {
  portMonitoringFreqMs: PortMonitoringFreqMs;
}

/**
 * Root configuration structure
 */
export interface CdpToolsConfig {
  version: number;
  directoryPath: string;
  portMonitoring: PortMonitoringConfig;
}

/**
 * Default configuration values
 */
const DEFAULT_CONFIG: CdpToolsConfig = {
  version: 1,
  directoryPath: '.cdp-tools',
  portMonitoring: {
    portMonitoringFreqMs: {
      block: 1000,   // Fast detection for blocking
      error: 2000,   // Standard
      inform: 5000,  // Lower overhead for informational
    },
  },
};

/**
 * Configuration Manager
 * Loads and saves configuration from .cdp-tools/config.json
 */
export class ConfigManager {
  private config: CdpToolsConfig = { ...DEFAULT_CONFIG };
  private loaded = false;

  /**
   * Get the config file path (always in default .cdp-tools directory)
   * Config file location is fixed - directoryPath only affects other files
   */
  private getConfigPath(): string {
    return join(process.cwd(), '.cdp-tools', 'config.json');
  }

  /**
   * Load configuration from disk
   * Merges with defaults to handle missing fields
   * Note: Config is always loaded from .cdp-tools/config.json
   * The directoryPath setting affects where other files are stored
   */
  async load(): Promise<void> {
    const configPath = this.getConfigPath();

    try {
      if (fs.existsSync(configPath)) {
        const content = await fs.promises.readFile(configPath, 'utf-8');
        const loaded = JSON.parse(content);

        // Deep merge with defaults
        this.config = this.mergeConfig(DEFAULT_CONFIG, loaded);
        await debugLog('ConfigManager', `Loaded config from ${configPath}`);
      } else {
        // Create default config file
        this.config = { ...DEFAULT_CONFIG };
        await this.save();
        await debugLog('ConfigManager', `Created default config at ${configPath}`);
      }
    } catch (err) {
      await debugLog('ConfigManager', `Failed to load config: ${err}, using defaults`);
      this.config = { ...DEFAULT_CONFIG };
    }

    // Apply directoryPath to the paths helper
    setOutputDir(this.config.directoryPath);

    this.loaded = true;
  }

  /**
   * Deep merge two config objects
   */
  private mergeConfig(defaults: CdpToolsConfig, loaded: Partial<CdpToolsConfig>): CdpToolsConfig {
    return {
      version: loaded.version ?? defaults.version,
      directoryPath: loaded.directoryPath ?? defaults.directoryPath,
      portMonitoring: {
        portMonitoringFreqMs: {
          block: loaded.portMonitoring?.portMonitoringFreqMs?.block ?? defaults.portMonitoring.portMonitoringFreqMs.block,
          error: loaded.portMonitoring?.portMonitoringFreqMs?.error ?? defaults.portMonitoring.portMonitoringFreqMs.error,
          inform: loaded.portMonitoring?.portMonitoringFreqMs?.inform ?? defaults.portMonitoring.portMonitoringFreqMs.inform,
        },
      },
    };
  }

  /**
   * Save configuration to disk
   */
  async save(): Promise<void> {
    const configPath = this.getConfigPath();
    const dir = getOutputPath();

    if (!fs.existsSync(dir)) {
      await fs.promises.mkdir(dir, { recursive: true });
    }

    await fs.promises.writeFile(
      configPath,
      JSON.stringify(this.config, null, 2),
      'utf-8'
    );
  }

  /**
   * Get the full configuration
   */
  getConfig(): CdpToolsConfig {
    if (!this.loaded) {
      // Synchronous fallback - return defaults
      return { ...DEFAULT_CONFIG };
    }
    return this.config;
  }

  /**
   * Get port monitoring configuration
   */
  getPortMonitoringConfig(): PortMonitoringConfig {
    return this.getConfig().portMonitoring;
  }

  /**
   * Get the interval for a specific monitoring level
   */
  getIntervalForLevel(level: 'block' | 'error' | 'inform'): number {
    return this.getPortMonitoringConfig().portMonitoringFreqMs[level];
  }

  /**
   * Update port monitoring frequency configuration
   */
  async updatePortMonitoringFreqMs(updates: Partial<PortMonitoringFreqMs>): Promise<void> {
    this.config.portMonitoring.portMonitoringFreqMs = {
      ...this.config.portMonitoring.portMonitoringFreqMs,
      ...updates,
    };
    await this.save();
  }
}

// Export singleton instance
export const configManager = new ConfigManager();
