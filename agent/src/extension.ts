// nerd as a Pi extension, for Pi's own interactive TUI (tui.ts loads it
// inline; `pi -e src/extension.ts` works too). It adds what run.ts sets up for
// the headless run:
//
//   - provider "local": the llama-server at NERD_BASE_URL, with the model
//     definition from local.ts (NERD_THINKING=off really off, the window from
//     the server's /props);
//   - the verifier, when NERD_VERIFY_N > 1: the provider's stream function is
//     best-of-N around the plain OpenAI-completions stream. Candidates are drawn
//     whole, so the TUI shows a step only once the verifier picked it;
//   - bash with a default timeout, NERD_BASH_TIMEOUT (600 s; bash-tool.ts);
//   - the harness (harness.ts, ticket 043): a questions-and-plan turn without
//     write tools at the start of a task (the first message, or /task <text>),
//     whose questions wait for the operator; the loop guard on tool results;
//   - /spec-check [task]: the clause-by-clause check of ticket 030, on demand.
//     The task is the argument, or else the first user message of the session.
//     Rounds repeat while checks fail, up to NERD_SPEC_CHECK_ROUNDS (3).
//     In a conversation the run has no single "done", so it is not automatic.

import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { AssistantMessageEventStream, Model, Api } from "@earendil-works/pi-ai";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { nerdBashTool } from "./bash-tool.ts";
import { localModel, modelDefinition, withVerifier } from "./local.ts";
import { harness } from "./harness.ts";
import { parseVerdict, specCheckPrompt } from "./spec-check.ts";

const VERIFIED_API = "nerd-verified";

type Entry = { type?: string; message?: { role?: string; stopReason?: string; content?: unknown } };

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c: { type?: string }) => c.type === "text")
		.map((c: { text?: string }) => c.text ?? "")
		.join("\n");
}

export default async function nerd(pi: ExtensionAPI) {
	const local = await localModel();
	const verify = local.verifyN > 1;

	// The plain stream for the local server, whatever api name the provider carries.
	const plain: StreamFn = (model, context, options) =>
		getApiProvider("openai-completions")!.streamSimple({ ...model, api: "openai-completions" } as Model<Api>, context, options);
	const verified = verify
		? withVerifier(plain, local, process.env.NERD_VERIFY_LOG)
		: undefined;

	// bash with a default timeout (bash-tool.ts), in place of the built-in one.
	pi.registerTool(nerdBashTool(process.cwd()));
	// An operator answers the plan step's questions here.
	await harness(true)(pi);

	pi.registerProvider("local", {
		name: "nerd local llama-server",
		baseUrl: local.baseUrl,
		apiKey: "none",
		api: verify ? (VERIFIED_API as Api) : "openai-completions",
		models: [modelDefinition(local)],
		// The composer awaits what the handler returns, so the verifier's async stream function fits.
		...(verified
			? { streamSimple: (m, c, o) => verified(m, c, o) as unknown as AssistantMessageEventStream }
			: {}),
	});

	const maxRounds = Number(process.env.NERD_SPEC_CHECK_ROUNDS ?? 3);
	let check: { task: string; round: number } | undefined;

	pi.registerCommand("spec-check", {
		description: "Check the work against the task text, clause by clause (ticket 030)",
		handler: async (args, ctx) => {
			let task = args.trim();
			if (!task) {
				const first = (ctx.sessionManager.getBranch() as Entry[]).find((e) => e.type === "message" && e.message?.role === "user");
				task = textOf(first?.message?.content);
			}
			if (!task) {
				ctx.ui.notify("spec-check: no task (give it as the argument)", "error");
				return;
			}
			check = { task, round: 1 };
			pi.sendUserMessage(specCheckPrompt(task, 1), ctx.isIdle() ? undefined : { deliverAs: "followUp" });
		},
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!check) return;
		const last = (ctx.sessionManager.getBranch() as Entry[]).filter((e) => e.type === "message").at(-1)?.message;
		const verdict = last?.role === "assistant" ? parseVerdict(textOf(last.content)) : undefined;
		const v = verdict ? `${verdict.clauses} clauses, ${verdict.failed} failed` : "no verdict";
		ctx.ui.notify(`spec check round ${check.round}/${maxRounds}: ${v}`, verdict?.failed === 0 ? "info" : "warning");
		if (last?.stopReason !== "stop" || verdict?.failed === 0 || check.round >= maxRounds) {
			check = undefined;
			return;
		}
		check.round++;
		pi.sendUserMessage(specCheckPrompt(check.task, check.round));
	});
}
