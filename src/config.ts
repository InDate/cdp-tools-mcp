/**
 * Configuration Manager
 * Manages user-editable configuration in .cdp-tools/config.json
 */

import * as fs from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { getConfigSavePath, getOutputPath } from './helpers/paths.js';
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
  /** Show visual cursor during replay (default: true) */
  showCursor: boolean;
  /** Export path for Playwright tests (default: ./tests/e2e) */
  playwrightExportPath: string;
  /** Export path for Puppeteer tests (default: ./tests/puppeteer) */
  puppeteerExportPath: string;
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
  configLocation: 'local' | 'global';  // Where to load config from on startup
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
  configLocation: 'local',
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
    showCursor: true,         // Show visual cursor during replay
    playwrightExportPath: './tests/e2e',      // Export path for Playwright tests
    puppeteerExportPath: './tests/puppeteer', // Export path for Puppeteer tests
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
   * Checks local config first for configLocation preference.
   * If configLocation is 'global', uses global config.
   * Otherwise creates/uses local config (seeding from global if available).
   */
  async load(): Promise<void> {
    const localConfigPath = getOutputPath('config.json');
    const globalConfigPath = join(homedir(), '.cdp-tools', 'config.json');

    try {
      // Check if local config exists and has configLocation preference
      if (fs.existsSync(localConfigPath)) {
        const content = await fs.promises.readFile(localConfigPath, 'utf-8');
        const loaded = JSON.parse(content);

        // If local config says to use global, switch to global
        if (loaded.configLocation === 'global' && fs.existsSync(globalConfigPath)) {
          const globalContent = await fs.promises.readFile(globalConfigPath, 'utf-8');
          const globalLoaded = JSON.parse(globalContent);
          this.config = this.mergeConfig(DEFAULT_CONFIG, globalLoaded);
          this.loadedFromPath = globalConfigPath;
          await debugLog('ConfigManager', `Using global config (per local configLocation setting)`);

          // Clean up local config to just have the pointer
          await fs.promises.writeFile(
            localConfigPath,
            JSON.stringify({ configLocation: 'global' }, null, 2),
            'utf-8'
          );

          await this.save();
          return;
        }

        // Use local config
        this.config = this.mergeConfig(DEFAULT_CONFIG, loaded);
        this.loadedFromPath = localConfigPath;
        await debugLog('ConfigManager', `Loaded config from ${localConfigPath}`);
        await this.save();
      } else {
        // No local config - create one
        // Seed from global if it exists, otherwise use defaults
        if (fs.existsSync(globalConfigPath)) {
          const content = await fs.promises.readFile(globalConfigPath, 'utf-8');
          const loaded = JSON.parse(content);
          this.config = this.mergeConfig(DEFAULT_CONFIG, loaded);
          await debugLog('ConfigManager', `Seeding local config from global ${globalConfigPath}`);
        } else {
          this.config = { ...DEFAULT_CONFIG };
        }
        // Save to local (getPreferredConfigPath will fall back to global if local not writable)
        this.loadedFromPath = this.getPreferredConfigPath();
        await this.save();
        await debugLog('ConfigManager', `Created config at ${this.loadedFromPath}`);
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
      configLocation: loaded.configLocation ?? defaults.configLocation,
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
        showCursor: loaded.replay?.showCursor ?? defaults.replay.showCursor,
        playwrightExportPath: loaded.replay?.playwrightExportPath ?? defaults.replay.playwrightExportPath,
        puppeteerExportPath: loaded.replay?.puppeteerExportPath ?? defaults.replay.puppeteerExportPath,
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

  // Config management methods

  /**
   * Get info about current config location and status
   */
  getStatus(): {
    loadedFrom: string | null;
    isLocal: boolean;
    localPath: string;
    globalPath: string;
    localExists: boolean;
    globalExists: boolean;
  } {
    const localPath = getOutputPath('config.json');
    const globalPath = join(homedir(), '.cdp-tools', 'config.json');
    return {
      loadedFrom: this.loadedFromPath,
      isLocal: this.loadedFromPath === localPath,
      localPath,
      globalPath,
      localExists: fs.existsSync(localPath),
      globalExists: fs.existsSync(globalPath),
    };
  }

  /**
   * Switch to using local config (creates if needed, optionally seeds from global)
   */
  async useLocal(seedFromGlobal: boolean = true): Promise<{ path: string; seeded: boolean }> {
    const localPath = getOutputPath('config.json');
    const globalPath = join(homedir(), '.cdp-tools', 'config.json');
    const localDir = dirname(localPath);

    // Create directory if needed
    if (!fs.existsSync(localDir)) {
      await fs.promises.mkdir(localDir, { recursive: true });
    }

    let seeded = false;
    if (!fs.existsSync(localPath) && seedFromGlobal && fs.existsSync(globalPath)) {
      // Seed from global
      const content = await fs.promises.readFile(globalPath, 'utf-8');
      const loaded = JSON.parse(content);
      this.config = this.mergeConfig(DEFAULT_CONFIG, loaded);
      seeded = true;
    }

    // Set configLocation to local explicitly
    this.config.configLocation = 'local';
    this.loadedFromPath = localPath;
    await this.save();
    return { path: localPath, seeded };
  }

  /**
   * Switch to using global config
   * Writes a minimal local config with just configLocation: 'global'
   */
  async useGlobal(): Promise<{ path: string }> {
    const localPath = getOutputPath('config.json');
    const globalPath = join(homedir(), '.cdp-tools', 'config.json');
    const localDir = dirname(localPath);
    const globalDir = dirname(globalPath);

    // Ensure directories exist
    if (!fs.existsSync(localDir)) {
      await fs.promises.mkdir(localDir, { recursive: true });
    }
    if (!fs.existsSync(globalDir)) {
      await fs.promises.mkdir(globalDir, { recursive: true });
    }

    // Write minimal local config with just the preference
    const minimalConfig = { configLocation: 'global' as const };
    await fs.promises.writeFile(
      localPath,
      JSON.stringify(minimalConfig, null, 2),
      'utf-8'
    );

    // Load and use global config
    if (fs.existsSync(globalPath)) {
      const content = await fs.promises.readFile(globalPath, 'utf-8');
      const loaded = JSON.parse(content);
      this.config = this.mergeConfig(DEFAULT_CONFIG, loaded);
    } else {
      this.config = { ...DEFAULT_CONFIG };
    }

    this.loadedFromPath = globalPath;
    await this.save();
    return { path: globalPath };
  }

  /**
   * Reset config to defaults
   */
  async reset(): Promise<void> {
    this.config = { ...DEFAULT_CONFIG };
    await this.save();
  }

  /**
   * Create a backup of current config
   */
  async backup(): Promise<{ path: string } | null> {
    if (!this.loadedFromPath || !fs.existsSync(this.loadedFromPath)) {
      return null;
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = this.loadedFromPath.replace('.json', `.backup-${timestamp}.json`);
    await fs.promises.copyFile(this.loadedFromPath, backupPath);
    return { path: backupPath };
  }

  /**
   * Clone global config to local
   */
  async cloneFromGlobal(): Promise<{ path: string } | { error: string }> {
    const globalPath = join(homedir(), '.cdp-tools', 'config.json');

    if (!fs.existsSync(globalPath)) {
      return { error: 'No global config exists to clone from' };
    }

    const content = await fs.promises.readFile(globalPath, 'utf-8');
    const loaded = JSON.parse(content);
    this.config = this.mergeConfig(DEFAULT_CONFIG, loaded);

    const localPath = getOutputPath('config.json');
    const localDir = dirname(localPath);

    if (!fs.existsSync(localDir)) {
      await fs.promises.mkdir(localDir, { recursive: true });
    }

    this.loadedFromPath = localPath;
    await this.save();
    return { path: localPath };
  }
}

// Export singleton instance
export const configManager = new ConfigManager();
