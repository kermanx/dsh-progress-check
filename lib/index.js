import { randomUUID } from "node:crypto";
import z from "@deepseek-ai/schemastery";
import { z as z$1 } from "zod";
import { BlockAssembler, isAgentLoopRequest } from "@deepseek-ai/dsh-llm";
import { SessionId, appendPluginRecord } from "@deepseek-ai/dsh-session";
import { LOCALE_SETTINGS_NAMESPACE } from "@deepseek-ai/dsh-client-locale";
//#region src/prompt.ts
/** English progress instructions with the current DSH language preference. */
const QUESTION = `This is an independent progress query while the main task continues in parallel. Report the task's current state based on the complete preceding conversation. Do not carry out the task, call tools, or ask follow-up questions outside the report. Report only plans you had already worked out and are actually carrying out; do not devise new plans for this report.

Before producing the final JSON, you must think in the thinking phase and check the facts and output requirements, producing non-empty reasoning; do not skip thinking and answer directly. Do not include the reasoning in the final JSON.

Return only one valid JSON object with exactly the fields "progress", "uncertainties", and "userActions". All three values must be arrays of strings. Do not add any other text or code fences.

For "progress", choose one structure according to the task's size and strictly follow its item count and order:
- For a large task, exactly three items: item 1 is the subtask currently underway; item 2 is the operation being performed within that subtask right now; item 3 is the next step that had already been decided.
- For a small task, exactly two items: item 1 is the current progress; item 2 is the next step that had already been decided.

For a large task, fill the JSON with the following three short sentences, replacing the placeholders in braces with actual content and removing the braces. Translate the sentence templates into the output language specified below. Fill the other two arrays only when the conditions below are met. For a small task, combine the first two progress items into one:
{"progress":["Working on {current subtask}.","Currently {operation being performed right now}.","Next, {one previously decided action immediately following the current operation}."],"uncertainties":[],"userActions":[]}

Each item must have only one central action, contain only the information assigned to its position, and avoid repeating the other items. Do not add a fourth item or a separate background item. Item 1 must directly name the specific stage of work currently underway; do not substitute the name of the whole task, recap earlier stages, or reintroduce what the user asked you to do. Item 2 must directly state the current action, not list material you have just viewed, checked, or understood. Do not recount several stages as "completed ... now ...", or tuck a recap into commas or parentheses. Item 3 must state only one previously decided action immediately following the current operation and end there; do not continue to the step after that or list the entire process through submission, delivery, or completion.

Each item corresponds to one line and must contain exactly one sentence. First think of a complete sentence, then shorten its wording while preserving its information and human readability. Say what you have done, not what you have read. Omit mechanical, generic operations and, unless necessary, do not repeat what the user already knows. When discussing design, state only the final design, without explaining its rationale. Summarize architectural changes and the overall approach without expanding on code or implementation logic. You may use a filename or identifier to locate something when necessary, but do not enumerate file paths, identifiers, or code snippets.

"uncertainties" must contain only unresolved questions already present in the context that you are truly very confused about, or technical decisions you are very unsure about. Do not include objective facts you can establish yourself through available information, investigation, or verification, even if you have not checked them yet. Do not repackage plans already decided and implemented as "whether user confirmation is needed", or invent concerns to fill this field. Ordinary pending work, routine verification, general risks, and extra matters you were not asked to handle do not belong here. Return [] if nothing qualifies.

"userActions" must contain only things the user can do in parallel with you right now that offer a very high return on their effort toward completing the overall task efficiently. Do not hand work to the user merely because they could do it for you; do your own work yourself. If a question must be answered by the user, or an operation must be performed by the user, direct the user in your formal reply instead of putting it in this field. Return [] if nothing qualifies.

Use the output language specified below. Distinguish verified results from future plans, and do not invent progress percentages or problems. Before outputting, check that the JSON quotes, commas, and brackets are correct; that progress has exactly three or two items for the chosen structure, each with exactly one sentence and the last item being the next step; and that uncertainties and userActions contain only qualifying content. Empty arrays are a normal result.`;
const RETRY_INSTRUCTION = "The previous response could not be parsed in the required format. Generate it again. Return only a valid JSON object: all three fields must be arrays of strings; \"progress\" must have exactly two items for a small task or three for a large task, each non-empty and containing exactly one sentence, with the last item being the next step; return empty arrays for \"uncertainties\" and \"userActions\" when nothing qualifies. Do not add other fields, explanatory text, or code fences.";
/**
* Build the logged query using the preference at the start of this attempt.
* @param locale - explicit DSH locale selection; absence preserves conversation-based language selection.
* @param retry - whether a prior response failed format validation.
* @returns the complete auxiliary user message, including its output-language instruction.
*/
function createQuestion(locale, retry) {
	const language = locale === void 0 ? "No explicit DSH language preference is set. Use the user's language from the conversation for all natural-language strings in the JSON." : `The user-selected DSH output language is ${JSON.stringify(locale)} (BCP 47 language tag). Write all natural-language strings in the JSON in this language, even if the conversation or the examples above use a different language.`;
	return `<system>\n${QUESTION}${retry ? `\n\n${RETRY_INSTRUCTION}` : ""}\n\n${language} Keep the JSON field names exactly as specified.\n</system>`;
}
//#endregion
//#region src/records.ts
/** Versioned, ignorable progress records; none are part of the model conversation. */
/** Persisted report text and lists consumed by existing cards. */
const reportSchema = z$1.object({
	progress: z$1.string().trim().min(1),
	uncertainties: z$1.array(z$1.string().trim().min(1)),
	userActions: z$1.array(z$1.string().trim().min(1))
}).strict();
/** Validate model progress lines and join them for the existing durable report format. */
const modelReportSchema = reportSchema.extend({ progress: z$1.array(z$1.string().trim().min(1)).min(2).max(3).transform((lines) => lines.join("\n")) });
/** Validated persisted result fields consumed by the client and cadence projection. */
const resultSchema = z$1.object({
	version: z$1.literal(1),
	id: z$1.string().min(1),
	sessionId: z$1.string().min(1),
	coveredToolCount: z$1.number().int().nonnegative(),
	contextSeq: z$1.number().int().nonnegative(),
	report: reportSchema
});
/**
* Read an untrusted durable or wire record without importing the Host Session runtime.
* @param event - event envelope received from storage or history.
* @returns validated display data only for this plugin's successful records.
*/
function readResult(event) {
	if (event.type !== "plugin:progress-check/result" || event.ignorable !== true) return void 0;
	const parsed = resultSchema.safeParse(event.data);
	return parsed.success ? parsed.data : void 0;
}
/** Counts child-owned tool/call events, without counting retries or inherited calls. */
const progressProjection = {
	key: "progress-check",
	stateVersion: 1,
	stateSchema: z$1.object({
		sessionId: z$1.string(),
		inherited: z$1.number().int().nonnegative(),
		seq: z$1.number().int().nonnegative(),
		toolCount: z$1.number().int().nonnegative(),
		covered: z$1.number().int().nonnegative()
	}),
	init: (header, inherited) => ({
		sessionId: header.id,
		inherited,
		seq: 0,
		toolCount: 0,
		covered: 0
	}),
	apply: (state, event) => {
		if (event.seq < state.inherited) return state;
		const result = readResult(event);
		return {
			...state,
			seq: event.seq,
			toolCount: state.toolCount + (event.type === "tool/call" ? 1 : 0),
			covered: result?.sessionId === state.sessionId ? Math.max(state.covered, Math.min(state.toolCount, result.coveredToolCount)) : state.covered
		};
	}
};
//#endregion
//#region src/protocol.ts
/** Validated messages on the plugin's authenticated Connection RPC channel. */
/** Connection owns authentication, correlation, transport, and cancellation. */
const PROGRESS_CHANNEL = "/progress-check";
/** Untrusted browser input; only the target Session may be chosen. */
const generateRequestSchema = z$1.object({ sessionId: z$1.string().min(1) }).strict();
z$1.object({ seq: z$1.number().int().nonnegative() }).strict();
/**
* One browser page's statement about what it is showing. The page owns the
* identity, so several tabs on different Sessions coexist in Host state.
*/
const presenceReportSchema = z$1.object({
	/** Stable for one page load. */
	clientId: z$1.string().min(1).max(128),
	/** Sessions this page currently shows in its main area. */
	sessionIds: z$1.array(z$1.string().min(1).max(256)).max(32),
	/** Whether the page is on screen: its tab is visible and its window focused. */
	visible: z$1.boolean()
}).strict();
//#endregion
//#region src/presence.ts
/**
* Latest report per browser page. A report carries no lifetime of its own:
* pages refresh it while they stay in the foreground, so a closed tab expires
* instead of leaving its Session "shown" forever.
*/
var PresenceRegistry = class {
	clients = /* @__PURE__ */ new Map();
	/**
	* Record one page's report, replacing that page's previous statement.
	* @param presence - validated report from the page's current state.
	* @param now - clock override for tests.
	*/
	report(presence, now = Date.now()) {
		this.clients.set(presence.clientId, {
			sessionIds: new Set(presence.sessionIds),
			visible: presence.visible,
			at: now
		});
	}
	/**
	* Whether any page still in the foreground shows this Session. Expiry is
	* evaluated on read, so a stale report stops counting even with no traffic.
	* @param sessionId - Session to test.
	* @param now - clock override for tests.
	* @returns true while at least one fresh, visible report names the Session.
	*/
	watched(sessionId, now = Date.now()) {
		let watched = false;
		for (const [clientId, state] of this.clients) {
			if (now - state.at > 15e3) {
				this.clients.delete(clientId);
				continue;
			}
			if (state.visible && state.sessionIds.has(sessionId)) watched = true;
		}
		return watched;
	}
	/** Forget every report; unload must not leave Host state behind. */
	clear() {
		this.clients.clear();
	}
};
//#endregion
//#region src/index.ts
/** Periodic auxiliary progress checks for running agents, with durable Session records. */
/** Validated defaults; the call threshold is exclusive. */
const Config = z.object({
	intervalMs: z.number().min(1).step(1).default(6e4),
	toolCallThreshold: z.number().min(0).step(1).default(5),
	maxConcurrent: z.number().min(1).step(1).default(2),
	timeoutMs: z.number().min(1).step(1).default(12e4),
	maxResponseBytes: z.number().min(1).step(1).default(262144),
	maxParseRetries: z.number().min(0).max(3).step(1).default(3),
	includeSubagents: z.boolean().default(true),
	onlyWhenVisible: z.boolean().default(true)
});
/** Services whose lifetime owns the scheduler. Persistence is verified by awaited flushes. */
const inject = [
	"agents",
	"sessions",
	"sessionProjections",
	"llm"
];
/**
* Attach background checks to all live agents and unwind timers and calls on removal.
* @param ctx - plugin-owned context.
* @param config - validated configuration.
*/
function apply(ctx, config) {
	const localeSettings = z$1.object({ preference: z$1.string().optional() });
	const outputLocale = () => {
		const descriptor = ctx.get("settings")?.describe().find((form) => form.ns === LOCALE_SETTINGS_NAMESPACE);
		return descriptor === void 0 ? void 0 : localeSettings.parse(descriptor.value).preference;
	};
	const work = /* @__PURE__ */ new Map();
	const presence = new PresenceRegistry();
	let stopped = false;
	let active = 0;
	const pending = /* @__PURE__ */ new Set();
	ctx.sessionProjections.register(progressProjection);
	const stateOf = (agent) => {
		const state = ctx.sessionProjections.stateOf(agent.session, "progress-check");
		if (state === void 0) throw new Error("progress-check projection is unavailable");
		return state;
	};
	const running = (entry) => !stopped && work.get(entry.agent.session.id) === entry && entry.agent.status === "running";
	const watched = (entry) => !config.onlyWhenVisible || presence.watched(entry.agent.session.id);
	const stopTimer = (entry) => {
		if (entry.timer !== void 0) clearTimeout(entry.timer);
		entry.timer = void 0;
		if (entry.startedAt !== void 0) entry.remaining = Math.max(0, entry.remaining - (performance.now() - entry.startedAt));
		entry.startedAt = void 0;
	};
	const pause = (entry) => {
		stopTimer(entry);
		entry.operation?.controller.abort(/* @__PURE__ */ new Error("agent stopped working"));
		entry.snapshot = void 0;
	};
	const arm = (entry) => {
		if (!running(entry) || entry.timer !== void 0 || entry.due || entry.operation !== void 0) return;
		entry.startedAt = performance.now();
		entry.timer = setTimeout(() => {
			entry.timer = void 0;
			entry.startedAt = void 0;
			entry.remaining = 0;
			entry.due = true;
			pump();
		}, entry.remaining);
		entry.timer.unref?.();
	};
	const reset = (entry) => {
		entry.due = false;
		entry.remaining = config.intervalMs;
		arm(entry);
	};
	const attach = (agent) => {
		if (work.has(agent.session.id) || !config.includeSubagents && agent.session.header.origin === "subagent") return;
		const state = stateOf(agent);
		const entry = {
			agent,
			remaining: config.intervalMs,
			startedAt: void 0,
			timer: void 0,
			due: false,
			snapshot: void 0,
			operation: void 0,
			covered: state.covered
		};
		work.set(agent.session.id, entry);
		arm(entry);
	};
	const flush = async (entry) => {
		if (!await ctx.sessions.flush(entry.agent.session)) throw new Error("progress-check requires durable session persistence");
	};
	const check = async (entry, snapshot, controller) => {
		const id = randomUUID();
		const { session } = entry.agent;
		const abort = () => controller.abort(snapshot.signal?.reason);
		snapshot.signal?.addEventListener("abort", abort, { once: true });
		if (snapshot.signal?.aborted) abort();
		try {
			for (let attempt = 1;; attempt++) {
				const assembler = new BlockAssembler();
				const chunks = [];
				let finished = false;
				let bytes = 0;
				let truncated = false;
				let requestRecorded = false;
				let responseRecorded = false;
				let preparedConfig = false;
				let stage = "prepare";
				let request = {
					...snapshot.request,
					messages: [...snapshot.request.messages, {
						role: "user",
						content: [{
							type: "text",
							text: createQuestion(outputLocale(), attempt > 1)
						}]
					}]
				};
				const recordRequest = () => {
					appendPluginRecord(session, "plugin:progress-check/request", {
						version: 1,
						id,
						attempt,
						prepared: preparedConfig,
						sessionId: session.id,
						coveredToolCount: snapshot.toolCount,
						contextSeq: snapshot.seq,
						request
					});
					requestRecorded = true;
				};
				const recordResponse = () => {
					let blocks = [];
					let assemblyError;
					try {
						blocks = assembler.blocks();
					} catch (error) {
						assemblyError = error instanceof Error ? error.message : String(error);
					}
					appendPluginRecord(session, "plugin:progress-check/response", {
						version: 1,
						id,
						attempt,
						sessionId: session.id,
						text: blocks.filter((block) => block.type === "text").map((block) => block.text).join(""),
						chunks,
						blocks,
						receivedBytes: bytes,
						truncated,
						...assemblyError === void 0 ? {} : { assemblyError },
						...finished ? { finish: assembler.finish } : {},
						...assembler.usage === void 0 ? {} : { usage: assembler.usage }
					});
					responseRecorded = true;
				};
				try {
					controller.signal.throwIfAborted();
					const prepared = await ctx.llm.prepareCall(request, controller.signal);
					request = {
						...request,
						...prepared.config
					};
					preparedConfig = true;
					controller.signal.throwIfAborted();
					stage = "request";
					recordRequest();
					await flush(entry);
					controller.signal.throwIfAborted();
					stage = "response";
					for await (const chunk of prepared.stream({
						...request,
						signal: controller.signal
					})) {
						controller.signal.throwIfAborted();
						bytes += Buffer.byteLength(JSON.stringify(chunk), "utf8");
						if (bytes > config.maxResponseBytes) {
							truncated = true;
							throw new Error("progress-check response exceeded maxResponseBytes");
						}
						chunks.push(structuredClone(chunk));
						if (chunk.type === "tool-call-delta" || chunk.type === "block-start" && chunk.blockType === "tool-call" || chunk.type === "block-end" && chunk.block.type === "tool-call") throw new Error("progress-check model attempted a tool call");
						assembler.push(chunk);
						if (chunk.type === "finish") finished = true;
					}
					controller.signal.throwIfAborted();
					if (!running(entry)) throw new Error("agent stopped working");
					if (!finished || assembler.finish.kind !== "stop") throw new Error(`progress-check did not finish normally (${assembler.finish.kind})`);
					stage = "persist";
					recordResponse();
					await flush(entry);
					controller.signal.throwIfAborted();
					const text = assembler.blocks().filter((block) => block.type === "text").map((block) => block.text).join("");
					stage = "parse";
					const report = modelReportSchema.parse(JSON.parse(text.replace(/^\s*```(?:json)?\s*\n/u, "").replace(/\n```\s*$/u, "")));
					stage = "persist";
					const seq = appendPluginRecord(session, "plugin:progress-check/result", {
						version: 1,
						id,
						attempt,
						sessionId: session.id,
						coveredToolCount: snapshot.toolCount,
						contextSeq: snapshot.seq,
						report,
						blocks: assembler.blocks(),
						...assembler.usage === void 0 ? {} : { usage: assembler.usage }
					});
					await flush(entry);
					entry.covered = snapshot.toolCount;
					return {
						ok: true,
						seq
					};
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					const retryable = stage === "parse";
					if (ctx.sessions.get(session.id) !== session) return {
						ok: false,
						message
					};
					try {
						if (!requestRecorded) recordRequest();
						if (!responseRecorded) recordResponse();
						appendPluginRecord(session, "plugin:progress-check/failure", {
							version: 1,
							id,
							attempt,
							sessionId: session.id,
							stage,
							retryable,
							message,
							canceled: controller.signal.aborted,
							...error instanceof Error && error.stack !== void 0 ? { stack: error.stack } : {}
						});
						await flush(entry);
					} catch (persistError) {
						ctx.logger.warn(`progress-check ${id}: could not persist attempt ${attempt}: ${String(persistError)}`);
						return {
							ok: false,
							message
						};
					}
					if (!controller.signal.aborted) ctx.logger.warn(`progress-check ${id}, attempt ${attempt}, ${stage}: ${message}`);
					if (!retryable || attempt > config.maxParseRetries || controller.signal.aborted || !running(entry)) return {
						ok: false,
						message
					};
				}
			}
		} finally {
			snapshot.signal?.removeEventListener("abort", abort);
		}
	};
	const settle = (entry, operation, outcome) => {
		if (entry.operation !== operation) return;
		if (operation.phase === "running") active--;
		operation.cleanup();
		pending.delete(operation.promise);
		entry.operation = void 0;
		operation.resolve(outcome);
		reset(entry);
		pump();
	};
	const queue = (entry, signal) => {
		stopTimer(entry);
		entry.due = false;
		const controller = new AbortController();
		const completion = Promise.withResolvers();
		const timeout = setTimeout(() => controller.abort(/* @__PURE__ */ new Error("progress-check timed out")), config.timeoutMs);
		timeout.unref?.();
		const abortCaller = () => controller.abort(signal?.reason);
		const abortQueued = () => {
			if (operation.phase === "queued") settle(entry, operation, {
				ok: false,
				message: controller.signal.reason instanceof Error ? controller.signal.reason.message : "progress-check canceled"
			});
		};
		const operation = {
			controller,
			phase: "queued",
			promise: completion.promise,
			resolve: completion.resolve,
			cleanup: () => {
				clearTimeout(timeout);
				signal?.removeEventListener("abort", abortCaller);
				controller.signal.removeEventListener("abort", abortQueued);
			}
		};
		entry.operation = operation;
		pending.add(operation.promise);
		controller.signal.addEventListener("abort", abortQueued, { once: true });
		signal?.addEventListener("abort", abortCaller, { once: true });
		if (signal?.aborted) abortCaller();
		return operation;
	};
	function pump() {
		if (stopped) return;
		for (const entry of work.values()) {
			if (!running(entry) || entry.operation?.phase === "running") continue;
			if (entry.operation === void 0 && !entry.due) continue;
			const snapshot = entry.snapshot;
			if (snapshot === void 0) continue;
			if (entry.operation === void 0) {
				if (snapshot.toolCount - entry.covered <= config.toolCallThreshold) {
					reset(entry);
					continue;
				}
				if (!watched(entry)) continue;
			}
			if (active >= config.maxConcurrent) break;
			const operation = entry.operation ?? queue(entry);
			operation.phase = "running";
			active++;
			Promise.resolve().then(() => check(entry, snapshot, operation.controller)).then((outcome) => settle(entry, operation, outcome), (error) => settle(entry, operation, {
				ok: false,
				message: String(error)
			}));
		}
	}
	ctx.provide("progressCheck", {
		generate: (sessionId, signal) => {
			const entry = work.get(sessionId);
			if (entry === void 0 || !running(entry)) return Promise.resolve({
				ok: false,
				message: "progress-check requires a running session"
			});
			if (signal.aborted) return Promise.resolve({
				ok: false,
				message: "progress-check canceled"
			});
			const operation = entry.operation ?? queue(entry, signal);
			pump();
			return operation.promise;
		},
		reportPresence: (report) => {
			presence.report(report);
			pump();
		}
	});
	ctx.inject(["connection", "webServer"], (scope) => {
		const invalid = () => ({
			ok: false,
			error: {
				code: "progress-check/invalid-request",
				message: "invalid progress-check request",
				details: {}
			}
		});
		scope.connection.rpc.handle(PROGRESS_CHANNEL, async (endpoint, payload, signal) => {
			if (endpoint === "presence") {
				const report = presenceReportSchema.safeParse(payload);
				if (!report.success) return invalid();
				ctx.progressCheck.reportPresence(report.data);
				return {
					ok: true,
					value: {}
				};
			}
			const request = generateRequestSchema.safeParse(payload);
			if (endpoint !== "generate" || !request.success) return invalid();
			const outcome = await ctx.progressCheck.generate(SessionId(request.data.sessionId), signal);
			return outcome.ok ? {
				ok: true,
				value: { seq: outcome.seq }
			} : {
				ok: false,
				error: {
					code: "progress-check/failed",
					message: outcome.message,
					details: {}
				}
			};
		});
	});
	ctx.on("agent/created", ({ agent }) => {
		attach(agent);
	}, { global: true });
	ctx.on("agent/status", ({ agent, status }) => {
		attach(agent);
		const entry = work.get(agent.session.id);
		if (entry === void 0) return;
		if (status === "idle") pause(entry);
		else arm(entry);
	}, { global: true });
	ctx.on("agent/disposed", ({ agent }) => {
		const entry = work.get(agent.session.id);
		if (entry === void 0) return;
		pause(entry);
		work.delete(agent.session.id);
	}, { global: true });
	ctx.on("session/event", (session, event) => {
		const entry = work.get(session.id);
		if (entry !== void 0 && "surfaceOp" in event && event.surfaceOp !== void 0) entry.snapshot = void 0;
	}, { global: true });
	ctx.on("llm/stream", (options, next) => {
		if (isAgentLoopRequest(options) && options.sessionId !== void 0) {
			const entry = work.get(options.sessionId);
			if (entry !== void 0 && running(entry)) {
				const { signal, ...request } = options;
				const state = stateOf(entry.agent);
				entry.snapshot = {
					request: structuredClone(request),
					signal,
					toolCount: state.toolCount,
					seq: state.seq
				};
				pump();
			}
		}
		return next();
	}, {
		global: true,
		prepend: true
	});
	ctx.effect(() => () => {
		stopped = true;
		for (const entry of work.values()) pause(entry);
		work.clear();
		presence.clear();
		return Promise.allSettled([...pending]).then(() => {});
	});
	for (const agent of ctx.agents.list()) attach(agent);
}
//#endregion
export { Config, apply, inject };

//# sourceMappingURL=index.js.map