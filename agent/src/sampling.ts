// Sampling settings sent with every request (NERD_SAMPLING). llama-server
// samples with its own defaults when a request names none; mlx-vlm's server
// decodes greedily instead (it does not read the model's
// generation_config.json), and greedy decoding of a 2-bit model repeats
// itself. ./UP sets NERD_SAMPLING for NERD_LLAMA=mlx to the values the
// model's card gives for non-thinking use; anyone may set it for either server.
//
//   NERD_SAMPLING="temperature=0.7,top_p=0.8,top_k=20,presence_penalty=1.5"
//
// A field the request already has is left as it is.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const FIELDS = new Set([
	"temperature",
	"top_p",
	"top_k",
	"min_p",
	"presence_penalty",
	"frequency_penalty",
	"repetition_penalty",
]);

/** "temperature=0.7,top_p=0.8" → { temperature: 0.7, top_p: 0.8 }; an unknown field or a value that is not a number throws. */
export function parseSampling(text: string | undefined): Record<string, number> {
	const out: Record<string, number> = {};
	for (const part of (text ?? "").split(",")) {
		const item = part.trim();
		if (!item) continue;
		const [key, value, ...rest] = item.split("=").map((s) => s.trim());
		const n = Number(value);
		if (!FIELDS.has(key) || rest.length || value === undefined || value === "" || !Number.isFinite(n)) {
			throw new Error(`NERD_SAMPLING: '${item}' is not one of ${[...FIELDS].join(", ")} = <number>`);
		}
		out[key] = n;
	}
	return out;
}

/** The payload with the fields of `values` it does not set yet. */
export function withSampling(payload: unknown, values: Record<string, number>): unknown {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
	const p = { ...(payload as Record<string, unknown>) };
	for (const [k, v] of Object.entries(values)) if (p[k] === undefined) p[k] = v;
	return p;
}

export function sampling(pi: Pick<ExtensionAPI, "on">, values: Record<string, number>) {
	if (!Object.keys(values).length) return;
	pi.on("before_provider_request", (event) => withSampling(event.payload, values));
}
