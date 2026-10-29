import z from "@deepseek-ai/schemastery";
import { Context } from "@deepseek-ai/cordis";

//#region src/index.d.ts
/** Deployment-owned cadence, resource limits, and agent selection. */
interface Config {
  intervalMs: number;
  intervalSteps: number;
  maxConcurrent: number;
  timeoutMs: number;
  maxResponseBytes: number;
  maxParseRetries: number;
  includeSubagents: boolean;
  onlyWhenVisible: boolean;
}
/** Validated defaults; both minimum intervals must be met for automatic checks. */
declare const Config: z<Config>;
/** Services whose lifetime owns the scheduler. Persistence is verified by awaited flushes. */
declare const inject: string[];
/**
 * Attach background checks to all live agents and unwind timers and calls on removal.
 * Awaits projection registration before exposing reads or operations that depend on it.
 * @param ctx - plugin-owned context.
 * @param config - validated configuration.
 * @returns when the projection is registered and the schedulers are listening.
 */
declare function apply(ctx: Context, config: Config): Promise<void>;
//#endregion
export { Config, apply, inject };
//# sourceMappingURL=index.d.ts.map