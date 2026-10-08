// What the agent does differently for mlx-vlm's server (NERD_LLAMA=mlx,
// macOS): the model it loaded from /health, the thinking switch Pi sends, the
// sampling fields of NERD_SAMPLING. Against a stand-in HTTP server, no model.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { localModel, mlxLoadedModel, modelDefinition } from "../src/local.ts";
import { parseSampling, sampling, withSampling } from "../src/sampling.ts";

// Two servers: llama-server's /health ({"status":"ok"}, /props with n_ctx) and
// mlx-vlm's (/health names the loaded model; /v1/models lists a cached one first).
function serve(routes: Record<string, unknown>): Promise<Server> {
	const s = createServer((req, res) => {
		const body = routes[req.url ?? ""];
		res.writeHead(body === undefined ? 404 : 200, { "content-type": "application/json" });
		res.end(JSON.stringify(body ?? { error: "not found" }));
	});
	return new Promise((ok) => s.listen(0, "127.0.0.1", () => ok(s)));
}
const url = (s: Server) => `http://127.0.0.1:${(s.address() as AddressInfo).port}/v1`;

let llama: Server;
let mlx: Server;
const loaded = "/Users/me/.nerd/mlx-models/prism-ml--Ternary-Bonsai-2-27B-mlx-2bit";
before(async () => {
	llama = await serve({
		"/health": { status: "ok" },
		"/props": { default_generation_settings: { n_ctx: 65536 } },
		"/v1/models": { data: [{ id: "bonsai2-q1" }] },
	});
	mlx = await serve({
		"/health": { status: "healthy", loaded_model: loaded, effective_context_limit: 262144 },
		"/v1/models": { data: [{ id: "a-cached/model" }, { id: loaded }] },
	});
});
after(() => {
	llama.close();
	mlx.close();
});

async function withEnv<T>(env: Record<string, string | undefined>, f: () => Promise<T>): Promise<T> {
	const old: Record<string, string | undefined> = {};
	for (const k of Object.keys(env)) {
		old[k] = process.env[k];
		if (env[k] === undefined) delete process.env[k];
		else process.env[k] = env[k];
	}
	try {
		return await f();
	} finally {
		for (const k of Object.keys(old)) {
			if (old[k] === undefined) delete process.env[k];
			else process.env[k] = old[k];
		}
	}
}

test("llama-server: model and context from the server, thinking through the chat template", async () => {
	const m = await withEnv({ NERD_BASE_URL: url(llama), NERD_CTX: undefined, NERD_MODEL: undefined }, localModel);
	assert.equal(await mlxLoadedModel(url(llama)), undefined);
	assert.equal(m.server, "llama");
	assert.equal(m.id, "bonsai2-q1");
	assert.equal(m.ctx, 65536);
	assert.equal(modelDefinition(m).compat.thinkingFormat, "qwen-chat-template");
});

test("mlx-vlm: the loaded model, not the first of /v1/models; context from NERD_CTX; top-level enable_thinking", async () => {
	const m = await withEnv({ NERD_BASE_URL: url(mlx), NERD_CTX: "65536", NERD_MODEL: undefined }, localModel);
	assert.equal(m.server, "mlx");
	assert.equal(m.id, loaded);
	assert.equal(m.ctx, 65536);
	assert.equal(modelDefinition(m).compat.thinkingFormat, "qwen");
	// An empty NERD_MODEL (compose passes "" when unset) does not win over the server.
	const e = await withEnv({ NERD_BASE_URL: url(mlx), NERD_CTX: "", NERD_MODEL: "" }, localModel);
	assert.equal(e.id, loaded);
	assert.equal(e.ctx, 16384);
});

test("NERD_SAMPLING: parsed, added only where the request has no value, junk refused", () => {
	assert.deepEqual(parseSampling(undefined), {});
	assert.deepEqual(parseSampling(" temperature=0.7, top_p=0.8 ,top_k=20,presence_penalty=1.5 "), {
		temperature: 0.7,
		top_p: 0.8,
		top_k: 20,
		presence_penalty: 1.5,
	});
	assert.throws(() => parseSampling("temp=0.7"), /NERD_SAMPLING/);
	assert.throws(() => parseSampling("temperature=hot"), /NERD_SAMPLING/);
	assert.throws(() => parseSampling("temperature="), /NERD_SAMPLING/);
	const payload = { model: "m", temperature: 0.2, messages: [] };
	assert.deepEqual(withSampling(payload, { temperature: 0.7, top_k: 20 }), {
		model: "m",
		temperature: 0.2,
		messages: [],
		top_k: 20,
	});
	assert.equal(payload.temperature, 0.2, "the original payload is not changed");
	assert.equal(withSampling("raw", { top_k: 20 }), "raw");
});

test("sampling() hooks before_provider_request only when there is something to add", () => {
	const hooks: Record<string, (e: { payload: unknown }) => unknown> = {};
	const pi = { on: (name: string, h: (e: { payload: unknown }) => unknown) => (hooks[name] = h) } as never;
	sampling(pi, {});
	assert.ok(!("before_provider_request" in hooks));
	sampling(pi, { top_k: 20 });
	assert.deepEqual(hooks.before_provider_request({ payload: { messages: [] } }), { messages: [], top_k: 20 });
});
