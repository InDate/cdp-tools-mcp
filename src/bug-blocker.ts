/**
 * Bug blocking mechanism for cdp-tools
 * When a recording contains BUG comments, tools are blocked until bugs are acknowledged
 */

export interface BlockingBug {
  id: string;
  text: string;
  recordingName: string;
  timestamp: Date;
}

// In-memory storage for blocking bugs
let blockingBugs: BlockingBug[] = [];
let nextBugId = 1;

/**
 * Add bugs from a recording that need acknowledgment
 */
export function addBlockingBugs(bugs: { text: string }[], recordingName: string): BlockingBug[] {
  const added: BlockingBug[] = [];
  for (const bug of bugs) {
    const blockingBug: BlockingBug = {
      id: `bug-${nextBugId++}`,
      text: bug.text,
      recordingName,
      timestamp: new Date(),
    };
    blockingBugs.push(blockingBug);
    added.push(blockingBug);
  }
  return added;
}

/**
 * Get all blocking bugs that haven't been acknowledged
 */
export function getBlockingBugs(): BlockingBug[] {
  return [...blockingBugs];
}

/**
 * Check if there are any blocking bugs
 */
export function hasBlockingBugs(): boolean {
  return blockingBugs.length > 0;
}

/**
 * Acknowledge a bug by ID (removes it from blocking list)
 */
export function acknowledgeBug(bugId: string): BlockingBug | undefined {
  const index = blockingBugs.findIndex(b => b.id === bugId);
  if (index >= 0) {
    const [removed] = blockingBugs.splice(index, 1);
    return removed;
  }
  return undefined;
}

/**
 * Acknowledge all bugs (clears blocking list)
 */
export function acknowledgeAllBugs(): BlockingBug[] {
  const all = [...blockingBugs];
  blockingBugs = [];
  return all;
}

/**
 * Format blocking bugs for display
 */
export function formatBlockingBugs(): string {
  if (blockingBugs.length === 0) return '';

  return blockingBugs.map(bug =>
    `- [${bug.id}] "${bug.text}" (from ${bug.recordingName})`
  ).join('\n');
}
