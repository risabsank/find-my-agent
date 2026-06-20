import type { TokenUsage } from "../../shared/types.ts";

/**
 * A source of token/cost usage for an agent.
 *
 * v1 ships only StubTokenSource. Claude Code emits real usage natively via
 * OpenTelemetry (set CLAUDE_CODE_ENABLE_TELEMETRY=1; metric
 * `claude_code.token.usage`, with attributes for model and subagent). The real
 * wiring will be an OTEL adapter that implements this interface — see the TODO.
 */
export interface TokenSource {
  /** Current cumulative usage for an agent. */
  getUsage(agentId: string): TokenUsage;
  /** Called when an agent first appears, so the source can begin tracking. */
  register?(agentId: string): void;
}

const EMPTY: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  costUsd: 0,
  isStub: true,
};

/**
 * Placeholder source. Returns slowly-growing fake numbers so the UI has
 * something non-zero to render, all flagged `isStub: true`.
 */
export class StubTokenSource implements TokenSource {
  private started = new Map<string, number>();

  register(agentId: string): void {
    if (!this.started.has(agentId)) this.started.set(agentId, Date.now());
  }

  getUsage(agentId: string): TokenUsage {
    const start = this.started.get(agentId);
    if (start === undefined) return { ...EMPTY };
    // Fake a token count that grows ~1.5k tokens/sec since the agent appeared.
    const elapsedSec = (Date.now() - start) / 1000;
    const total = Math.round(elapsedSec * 1500);
    const input = Math.round(total * 0.7);
    const output = total - input;
    // Rough Sonnet-ish blended rate purely for placeholder display.
    const costUsd = Number(
      ((input / 1_000_000) * 3 + (output / 1_000_000) * 15).toFixed(4),
    );
    return {
      inputTokens: input,
      outputTokens: output,
      totalTokens: total,
      costUsd,
      model: "stub",
      isStub: true,
    };
  }
}

// TODO: OTEL adapter.
// Implement `class OtelTokenSource implements TokenSource` that subscribes to an
// OpenTelemetry collector receiving `claude_code.token.usage`, keyed by
// session_id (and subagent attribute), and returns real input/output/cost.
// Swap it in where StubTokenSource is constructed in index.ts.

export const tokenSource: TokenSource = new StubTokenSource();
