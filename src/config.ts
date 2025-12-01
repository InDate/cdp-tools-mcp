/**
 * Configuration Manager
 * Manages user-editable configuration in .cdp-tools/config.json
 */

import * as fs from 'fs';
import { dirname } from 'path';
import { getConfigPath, getConfigSavePath, getOutputPath } from './helpers/paths.js';
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
 * Chrome configuration
 */
export interface ChromeConfig {
  /** Starting port for Chrome debugging - will find next available if in use (default: 9222) */
  startingDebugPort: number;
  /** Inactivity timeout in minutes before closing connections and Chrome (default: 5, set to 0 to disable) */
  inactivityTimeoutMinutes: number;
  /** Polling interval in minutes for inactivity checks (default: 2) */
  inactivityPollingMinutes: number;
}

/**
 * Debug configuration
 */
export interface DebugConfig {
  /** Enable debug logging to debug.log on startup (default: false) */
  enabled: boolean;
  /** Enable history log file - records all commands in replay-compatible format (default: false) */
  historyLogEnabled: boolean;
}

/**
 * Root configuration structure
 */
export interface CdpToolsConfig {
  version: number;
  chrome: ChromeConfig;
  portMonitoring: PortMonitoringConfig;
  replay: ReplayConfig;
  changeDetection: ChangeDetectionConfig;
  clickValidation: ClickValidationConfig;
  debug: DebugConfig;
}

/**
 * Default configuration values
 */
const DEFAULT_CONFIG: CdpToolsConfig = {
  version: 1,
  chrome: {
    startingDebugPort: 9222,
    inactivityTimeoutMinutes: 5,
    inactivityPollingMinutes: 2,
  },
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
  debug: {
    enabled: false,               // Debug logging disabled by default
    historyLogEnabled: false,     // History log disabled by default
  },
};

/**
 * Configuration Manager
 * Loads and saves configuration from .cdp-tools/config.json
 * Also tracks runtime port state
 */
export class ConfigManager {
  private config: CdpToolsConfig = { ...DEFAULT_CONFIG };
  private loaded = false;
  private loadedFromPath: string | null = null;

  // Runtime port state (not persisted to config file)
  private currentPort: number = DEFAULT_CONFIG.chrome.startingDebugPort;

  /**
   * Get preferred path for creating new config
   * Prefers working directory if .cdp-tools folder exists or can be created
   */
  private getPreferredConfigPath(): string {
    try {
      const wdConfigPath = getOutputPath('config.json');
      const wdBase = dirname(wdConfigPath);

      // If .cdp-tools dir exists in working directory, use it
      if (fs.existsSync(wdBase)) {
        return wdConfigPath;
      }

      // Try to create .cdp-tools dir in working directory
      fs.mkdirSync(wdBase, { recursive: true });
      return wdConfigPath;
    } catch {
      // Fall back to global if working directory is not writable
      return getConfigSavePath();
    }
  }

  /**
   * Load configuration from disk
   * Checks cwd/.cdp-tools/config.json first (for backwards compatibility),
   * then falls back to ~/.cdp-tools/config.json
   */
  async load(): Promise<void> {
    const configPath = getConfigPath();

    try {
      if (fs.existsSync(configPath)) {
        const content = await fs.promises.readFile(configPath, 'utf-8');
        const loaded = JSON.parse(content);

        // Deep merge with defaults
        this.config = this.mergeConfig(DEFAULT_CONFIG, loaded);
        this.loadedFromPath = configPath;
        await debugLog('ConfigManager', `Loaded config from ${configPath}`);

        // Save back to the same location to ensure any new default settings are written
        await this.save();
      } else {
        // Create default config file - prefer working directory if possible
        this.config = { ...DEFAULT_CONFIG };
        this.loadedFromPath = this.getPreferredConfigPath();
        await this.save();
        await debugLog('ConfigManager', `Created default config at ${this.loadedFromPath}`);
      }
    } catch (err) {
      await debugLog('ConfigManager', `Failed to load config: ${err}, using defaults`);
      this.config = { ...DEFAULT_CONFIG };
      this.loadedFromPath = null;
    }

    this.loaded = true;
  }

  /**
   * Deep merge two config objects
   */
  private mergeConfig(defaults: CdpToolsConfig, loaded: Partial<CdpToolsConfig>): CdpToolsConfig {
    return {
      version: loaded.version ?? defaults.version,
      chrome: {
        startingDebugPort: loaded.chrome?.startingDebugPort ?? defaults.chrome.startingDebugPort,
        inactivityTimeoutMinutes: loaded.chrome?.inactivityTimeoutMinutes ?? defaults.chrome.inactivityTimeoutMinutes,
        inactivityPollingMinutes: loaded.chrome?.inactivityPollingMinutes ?? defaults.chrome.inactivityPollingMinutes,
      },
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
      debug: {
        enabled: loaded.debug?.enabled ?? defaults.debug.enabled,
        historyLogEnabled: loaded.debug?.historyLogEnabled ?? defaults.debug.historyLogEnabled,
      },
    };
  }

  /**
   * Save configuration to disk
   * Saves to the same location it was loaded from, or global if new
   */
  async save(): Promise<void> {
    const configPath = this.loadedFromPath || getConfigSavePath();
    const dir = dirname(configPath);

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
   * Get Chrome configuration
   */
  getChromeConfig(): ChromeConfig {
    return this.getConfig().chrome;
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
   * Get debug configuration
   */
  getDebugConfig(): DebugConfig {
    return this.getConfig().debug;
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

  // Runtime port state methods (not persisted)

  /**
   * Get the current port in use (runtime state)
   */
  getCurrentPort(): number {
    return this.currentPort;
  }

  /**
   * Set the current port (runtime state)
   */
  setCurrentPort(port: number): void {
    this.currentPort = port;
  }
}

// Export singleton instance
export const configManager = new ConfigManager();
