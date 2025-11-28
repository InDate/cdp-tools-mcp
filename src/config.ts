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
 * Replay system configuration
 */
export interface ReplayConfig {
  /** Maximum nested conditional depth (default: 10) */
  maxConditionalDepth: number;
  /** Maximum regex pattern length for url:matches conditions (default: 500) */
  maxRegexLength: number;
}

/**
 * DOM change detection configuration
 */
export interface ChangeDetectionConfig {
  /** Enable automatic change detection on actions (default: true) */
  enabled: boolean;
  /** Max time to wait for mutations to settle in ms (default: 2000) */
  settleTimeout: number;
  /** Time of no mutations to consider settled in ms (default: 300) */
  quietPeriod: number;
  /** Longer timeout for page navigation in ms (default: 3000) */
  navigationTimeout: number;
}

/**
 * Click validation configuration for replay sequences
 */
export interface ClickValidationConfig {
  /** Enable click validation in replay sequences (default: true) */
  enabled: boolean;
  /** Validate navigation success if click caused URL change (default: true) */
  validateNavigation: boolean;
  /** Require DOM mutations after click (default: false) */
  requireDomChanges: boolean;
  /** Failure mode for DOM changes check: 'error' stops sequence, 'warn' logs and continues (default: 'warn') */
  domChangesFailMode: 'error' | 'warn';
  /** Check for new console errors after click (default: true) */
  failOnConsoleErrors: boolean;
  /** Failure mode for console errors: 'error' stops sequence, 'warn' logs and continues (default: 'error') */
  consoleErrorsFailMode: 'error' | 'warn';
  /** Validate network requests triggered by click (default: false) */
  validateNetworkPayload: boolean;
  /** Failure mode for network failures: 'error' stops sequence, 'warn' logs and continues (default: 'warn') */
  networkFailMode: 'error' | 'warn';
  /** Delay before validation checks in ms (default: 100) */
  postClickDelayMs: number;
}

/**
 * Root configuration structure
 */
export interface CdpToolsConfig {
  version: number;
  directoryPath: string;
  portMonitoring: PortMonitoringConfig;
  replay: ReplayConfig;
  changeDetection: ChangeDetectionConfig;
  clickValidation: ClickValidationConfig;
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
  replay: {
    maxConditionalDepth: 10,  // Maximum nesting depth for conditional commands
    maxRegexLength: 500,      // Maximum regex pattern length for url:matches
  },
  changeDetection: {
    enabled: true,            // Detect DOM changes by default
    settleTimeout: 2000,      // Max wait for mutations to settle
    quietPeriod: 300,         // No mutations for 300ms = settled
    navigationTimeout: 3000,  // Longer timeout for page loads
  },
  clickValidation: {
    enabled: true,                 // Enable click validation in replay
    validateNavigation: true,      // Check navigation success
    requireDomChanges: false,      // Don't require DOM mutations by default
    domChangesFailMode: 'warn',    // Just warn if no DOM changes
    failOnConsoleErrors: true,     // Check for console errors
    consoleErrorsFailMode: 'error',// Fail on console errors
    validateNetworkPayload: false, // Don't validate network by default
    networkFailMode: 'warn',       // Just warn on network failures
    postClickDelayMs: 100,         // Small delay before validation
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
      replay: {
        maxConditionalDepth: loaded.replay?.maxConditionalDepth ?? defaults.replay.maxConditionalDepth,
        maxRegexLength: loaded.replay?.maxRegexLength ?? defaults.replay.maxRegexLength,
      },
      changeDetection: {
        enabled: loaded.changeDetection?.enabled ?? defaults.changeDetection.enabled,
        settleTimeout: loaded.changeDetection?.settleTimeout ?? defaults.changeDetection.settleTimeout,
        quietPeriod: loaded.changeDetection?.quietPeriod ?? defaults.changeDetection.quietPeriod,
        navigationTimeout: loaded.changeDetection?.navigationTimeout ?? defaults.changeDetection.navigationTimeout,
      },
      clickValidation: {
        enabled: loaded.clickValidation?.enabled ?? defaults.clickValidation.enabled,
        validateNavigation: loaded.clickValidation?.validateNavigation ?? defaults.clickValidation.validateNavigation,
        requireDomChanges: loaded.clickValidation?.requireDomChanges ?? defaults.clickValidation.requireDomChanges,
        domChangesFailMode: loaded.clickValidation?.domChangesFailMode ?? defaults.clickValidation.domChangesFailMode,
        failOnConsoleErrors: loaded.clickValidation?.failOnConsoleErrors ?? defaults.clickValidation.failOnConsoleErrors,
        consoleErrorsFailMode: loaded.clickValidation?.consoleErrorsFailMode ?? defaults.clickValidation.consoleErrorsFailMode,
        validateNetworkPayload: loaded.clickValidation?.validateNetworkPayload ?? defaults.clickValidation.validateNetworkPayload,
        networkFailMode: loaded.clickValidation?.networkFailMode ?? defaults.clickValidation.networkFailMode,
        postClickDelayMs: loaded.clickValidation?.postClickDelayMs ?? defaults.clickValidation.postClickDelayMs,
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
   * Get replay system configuration
   */
  getReplayConfig(): ReplayConfig {
    return this.getConfig().replay;
  }

  /**
   * Get change detection configuration
   */
  getChangeDetectionConfig(): ChangeDetectionConfig {
    return this.getConfig().changeDetection;
  }

  /**
   * Get click validation configuration for replay sequences
   */
  getClickValidationConfig(): ClickValidationConfig {
    return this.getConfig().clickValidation;
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
