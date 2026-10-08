// Headless run of Pi's agent core against a local llama-server (decision 0007).
//
//   node src/run.ts <workspace-dir> "<task>" [--log events.jsonl]
//
// Environment:
//   NERD_BASE_URL  OpenAI-compatible endpoint (default http://127.0.0.1:18091/v1)
//   NERD_MODEL     model id to report (default: whatever the server serves;
//                  for mlx-vlm's server, the model its /health says it loaded)
//   NERD_CTX       the server's context size in tokens (default: llama-server's
//                  /props, else 16384)
//   NERD_SAMPLING  sampling fields added to every request that does not set
//                  them, e.g. "temperature=0.7,top_p=0.8,top_k=20" (src/sampling.ts)
//   NERD_THINKING  off | low | medium | high (default off)
//   NERD_VERIFY_N  candidates per step for the verifier (default 1: plain loop)
//   NERD_BASH_TIMEOUT  seconds a bash call may run when the model gives no
//                  timeout (default 600; src/bash-tool.ts)
//   NERD_SPEC_CHECK=1  after the first "done", check the task text clause by
//                  clause (src/spec-check.ts); NERD_SPEC_CHECK_ROUNDS bounds the
//                  re-checks (default 3); NERD_SPEC_CHECK_SNAPSHOT=<dir> copies
//                  the workspace there before the check, for measurement
//   NERD_PLAN_STEP=0  no questions-and-plan turn before the work (src/plan-step.ts);
//                  NERD_PLAN_ANSWER answers its questions (default «на твоё усмотрение»)
//   NERD_LOOP_GUARD_N  repeats of one call (same arguments, same result) before
//                  the loop guard's note (default 3, 0 = off; src/loop-guard.ts)
//   NERD_FETCH_GUARD=0  no note on a web_fetch 404 for an address that no
//                  web_search result had (src/fetch-guard.ts)
//   NERD_LINT=0    no linter after write/edit (src/lint-check.ts)
//   NERD_DONE_GATE=0  no check of the committed project when a turn of work
//                  ends (src/done-gate.ts); NERD_DONE_GATE_ROUNDS bounds the
//                  messages it sends back per operator message (default 2)
//   NERD_BASH_MAX_CHARS  a longer bash output reaches the model as head and tail,
//                  the whole of it in a file (default 8000, 0 = off; src/output-cap.ts)
//   NERD_QUIET=0   no quiet defaults (NO_COLOR, npm fund/audit, ...) for the
//                  model's commands (src/bash-tool.ts)
//   NERD_WEB_NOTES=0  no copy of each fetched web page in notes/web/ of the
//                  project (src/web-notes.ts)
//   NERD_ANCHORS=0  no anchors (task, PLAN.md, notes/, changed files) after a
//                  compaction; NERD_ANCHORS_MAX_CHARS bounds them (4000; src/anchors.ts)
//   NERD_PI_VCC, NERD_TODO  Pi packages on (1) or off (0): src/packages.ts
//   NERD_SESSION_DIR  where the session file goes (default: the run's temp agent dir)
//
// The temp agent dir (under $TMPDIR) is removed when the run ends, unless the
// session is in it (no NERD_SESSION_DIR): then its path is printed.
//
// The interactive counterpart is tui.ts; what both share is in local.ts.

import { appendFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { harness } from "./harness.ts";
import { headlessSession } from "./headless.ts";
import { localModel, modelDefinition, settingsFor, stayOffline, withVerifier } from "./local.ts";
import { enabledPackages } from "./packages.ts";
import { runSpecCheck } from "./spec-check.ts";

stayOffline();

function arg(name: string): string | undefined {
	const i = process.argv.indexOf(name);
	return i > 0 ? process.argv[i + 1] : undefined;
}

async function main() {
	const [workspace, task] = process.argv.slice(2);
	if (!workspace || !task) {
		console.error('usage: node src/run.ts <workspace-dir> "<task>" [--log events.jsonl]');
		process.exit(2);
	}
	const cwd = resolve(workspace);
	mkdirSync(cwd, { recursive: true });
	const logPath = arg("--log");
	const local = await localModel();
	const { baseUrl, ctx, thinking, id: modelId } = local;

	// Pi reads custom endpoints from models.json in its agent directory; keep
	// that directory private to the run so nothing leaks between runs.
	const agentDir = mkdtempSync(join(tmpdir(), "nerd-agent-"));
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				local: { baseUrl, api: "openai-completions", apiKey: "none", models: [modelDefinition(local)] },
			},
		}),
	);

	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
	});
	const model = modelRuntime.getModel("local", modelId);
	if (!model) throw new Error(`model local/${modelId} not registered`);

	// No operator here: the plan step answers its questions with NERD_PLAN_ANSWER.
	const session = await headlessSession({
		cwd,
		agentDir,
		model,
		modelRuntime,
		thinking,
		settings: settingsFor(local),
		extensions: [harness(false)],
		// A file, so vcc_recall (NERD_PI_VCC) has something to search.
		sessionDir: process.env.NERD_SESSION_DIR ?? join(agentDir, "sessions"),
	});

	// Best-of-N with the verifier (decisions 0005, 0007): NERD_VERIFY_N=1 or
	// unset runs the plain loop.
	const verifyN = local.verifyN;
	if (verifyN > 1) {
		session.agent.streamFunction = withVerifier(
			session.agent.streamFunction,
			local,
			logPath ? logPath.replace(/\.jsonl$/, "") + ".verifier.jsonl" : undefined,
		);
	}

	const t0 = Date.now();
	const compactionFailures: string[] = [];
	console.log(`[model ${modelId}, context ${ctx}, thinking ${thinking}, verify N=${verifyN}, spec check ${process.env.NERD_SPEC_CHECK === "1" ? "on" : "off"}, packages ${enabledPackages().map((p) => p.name).join(" ") || "none"}]`);
	session.subscribe((event) => {
		if (logPath) appendFileSync(logPath, `${JSON.stringify({ t: Date.now() - t0, ...event })}\n`);
		const ev = event as { type: string; errorMessage?: string };
		if (ev.type === "compaction_end" && ev.errorMessage) {
			compactionFailures.push(ev.errorMessage);
			process.stdout.write(`\n[compaction failed: ${ev.errorMessage}]\n`);
		}
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			process.stdout.write(event.assistantMessageEvent.delta);
		} else if (event.type === "tool_execution_start") {
			process.stdout.write(`\n[tool ${event.toolName}] ${JSON.stringify(event.args).slice(0, 200)}\n`);
		} else if (event.type === "tool_execution_end") {
			process.stdout.write(`[tool ${event.toolName} done${event.isError ? ", ERROR" : ""}]\n`);
		}
	});

	try {
		await session.prompt(task);
		// Spec check before done (ticket 030): off unless NERD_SPEC_CHECK=1, and
		// only after a first reply that ended by itself.
		const first = session.messages.at(-1) as { role?: string; stopReason?: string };
		if (process.env.NERD_SPEC_CHECK === "1" && first?.role === "assistant" && first.stopReason === "stop") {
			const maxRounds = Number(process.env.NERD_SPEC_CHECK_ROUNDS ?? 3);
			// For measurement: the workspace as it was at the first "done".
			const snap = process.env.NERD_SPEC_CHECK_SNAPSHOT;
			if (snap) cpSync(cwd, snap, { recursive: true, filter: (p) => !p.includes("/node_modules") });
			await runSpecCheck(session, task, {
				maxRounds,
				onRound: (r) => {
					if (logPath) appendFileSync(logPath, `${JSON.stringify({ t: Date.now() - t0, type: "spec_check_round", ...r })}\n`);
					const v = r.verdict ? `${r.verdict.clauses} clauses, ${r.verdict.failed} failed` : "no verdict";
					process.stdout.write(`\n[spec check round ${r.round}/${maxRounds}: ${v}]\n`);
				},
			});
		}
		// A run can end quietly without finishing: a failed model call, a reply cut
		// at the token cap (context full), a compaction that could not summarise.
		// Only a final assistant reply that stopped by itself counts as done.
		const last = session.messages.at(-1) as { role?: string; stopReason?: string; errorMessage?: string };
		const secs = ((Date.now() - t0) / 1000).toFixed(0);
		const why =
			last?.role !== "assistant"
				? `ended on a ${last?.role ?? "missing"} message`
				: last.stopReason !== "stop"
					? `last reply stopped with ${last.stopReason}${last.errorMessage ? `: ${last.errorMessage}` : ""}`
					: undefined;
		if (why || compactionFailures.length) {
			const extra = compactionFailures.length ? `; compaction failed ${compactionFailures.length}x` : "";
			console.error(`\n[NOT DONE after ${secs} s: ${why ?? "finished"}${extra}]`);
			process.exitCode = 1;
		} else {
			console.log(`\n[done in ${secs} s, ${session.messages.length} messages]`);
		}
	} finally {
		session.dispose();
		if (process.env.NERD_SESSION_DIR) rmSync(agentDir, { recursive: true, force: true });
		else console.log(`[agent dir kept, the session is in it: ${agentDir}]`);
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
