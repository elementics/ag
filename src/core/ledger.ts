export type TurnStatus = 'running' | 'completed' | 'guard_stopped' | 'interrupted' | 'max_iterations';

export interface GuardDecision {
  trigger: 'repeat_mutation';
  reason: string;
  path?: string;
  iteration: number;
}

interface FileMutation {
  path: string;
  action: 'write' | 'edit';
  iteration: number;
  timestamp: string;
  summary: string;
}

interface FileRead {
  path: string;
  iteration: number;
  timestamp: string;
}

interface Verification {
  command: string;
  iteration: number;
  success: boolean;
  exitCode: number | null;
  summary: string;
  timestamp: string;
}

export interface LoopLedgerSnapshot {
  turnNumber: number;
  status: TurnStatus;
  mutations: FileMutation[];
  reads: FileRead[];
  verifications: Verification[];
  guardDecisions: GuardDecision[];
}

const MUTATION_GUARD_THRESHOLD = 3;
const MAX_ANCHOR_CHARS = 3500;

export class AgentLedger {
  private turnNumber = 0;
  private status: TurnStatus = 'completed';
  private mutations: FileMutation[] = [];
  private reads: FileRead[] = [];
  private verifications: Verification[] = [];
  private guardDecisions: GuardDecision[] = [];

  beginTurn(turnNumber: number): void {
    this.turnNumber = turnNumber;
    this.status = 'running';
    this.mutations = [];
    this.reads = [];
    this.verifications = [];
    this.guardDecisions = [];
  }

  markStatus(status: TurnStatus): void {
    this.status = status;
  }

  getStatus(): TurnStatus {
    return this.status;
  }

  snapshot(): LoopLedgerSnapshot {
    return {
      turnNumber: this.turnNumber,
      status: this.status,
      mutations: [...this.mutations],
      reads: [...this.reads],
      verifications: [...this.verifications],
      guardDecisions: [...this.guardDecisions],
    };
  }

  shouldBlockTool(toolName: string, args: Record<string, unknown>, iteration: number): GuardDecision | null {
    const mutation = this.extractMutation(toolName, args);
    if (!mutation) return null;

    const samePathMutations = this.mutations.filter(m => m.path === mutation.path);
    if (samePathMutations.length < MUTATION_GUARD_THRESHOLD) return null;

    const lastMutationIteration = samePathMutations[samePathMutations.length - 1].iteration;
    const readAfterMutation = this.reads.some(r => r.path === mutation.path && r.iteration >= lastMutationIteration);
    const verificationAfterMutation = this.verifications.some(v => v.iteration >= lastMutationIteration);
    if (readAfterMutation || verificationAfterMutation) return null;

    const decision: GuardDecision = {
      trigger: 'repeat_mutation',
      path: mutation.path,
      iteration,
      reason: `Guard stop: ${mutation.path} has already been modified ${samePathMutations.length} times this turn without a confirming read or verification run. Read the file, run verification, or explain the blocker before editing it again.`,
    };
    this.guardDecisions.push(decision);
    this.status = 'guard_stopped';
    return decision;
  }

  recordToolResult(toolName: string, args: Record<string, unknown>, content: string, isError: boolean, iteration: number): void {
    const timestamp = new Date().toISOString();
    if (toolName === 'file' && typeof args.path === 'string') {
      const action = String(args.action ?? '');
      if ((action === 'read' || action === 'list') && !isError) {
        this.reads.push({ path: args.path, iteration, timestamp });
      }
      if ((action === 'write' || action === 'edit') && !isError) {
        this.mutations.push({
          path: args.path,
          action,
          iteration,
          timestamp,
          summary: firstMeaningfulLine(content),
        });
      }
    }

    if (toolName === 'bash' && typeof args.command === 'string') {
      const verification = parseVerification(args.command, content, !isError, iteration, timestamp);
      if (verification) this.verifications.push(verification);
    }
  }

  contextAnchor(): string {
    if (this.status !== 'running' && this.mutations.length === 0 && this.verifications.length === 0 && this.guardDecisions.length === 0) {
      return '';
    }

    const lines: string[] = [
      '<working-state>',
      `Turn: ${this.turnNumber}`,
      `Status: ${this.status}`,
    ];

    const mutationGroups = new Map<string, FileMutation[]>();
    for (const mutation of this.mutations) {
      const existing = mutationGroups.get(mutation.path) ?? [];
      existing.push(mutation);
      mutationGroups.set(mutation.path, existing);
    }
    if (mutationGroups.size > 0) {
      lines.push('Files modified this turn:');
      for (const [path, mutations] of [...mutationGroups.entries()].slice(-8)) {
        const latest = mutations[mutations.length - 1];
        lines.push(`- ${path}: ${mutations.length} mutation(s); latest ${latest.action} at loop ${latest.iteration}; ${latest.summary}`);
      }
    }

    if (this.verifications.length > 0) {
      lines.push('Recent verification:');
      for (const verification of this.verifications.slice(-4)) {
        const state = verification.success ? 'pass' : 'fail';
        const exit = verification.exitCode == null ? '' : ` exit=${verification.exitCode}`;
        lines.push(`- [${state}${exit}] ${verification.command}: ${verification.summary}`);
      }
    }

    if (this.guardDecisions.length > 0) {
      lines.push('Loop guards:');
      for (const guard of this.guardDecisions.slice(-3)) {
        lines.push(`- ${guard.reason}`);
      }
    }

    lines.push('If you edited a file repeatedly, inspect the current file and run a targeted verification before further mutation.');
    lines.push('</working-state>');
    const anchor = lines.join('\n');
    return anchor.length <= MAX_ANCHOR_CHARS ? anchor : `${anchor.slice(0, MAX_ANCHOR_CHARS)}\n... [working-state truncated]\n</working-state>`;
  }

  private extractMutation(toolName: string, args: Record<string, unknown>): { path: string; action: 'write' | 'edit' } | null {
    if (toolName !== 'file') return null;
    const action = String(args.action ?? '');
    if (action !== 'write' && action !== 'edit') return null;
    const path = args.path;
    if (typeof path !== 'string' || !path) return null;
    return { path, action };
  }
}

function firstMeaningfulLine(content: string): string {
  return content.split('\n').map(line => line.trim()).find(Boolean)?.slice(0, 160) ?? '(no output)';
}

function parseVerification(command: string, content: string, success: boolean, iteration: number, timestamp: string): Verification | null {
  if (!looksLikeVerification(command)) return null;
  const exitMatch = content.match(/^EXIT\s+(\d+)/m);
  const exitCode = exitMatch ? Number(exitMatch[1]) : success ? 0 : null;
  return {
    command: command.slice(0, 240),
    iteration,
    success,
    exitCode,
    summary: firstMeaningfulLine(content),
    timestamp,
  };
}

function looksLikeVerification(command: string): boolean {
  return /\b(test|tests|vitest|jest|pytest|cargo test|go test|npm run (?:test|type-check|lint|build)|pnpm (?:test|lint|build)|yarn (?:test|lint|build)|tsc|type-check|lint|build)\b/i.test(command);
}
