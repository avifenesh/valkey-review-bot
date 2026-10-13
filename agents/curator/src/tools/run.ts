import type { FeedbackKind } from '../feedback.js';

/**
 * Per-run state the tools share. One feedback event may change the
 * concerns store once and publish at most one skill; these limits are
 * enforced here rather than left to the prompt.
 */
export type Slot = 'concern_write' | 'skill_submit';

export interface TouchedRecord {
  readonly areaBucket: string;
  readonly recordId: string;
}

export interface CuratorDecision {
  readonly decision: string;
  readonly summary: string;
}

export interface CuratorRunOpts {
  readonly reviewerId: string;
  readonly kind: FeedbackKind;
  /** actor#repo#pr of the person whose feedback this is. */
  readonly reinforcer: string;
  readonly graduationThreshold: number;
}

export class CuratorRun {
  readonly reviewerId: string;
  readonly kind: FeedbackKind;
  readonly reinforcer: string;
  readonly graduationThreshold: number;
  /** The record this run's bump or merge reinforced; submit_skill may graduate it. */
  reinforced: TouchedRecord | null = null;
  /**
   * A graduated record this run changed with update_concern. submit_skill
   * may re-publish its skill, so pushback can correct a live skill, but
   * never graduate it for the first time.
   */
  edited: TouchedRecord | null = null;
  done: CuratorDecision | null = null;
  readonly actions: string[] = [];
  private readonly held = new Set<Slot>();
  private readonly used = new Set<Slot>();

  constructor(opts: CuratorRunOpts) {
    this.reviewerId = opts.reviewerId;
    this.kind = opts.kind;
    this.reinforcer = opts.reinforcer;
    this.graduationThreshold = opts.graduationThreshold;
  }

  /**
   * Error text when the run has ended or the slot is taken, otherwise
   * null with the slot held. Checked and taken before the first await,
   * so concurrent tool calls cannot both get the slot.
   */
  take(slot: Slot, tool: string): string | null {
    if (this.done) return `${tool}: the run already ended with curator_done`;
    if (this.used.has(slot) || this.held.has(slot)) {
      return slot === 'concern_write'
        ? `${tool}: this run already changed the concerns store; one feedback event allows one change`
        : `${tool}: this run already submitted a skill`;
    }
    this.held.add(slot);
    return null;
  }

  /** The operation changed state: the slot stays used for the rest of the run. */
  commit(slot: Slot, action: string): void {
    this.held.delete(slot);
    this.used.add(slot);
    this.actions.push(action);
  }

  /** The operation changed nothing: the slot is free again. */
  release(slot: Slot): void {
    this.held.delete(slot);
  }

  /** Structural changes (create, update, merge, delete) need a reply or comment, not a submitted review. */
  get allowsStructuralChange(): boolean {
    return this.kind !== 'resolution';
  }
}

export function ok(fields: Record<string, unknown>): string {
  return JSON.stringify({ ok: true, ...fields });
}

export function fail(error: string, fields: Record<string, unknown> = {}): string {
  return JSON.stringify({ ok: false, error, ...fields });
}

export function errorText(err: unknown): string {
  const name = (err as { name?: string } | null)?.name;
  const message = err instanceof Error ? err.message : String(err);
  return name && name !== 'Error' ? `${name}: ${message}` : message;
}
