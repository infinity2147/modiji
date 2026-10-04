/**
 * The coach's idle nudge: when a trainee sits on an open, undecided case with the voice coach connected and does
 * nothing for `IDLE_NUDGE_MS` (no speech, typing, clicks or selection), the coach is asked once for a gentle
 * prompt (`POST tutor/nudge {reason: "idle"}`). At most once per case. Framework-free with an injected timer, so
 * it is tested without React or real time.
 */

export const IDLE_NUDGE_MS = 45_000;

export type IdleNudgeOptions = {
  setTimer: (fn: () => void, delayMs: number) => () => void;
  /** Ask the coach for a nudge on this case (it speaks through the gate like every coach turn). */
  nudge: (caseId: string) => void;
  idleMs?: number;
};

export type IdleNudger = {
  /**
   * The case the trainee is on and whether a nudge may be given there now (coach connected, case undecided, on
   * the record). A different case, or a change of eligibility, restarts the idle clock; the same values do nothing.
   */
  update: (caseId: string | undefined, eligible: boolean) => void;
  /** The trainee (or the coach) did something: the idle clock restarts. */
  activity: () => void;
  /** Stops the clock until the next `update`. */
  dispose: () => void;
};

export function createIdleNudger(options: IdleNudgeOptions): IdleNudger {
  const idleMs = options.idleMs ?? IDLE_NUDGE_MS;
  const nudged = new Set<string>();
  let caseId: string | undefined;
  let eligible = false;
  let cancel: (() => void) | null = null;

  const arm = (): void => {
    cancel?.();
    cancel = null;
    const current = caseId;
    if (!eligible || current === undefined || nudged.has(current)) return;
    cancel = options.setTimer(() => {
      cancel = null;
      if (!eligible || caseId !== current || nudged.has(current)) return;
      nudged.add(current);
      options.nudge(current);
    }, idleMs);
  };

  return {
    update(nextCase, nextEligible) {
      if (nextCase === caseId && nextEligible === eligible) return;
      caseId = nextCase;
      eligible = nextEligible;
      arm();
    },
    activity() {
      if (cancel !== null) arm();
    },
    dispose() {
      // Forgets the case (a later `update` starts afresh, e.g. React re-running effects) but not the cases nudged.
      caseId = undefined;
      eligible = false;
      cancel?.();
      cancel = null;
    },
  };
}
