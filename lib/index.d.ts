import z from "@deepseek-ai/schemastery";
import { Context, Volatile } from "@deepseek-ai/cordis";

//#region src/index.d.ts
/**
 * Deployment-owned cadence, resource limits, and agent selection. Every field
 * is volatile, so the Settings service can project the form on the Plugins
 * page and a saved edit commits into the running references without a reload.
 */
interface Config {
  intervalMs: Volatile<number>;
  intervalSteps: Volatile<number>;
  maxConcurrent: Volatile<number>;
  timeoutMs: Volatile<number>;
  maxResponseBytes: Volatile<number>;
  maxParseRetries: Volatile<number>;
  includeSubagents: Volatile<boolean>;
  onlyWhenVisible: Volatile<boolean>;
  refreshOnTurnEnd: Volatile<boolean>;
}
/** Plain values the schema accepts for one configuration layer. */
type ConfigValues = { [K in keyof Config]: Config[K] extends Volatile<infer V> ? V : never };
/** Validated defaults; both minimum intervals must be met for automatic checks. */
declare const Config: z<Schemastery.ObjectS<NoInfer<{
  intervalMs: z<number, number, "volatile-defined">;
  intervalSteps: z<number, number, "volatile-defined">;
  maxConcurrent: z<number, number, "volatile-defined">;
  timeoutMs: z<number, number, "volatile-defined">;
  maxResponseBytes: z<number, number, "volatile-defined">;
  maxParseRetries: z<number, number, "volatile-defined">;
  includeSubagents: z<boolean, boolean, "volatile-defined">;
  onlyWhenVisible: z<boolean, boolean, "volatile-defined">;
  refreshOnTurnEnd: z<boolean, boolean, "volatile-defined">;
}>>, Schemastery.ObjectT<NoInfer<{
  intervalMs: z<number, number, "volatile-defined">;
  intervalSteps: z<number, number, "volatile-defined">;
  maxConcurrent: z<number, number, "volatile-defined">;
  timeoutMs: z<number, number, "volatile-defined">;
  maxResponseBytes: z<number, number, "volatile-defined">;
  maxParseRetries: z<number, number, "volatile-defined">;
  includeSubagents: z<boolean, boolean, "volatile-defined">;
  onlyWhenVisible: z<boolean, boolean, "volatile-defined">;
  refreshOnTurnEnd: z<boolean, boolean, "volatile-defined">;
}>>, "plain">;
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
export { Config, ConfigValues, apply, inject };
//# sourceMappingURL=index.d.ts.map