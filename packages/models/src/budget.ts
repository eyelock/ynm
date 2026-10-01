import type { Usage } from "./types.js";

export class BudgetExceededError extends Error {
  constructor(
    readonly label: string,
    readonly spent: number,
    readonly limit: number
  ) {
    super(
      `${label}: token budget exceeded (${spent} of ${limit} input tokens); raise the budget explicitly to continue`
    );
    this.name = "BudgetExceededError";
  }
}

/**
 * Hard cap on paid model usage per process (ADR-012, ADR-014). Every metered client charges
 * its usage here before and after a call; crossing the limit throws instead of spending.
 * Defaults are deliberately small; evals set their own even smaller budget.
 */
export class SpendGuard {
  spent = 0;
  calls = 0;
  constructor(
    readonly maxInputTokens: number,
    readonly label = "paid models"
  ) {}

  /** Reserve an estimate before the call so a single oversized request cannot slip through. */
  reserve(estimate: number): void {
    if (this.spent + estimate > this.maxInputTokens)
      throw new BudgetExceededError(this.label, this.spent + estimate, this.maxInputTokens);
  }

  /**
   * Record actual usage after the call. A paid call always sends input, so a missing or
   * non-positive input count means the provider did not report it (adapters fill gaps with 0);
   * charge the pre-call estimate instead so the call still counts against the cap.
   */
  charge(usage?: Usage, estimate = 0): void {
    this.calls += 1;
    const reported = usage?.inputTokens ?? 0;
    this.spent += reported > 0 ? reported : estimate;
    if (this.spent > this.maxInputTokens)
      throw new BudgetExceededError(this.label, this.spent, this.maxInputTokens);
  }

  get remaining(): number {
    return Math.max(0, this.maxInputTokens - this.spent);
  }

  /** From the environment: YNM_TOKEN_BUDGET input tokens per process. */
  static fromEnv(
    env: NodeJS.ProcessEnv = process.env,
    fallback = 2_000_000,
    key = "YNM_TOKEN_BUDGET"
  ): SpendGuard {
    const n = Number(env[key]);
    return new SpendGuard(Number.isFinite(n) && n > 0 ? n : fallback);
  }
}

/** One guard per process unless a caller supplies its own. */
let processGuard: SpendGuard | undefined;
export function defaultSpendGuard(): SpendGuard {
  processGuard ??= SpendGuard.fromEnv();
  return processGuard;
}
