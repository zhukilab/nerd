// The ping-pong pair (process ticket 075, after XP's ping-pong pairing): one model
// writes the plan with its Done when checks, another writes the code against them.
// Whoever wrote the checks is also who may correct them in the Ralph amend round
// (decision 0014 addendum), so the model that writes the code never writes a check
// it then has to pass. NERD_PLAN_BASE_URL names the planner's server (an
// OpenAI-compatible endpoint, registered as provider "planner", NERD_PLAN_MODEL its
// model id if the server's first is not it); unset, one model does both, as before.
// Whether the two servers run side by side or one after the other is the
// infrastructure's business, not the agent's.

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const PLANNER = "planner";

export function pairOn(env: Record<string, string | undefined> = process.env): boolean {
	return Boolean(env.NERD_PLAN_BASE_URL);
}

export type Role = "planner" | "worker";

/**
 * Moves the session between the pair's two models. The worker is whatever model
 * the session had when it first went to the planner. Without a planner
 * registered both moves do nothing. Pi takes a changed model on the next turn.
 */
export function pairSwitch(pi: ExtensionAPI) {
	let worker: Model<Api> | undefined;
	return async (role: Role, ctx: ExtensionContext): Promise<void> => {
		const now = ctx.model;
		if (role === "planner") {
			const planner = ctx.modelRegistry.getAll().find((m) => m.provider === PLANNER);
			if (!planner || now?.provider === PLANNER) return;
			worker = now;
			await pi.setModel(planner);
		} else if (worker && now?.provider === PLANNER) {
			await pi.setModel(worker);
		}
	};
}
