/**
 * Message template system for llm-cdp
 *
 * Loads and formats user-facing messages from docs/messages.md
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface MessageTemplate {
  id: string;
  type: 'error' | 'success' | 'warning' | 'info';
  code?: string;
  content: string;
  suggestions?: string[];
  note?: string;
  example?: string;
}

class MessageManager {
  private messages: Map<string, MessageTemplate> = new Map();
  private loaded = false;

  /**
   * Load messages from docs/messages.md
   */
  private loadMessages(): void {
    if (this.loaded) return;

    try {
      const messagesPath = join(__dirname, '..', 'docs', 'messages.md');
      const content = readFileSync(messagesPath, 'utf-8');

      this.parseMessages(content);
      this.loaded = true;
    } catch (error) {
      console.error('[llm-cdp] Warning: Failed to load messages.md, using fallback messages:', error);
      this.loadFallbackMessages();
    }
  }

  /**
   * Parse messages from markdown content
   */
  private parseMessages(content: string): void {
    // Split by message headers (## MESSAGE_ID)
    const sections = content.split(/^## /m).filter(s => s.trim());

    for (const section of sections) {
      const lines = section.split('\n');
      const id = lines[0].trim();

      if (!id || id.startsWith('#') || id === 'Variable Templates') continue;

      let type: 'error' | 'success' | 'warning' | 'info' = 'info';
      let code: string | undefined;
      let contentLines: string[] = [];
      let suggestions: string[] = [];
      let note: string | undefined;
      let example: string | undefined;

      let inCodeBlock = false;
      let inSuggestions = false;
      let codeBlockLines: string[] = [];

      for (let i = 1; i < lines.length; i++) {
        const line = lines[i];

        // Parse metadata
        if (line.startsWith('**Type:**')) {
          const typeMatch = line.match(/\*\*Type:\*\*\s+(error|success|warning|info)/);
          if (typeMatch) type = typeMatch[1] as any;
          continue;
        }

        if (line.startsWith('**Code:**')) {
          const codeMatch = line.match(/\*\*Code:\*\*\s+(\w+)/);
          if (codeMatch) code = codeMatch[1];
          continue;
        }

        // Handle code blocks
        if (line.trim().startsWith('```')) {
          if (!inCodeBlock) {
            inCodeBlock = true;
            codeBlockLines = [];
          } else {
            inCodeBlock = false;
            if (example === undefined) {
              example = codeBlockLines.join('\n');
            }
          }
          continue;
        }

        if (inCodeBlock) {
          codeBlockLines.push(line);
          continue;
        }

        // Parse suggestions
        if (line.startsWith('**Suggestions:**')) {
          inSuggestions = true;
          continue;
        }

        if (inSuggestions && line.trim().startsWith('-')) {
          suggestions.push(line.trim().substring(1).trim());
          continue;
        }

        if (line.startsWith('**Note:**')) {
          note = line.replace(/\*\*Note:\*\*\s*/, '').trim();
          continue;
        }

        if (line.startsWith('**Example:**')) {
          continue; // Example code block follows
        }

        // Skip only specific metadata lines, not all lines starting with **
        if (line.startsWith('**Type:**') || line.startsWith('**Code:**')) {
          inSuggestions = false;
          continue;
        }

        // Skip horizontal rules
        if (line.trim() === '---') {
          continue;
        }

        // Collect content lines
        if (line.trim() && !line.startsWith('#')) {
          contentLines.push(line);
        }
      }

      this.messages.set(id, {
        id,
        type,
        code,
        content: contentLines.join('\n').trim(),
        suggestions: suggestions.length > 0 ? suggestions : undefined,
        note,
        example,
      });
    }
  }

  /**
   * Load fallback messages if markdown file can't be loaded
   */
  private loadFallbackMessages(): void {
    this.messages.set('CHROME_ALREADY_RUNNING', {
      id: 'CHROME_ALREADY_RUNNING',
      type: 'error',
      code: 'CHROME_RUNNING',
      content: 'Chrome is already running. Use killChrome() to close the existing instance, or use connectDebugger() to connect to it instead.',
    });

    this.messages.set('DEBUGGER_NOT_CONNECTED', {
      id: 'DEBUGGER_NOT_CONNECTED',
      type: 'error',
      code: 'NOT_CONNECTED',
      content: 'Not connected to debugger',
    });

    this.loaded = true;
  }

  /**
   * Get a message by ID with variable substitution
   */
  getMessage(id: string, variables: Record<string, any> = {}): string {
    if (!this.loaded) this.loadMessages();

    const template = this.messages.get(id);
    if (!template) {
      console.error(`[llm-cdp] Warning: Message template '${id}' not found`);
      return `Message not found: ${id}`;
    }

    return this.formatMessage(template.content, variables);
  }

  /**
   * Get a complete message template with metadata
   */
  getMessageTemplate(id: string): MessageTemplate | undefined {
    if (!this.loaded) this.loadMessages();
    return this.messages.get(id);
  }

  /**
   * Format an error message with suggestions and examples
   */
  getErrorMessage(id: string, variables: Record<string, any> = {}): string {
    if (!this.loaded) this.loadMessages();

    const template = this.messages.get(id);
    if (!template) {
      return `Message not found: ${id}`;
    }

    let message = this.formatMessage(template.content, variables);

    if (template.suggestions && template.suggestions.length > 0) {
      message += '\n\nSuggestions:\n';
      template.suggestions.forEach(suggestion => {
        message += `- ${this.formatMessage(suggestion, variables)}\n`;
      });
    }

    if (template.note) {
      message += `\nNote: ${this.formatMessage(template.note, variables)}`;
    }

    if (template.example) {
      message += `\n\nExample:\n${template.example}`;
    }

    return message.trim();
  }

  /**
   * Format a message template with variable substitution
   * Supports {{variable}} syntax and {{#variable}}...{{/variable}} conditionals
   */
  private formatMessage(template: string, variables: Record<string, any>): string {
    // First pass: Handle conditional blocks {{#var}}...{{/var}}
    // Using [\s\S] to match across newlines
    let result = template.replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (match, key, content) => {
      // Check if variable exists and is truthy
      if (variables[key]) {
        return content; // Keep content if variable is truthy
      }
      return ''; // Remove entire block if variable is falsy/undefined
    });

    // Second pass: Simple variable substitution {{var}}
    result = result.replace(/\{\{(\w+)\}\}/g, (match, key) => {
      if (key in variables) {
        return String(variables[key]);
      }
      return match; // Keep placeholder if variable not provided
    });

    return result;
  }

  /**
   * Get message code for error responses
   */
  getMessageCode(id: string): string | undefined {
    if (!this.loaded) this.loadMessages();
    return this.messages.get(id)?.code;
  }

  /**
   * Check if a message exists
   */
  hasMessage(id: string): boolean {
    if (!this.loaded) this.loadMessages();
    return this.messages.has(id);
  }

  /**
   * Format data as a JSON code block
   */
  formatCodeBlock(data: any, language: string = 'json'): string {
    const jsonString = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    return `\`\`\`${language}\n${jsonString}\n\`\`\``;
  }

  /**
   * Format an array as a markdown bullet list
   */
  formatList(items: string[]): string {
    return items.map(item => `- ${item}`).join('\n');
  }

  /**
   * Get a complete markdown-only response for a tool
   * Combines message template with optional data formatting
   */
  getFormattedResponse(id: string, variables: Record<string, any> = {}, data?: any): string {
    if (!this.loaded) this.loadMessages();

    const template = this.messages.get(id);
    if (!template) {
      return `## Error\n\nMessage template not found: ${id}`;
    }

    // Start with the formatted message
    let markdown = this.formatMessage(template.content, variables);

    // Add suggestions for errors
    if (template.type === 'error' && template.suggestions && template.suggestions.length > 0) {
      markdown += '\n\n**Suggestions:**\n';
      template.suggestions.forEach(suggestion => {
        markdown += `- ${this.formatMessage(suggestion, variables)}\n`;
      });
    }

    // Add note if present
    if (template.note) {
      markdown += `\n\n**Note:** ${this.formatMessage(template.note, variables)}`;
    }

    // Add example for errors
    if (template.type === 'error' && template.example) {
      markdown += `\n\n**Example:**\n${template.example}`;
    }

    // Add data as code block if provided
    if (data !== undefined) {
      markdown += '\n\n';
      if (typeof data === 'object') {
        markdown += this.formatCodeBlock(data);
      } else {
        markdown += data;
      }
    }

    return markdown.trim();
  }
}

// Export singleton instance
export const messages = new MessageManager();

/**
 * Helper function to get a formatted message
 */
export function getMessage(id: string, variables?: Record<string, any>): string {
  return messages.getMessage(id, variables);
}

/**
 * Helper function to get a formatted error message with suggestions
 */
export function getErrorMessage(id: string, variables?: Record<string, any>): string {
  return messages.getErrorMessage(id, variables);
}

/**
 * Helper function to get message code
 */
export function getMessageCode(id: string): string | undefined {
  return messages.getMessageCode(id);
}

/**
 * Helper function to get a complete markdown-only response
 */
export function getFormattedResponse(id: string, variables?: Record<string, any>, data?: any): string {
  return messages.getFormattedResponse(id, variables, data);
}

/**
 * Helper function to format data as a code block
 */
export function formatCodeBlock(data: any, language: string = 'json'): string {
  return messages.formatCodeBlock(data, language);
}

/**
 * Helper function to format an array as a markdown list
 */
export function formatList(items: string[]): string {
  return messages.formatList(items);
}

/**
 * MCP Response type
 */
interface MCPResponse {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

/**
 * Create an error response in MCP format with markdown content
 */
export function createErrorResponse(messageId: string, variables?: Record<string, any>): MCPResponse {
  return {
    content: [
      {
        type: 'text',
        text: getErrorMessage(messageId, variables),
      },
    ],
    isError: true,
  };
}

/**
 * Create a success response in MCP format with markdown content
 */
export function createSuccessResponse(messageId: string, variables?: Record<string, any>, data?: any): MCPResponse {
  return {
    content: [
      {
        type: 'text',
        text: getFormattedResponse(messageId, variables, data),
      },
    ],
  };
}

/**
 * Format a tool success response (for tools that don't use message templates)
 */
export function formatToolSuccess(message: string, data?: any): MCPResponse {
  let text = message;
  if (data) {
    text += '\n\n' + formatCodeBlock(data);
  }
  return {
    content: [{ type: 'text', text }],
  };
}

/**
 * Format a tool error response (for tools that don't use message templates)
 */
export function formatToolError(code: string, message: string, data?: any): MCPResponse {
  let text = `**Error (${code}):** ${message}`;
  if (data) {
    text += '\n\n' + formatCodeBlock(data);
  }
  return {
    content: [{ type: 'text', text }],
    isError: true,
  };
}
