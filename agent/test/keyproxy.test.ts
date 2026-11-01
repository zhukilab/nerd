// The key proxy of NERD_LLAMA=provider (keyproxy.ts): the provider gets the key
// and only the key, whatever the agent sends; paths outside /v1 go nowhere; a
// streamed reply comes through as it streams. Against a stand-in provider.
import assert from "node:assert/strict";
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { keyProxy, parseKeys, upstreamUrl } from "../src/keyproxy.ts";

const KEY = "sk-test-0123456789";
let provider: Server;
let proxy: Server;
let seen: { url?: string; headers?: IncomingHttpHeaders; body?: string } = {};
const lines: string[] = [];
const port = (s: Server) => (s.address() as AddressInfo).port;
const listen = (s: Server) => new Promise<Server>((ok) => s.listen(0, "127.0.0.1", () => ok(s)));

before(async () => {
	provider = await listen(
		createServer((req, res) => {
			let body = "";
			req.on("data", (c) => (body += c));
			req.on("end", () => {
				seen = { url: req.url, headers: req.headers, body };
				if (req.url === "/api/v1/chat/completions") {
					// Two SSE events with a pause between: the proxy must not buffer.
					res.writeHead(200, { "content-type": "text/event-stream" });
					res.write("data: one\n\n");
					setTimeout(() => res.end("data: [DONE]\n\n"), 50);
				} else {
					res.writeHead(401, { "content-type": "application/json" });
					res.end(JSON.stringify({ error: "no" }));
				}
			});
		}),
	);
	proxy = await listen(keyProxy(parseKeys(`${KEY}\n`, `http://127.0.0.1:${port(provider)}/api/v1`), (l) => lines.push(l)));
});
after(() => {
	proxy.close();
	provider.close();
});

const base = () => `http://127.0.0.1:${port(proxy)}`;

test("/v1/<path> goes to the provider's base with the key, the agent's credentials dropped", async () => {
	const r = await fetch(`${base()}/v1/chat/completions`, {
		method: "POST",
		headers: { authorization: "Bearer none", "x-api-key": "planted", "content-type": "application/json" },
		body: JSON.stringify({ model: "m", stream: true }),
	});
	assert.equal(r.status, 200);
	assert.equal(await r.text(), "data: one\n\ndata: [DONE]\n\n");
	assert.equal(seen.url, "/api/v1/chat/completions");
	assert.equal(seen.headers?.authorization, `Bearer ${KEY}`);
	assert.equal(seen.headers?.["x-api-key"], undefined);
	assert.equal(seen.headers?.["content-type"], "application/json");
	assert.deepEqual(JSON.parse(seen.body ?? ""), { model: "m", stream: true });
});

test("a streamed reply arrives before the provider finishes it", async () => {
	const r = await fetch(`${base()}/v1/chat/completions`, { method: "POST", body: "{}" });
	const reader = r.body!.getReader();
	const chunk = await reader.read(); // whole-read: the first chunk of a stream, a few bytes
	assert.equal(new TextDecoder().decode(chunk.value), "data: one\n\n");
	await reader.cancel();
});

test("the provider's status passes through; the log has the request, never the key", async () => {
	const r = await fetch(`${base()}/v1/models`);
	assert.equal(r.status, 401);
	await r.text();
	assert.ok(lines.some((l) => / GET \/v1\/models 401 /.test(l)));
	assert.ok(!lines.some((l) => l.includes(KEY)));
});

test("/health names the provider; other paths go nowhere", async () => {
	assert.deepEqual(await (await fetch(`${base()}/health`)).json(), { keyproxy: `127.0.0.1:${port(provider)}` });
	const n = seen;
	assert.equal((await fetch(`${base()}/api/v1/models`)).status, 404);
	assert.equal((await fetch(`${base()}/v10/x`)).status, 404);
	assert.equal(seen, n);
	assert.equal(upstreamUrl("https://p.example/api/v1/", "/v1?x=1")?.href, "https://p.example/api/v1?x=1");
});

test("an unreachable provider is a 502 with its reason, not a hang", async () => {
	const dead = await listen(createServer());
	const p = port(dead);
	await new Promise((ok) => dead.close(ok));
	const s = await listen(keyProxy(parseKeys(KEY, `http://127.0.0.1:${p}/v1`), () => {}));
	const r = await fetch(`http://127.0.0.1:${port(s)}/v1/models`);
	assert.equal(r.status, 502);
	assert.match(((await r.json()) as { error: { message: string } }).error.message, /^keyproxy: /);
	s.close();
});

// The table (process ticket 103): free providers, each with its own key.
test("a table: every row at /<name>/v1 with its own key, the chosen one at /v1 too", async () => {
	const other = "sk-other-555";
	const table = `# free providers\nmain http://127.0.0.1:${port(provider)}/api/v1 ${KEY}\n\nalt  http://127.0.0.1:${port(provider)}/alt/v1  ${other}\n`;
	const s = await listen(keyProxy(parseKeys(table, "main"), () => {}));
	const at = `http://127.0.0.1:${port(s)}`;
	await (await fetch(`${at}/v1/chat/completions`, { method: "POST", body: "{}" })).text();
	assert.equal(seen.url, "/api/v1/chat/completions");
	assert.equal(seen.headers?.authorization, `Bearer ${KEY}`);
	await (await fetch(`${at}/alt/v1/models?x=1`)).text();
	assert.equal(seen.url, "/alt/v1/models?x=1");
	assert.equal(seen.headers?.authorization, `Bearer ${other}`);
	await (await fetch(`${at}/main/v1/models`)).text();
	assert.equal(seen.headers?.authorization, `Bearer ${KEY}`);
	assert.deepEqual(await (await fetch(`${at}/alt/health`)).json(), { keyproxy: `127.0.0.1:${port(provider)}` });
	const n = seen;
	assert.equal((await fetch(`${at}/nope/v1/models`)).status, 404);
	assert.equal((await fetch(`${at}/alt/models`)).status, 404);
	assert.equal(seen, n);
	s.close();
});

test("a table without a chosen row: /v1 is a 404 naming the rows", async () => {
	const s = await listen(keyProxy(parseKeys(`a http://127.0.0.1:1/v1 k1\nb http://127.0.0.1:1/v1 k2`, ""), () => {}));
	const r = await fetch(`http://127.0.0.1:${port(s)}/v1/models`);
	assert.equal(r.status, 404);
	assert.match(((await r.json()) as { error: { message: string } }).error.message, /one of a, b$/);
	s.close();
});

// The guard (process ticket 106): a key spent on the listed models only.
test("only=: a listed model goes on with its body whole; another, or no JSON, is refused before it leaves", async () => {
	const table = `free http://127.0.0.1:${port(provider)}/api/v1 ${KEY} only=m,m:free\nopen http://127.0.0.1:${port(provider)}/api/v1 ${KEY}`;
	const s = await listen(keyProxy(parseKeys(table, "free"), () => {}));
	const at = `http://127.0.0.1:${port(s)}`;
	const post = (path: string, body: string) => fetch(`${at}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body });
	const big = JSON.stringify({ model: "m:free", stream: true, messages: [{ role: "user", content: "x".repeat(200_000) }] });
	const ok = await post("/v1/chat/completions", big);
	assert.equal(ok.status, 200);
	await ok.text();
	assert.equal(seen.body, big, "the body read for its model goes on unchanged");
	const n = seen;
	for (const [body, status] of [
		[JSON.stringify({ model: "paid" }), 403],
		["{}", 403],
		["not json", 400],
		["[]", 400],
		// a listed model with a way to another model or a paid extra beside it
		[JSON.stringify({ model: "m:free", models: ["paid"] }), 403],
		[JSON.stringify({ model: "m:free", route: "fallback" }), 403],
		[JSON.stringify({ model: "m:free", preset: "p" }), 403],
		[JSON.stringify({ model: "m:free", plugins: [{ id: "web" }] }), 403],
	] as const) {
		const r = await post("/v1/chat/completions", body);
		assert.equal(r.status, status, body);
		assert.match(((await r.json()) as { error: { message: string } }).error.message, /^keyproxy: /);
	}
	for (const method of ["PUT", "PATCH", "DELETE"]) {
		const r = await fetch(`${at}/v1/chat/completions`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "paid" }) });
		assert.equal(r.status, 405, method);
		await r.text();
	}
	const getWithBody = await new Promise<number>((done, fail) => {
		const q = httpRequest(`${at}/v1/chat/completions`, { method: "GET", headers: { "content-length": "16" } }, (p) => {
			p.resume();
			done(p.statusCode ?? 0);
		});
		q.on("error", fail);
		q.end('{"model":"paid"}');
	});
	assert.equal(getWithBody, 405, "a GET with a body is not let through unread");
	assert.equal(seen, n, "nothing refused reached the provider");
	assert.equal((await fetch(`${at}/v1/models`)).status, 401, "a bodiless GET is not guarded: the model list goes through");
	await (await post("/open/v1/chat/completions", JSON.stringify({ model: "paid" }))).text();
	assert.notEqual(seen, n, "a row without only= takes any model");
	assert.deepEqual(parseKeys(KEY, "http://x/v1", " a , b ").get("")?.only, ["a", "b"], "one key: NERD_PROVIDER_MODELS");
	s.close();
});

// NERD_KEYPROXY_AUTH=on: a shared machine's other users reach the proxy on its network, not the token.
test("a token: a request without it, or with another, is a 401 and never reaches the provider; /health stays open", async () => {
	const TOKEN = "t0ken-of-this-start";
	const s = await listen(keyProxy(parseKeys(`${KEY}\n`, `http://127.0.0.1:${port(provider)}/api/v1`), () => {}, TOKEN));
	const at = `http://127.0.0.1:${port(s)}`;
	const ask = (auth?: string) =>
		fetch(`${at}/v1/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
			body: JSON.stringify({ model: "m" }),
		});
	seen = {};
	for (const auth of [undefined, "Bearer none", `Bearer ${TOKEN}x`, TOKEN, `bearer ${TOKEN}`]) {
		const r = await ask(auth);
		assert.equal(r.status, 401, String(auth));
		assert.ok(!(await r.text()).includes(TOKEN), "a refusal never shows the token");
	}
	assert.deepEqual(seen, {}, "nothing refused reached the provider");
	assert.equal((await fetch(`${at}/v1/models`)).status, 401, "a GET needs it too");
	assert.deepEqual(await (await fetch(`${at}/health`)).json(), { keyproxy: `127.0.0.1:${port(provider)}` });
	const ok = await ask(`Bearer ${TOKEN}`);
	assert.equal(ok.status, 200);
	await ok.text();
	assert.equal(seen.headers?.authorization, `Bearer ${KEY}`, "the token goes no further: the provider gets the key");
	s.close();
});

test("a bad key file is refused, and the refusal never shows a key", () => {
	const bad: [string, string, RegExp][] = [
		[KEY, "llm7", /must be the provider's URL/],
		[`a http://x/v1 ${KEY} extra`, "a", /line 1: a row is/],
		[`v1 http://x/v1 ${KEY}`, "", /"v1" cannot name/],
		[`a ftp://x ${KEY}`, "a", /base of a is not a URL/],
		[`a http://x/v1 ${KEY}\na http://y/v1 ${KEY}`, "a", /line 2: a again/],
		[`a http://x/v1 ${KEY}`, "b", /is "b", but the key file's table is a$/],
		["# nothing\n", "", /empty/],
		[`a http://x/v1 ${KEY} only=`, "a", /only= names no model/],
		[`a http://x/v1 ${KEY} x y`, "a", /line 1: a row is/],
	];
	for (const [text, chosen, why] of bad) {
		const e = (() => {
			try {
				parseKeys(text, chosen);
			} catch (err) {
				return (err as Error).message;
			}
			return "";
		})();
		assert.match(e, why, text);
		assert.ok(!e.includes(KEY), e);
	}
});
