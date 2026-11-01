// The key proxy of NERD_LLAMA=provider (decision 0018, addendum of 2026-10-29):
// a cloud provider's key never enters the agent's container. This runs in a
// container of its own beside the agent, with the key mounted as a compose
// secret; the agent talks to it without a key, and it forwards each request to
// the provider with the key in the Authorization header. The model can use the
// key through it but cannot read it or carry it off.
//
//   node keyproxy.ts      NERD_PROVIDER_URL (e.g. https://openrouter.ai/api/v1,
//                         or the name of a row of the key file's table),
//                         NERD_PROVIDER_KEY_FILE (default /run/secrets/provider_key),
//                         NERD_KEYPROXY_HOST, NERD_KEYPROXY_PORT (default 0.0.0.0:18096),
//                         NERD_KEYPROXY_TOKEN (optional: the token a request must carry)
//
// The key file holds one key, for NERD_PROVIDER_URL, or a table of providers
// (process ticket 103: free providers' keys, each logged in on the host), a row
// "<name> <OpenAI-compatible base> <key>" per line, # comments:
//
//   llm7   https://api.llm7.io/v1           <token from token.llm7.io>
//   cline  https://api.cline.bot/api/v1     <API key>
//
// A row may end in "only=<model>,<model>" (one key: NERD_PROVIDER_MODELS): the key is spent on
// those models alone, a request for another is refused with 403 before it leaves (process
// ticket 106: a free model's key with credit on it, or a bench of free models only). So is
// a body that names other models or paid extras beside its own (`models`, `route`, `preset`,
// `plugins`), and any method but POST and a bodiless GET or HEAD (405).
//
// <proxy>/v1/<path> goes to <NERD_PROVIDER_URL>/<path> (with a table, to the row
// it names), <proxy>/<name>/v1/<path> to that row's base; /health and
// /<name>/health answer {"keyproxy": <provider's host>}, which is how the agent
// tells it from a model server (local.ts). One line per request on stdout
// (docker logs), never a key.
import { readFileSync } from "node:fs";
import {
	createServer,
	type IncomingHttpHeaders,
	type IncomingMessage,
	request as httpRequest,
	type Server,
	type ServerResponse,
} from "node:http";
import { timingSafeEqual } from "node:crypto";
import { request as httpsRequest } from "node:https";

export const KEYPROXY_PORT = 18096;

// Headers of the agent's side that do not go on: its own credentials (there are
// none, but nothing it sends may stand in for the key), the hop's own.
const DROP = new Set(["host", "authorization", "x-api-key", "connection", "keep-alive", "proxy-authorization", "transfer-encoding"]);

export function forwardHeaders(h: IncomingHttpHeaders, key: string): Record<string, string | string[]> {
	const out: Record<string, string | string[]> = {};
	for (const [k, v] of Object.entries(h)) if (v !== undefined && !DROP.has(k)) out[k] = v;
	out.authorization = `Bearer ${key}`;
	return out;
}

/** The provider's URL for the agent's request path, or undefined for a path outside /v1. */
export function upstreamUrl(upstream: string, path: string): URL | undefined {
	if (!/^\/v1(\/|\?|$)/.test(path)) return undefined;
	return new URL(upstream.replace(/\/+$/, "") + path.slice(3));
}

/** A provider the proxy sends to: its OpenAI-compatible base and its key. */
export interface Route {
	upstream: string;
	key: string;
	/** The models the key may be spent on (process ticket 106: free ones only); undefined: any. */
	only?: string[];
}

/** The largest request body read to find its model (a guarded route only): a long context, with room. */
export const MAX_BODY = 64 << 20;

// Fields of a request body by which a provider picks another model, or spends beside the
// model, than `model` (OpenRouter: fallback `models` and `route`, `preset`, paid `plugins`
// such as web search). A guarded route refuses them: the key is spent on its listed models only.
const ELSEWHERE = ["models", "route", "preset", "plugins"];

/** Why a guarded route refuses this request body, or undefined when it may go on. */
export function guardBody(body: Buffer, only: string[]): { status: number; message: string } | undefined {
	let req: unknown;
	try {
		req = JSON.parse(body.toString("utf8"));
	} catch {
		return { status: 400, message: "a request to a guarded provider must be JSON with its model" };
	}
	if (typeof req !== "object" || req === null || Array.isArray(req))
		return { status: 400, message: "a request to a guarded provider must be a JSON object with its model" };
	const model = (req as { model?: unknown }).model;
	if (typeof model !== "string" || !only.includes(model)) return { status: 403, message: `takes only ${only.join(", ")} through this key, not ${JSON.stringify(model)}` };
	const other = ELSEWHERE.filter((k) => Object.hasOwn(req, k));
	if (other.length) return { status: 403, message: `takes only ${only.join(", ")} through this key; ${other.join(", ")} would choose or spend beyond it` };
	return undefined;
}

/** A request without a body: no length, or 0, and not chunked. */
function bodiless(req: IncomingMessage): boolean {
	return !req.headers["transfer-encoding"] && (req.headers["content-length"] ?? "0") === "0";
}

/** `only=a,b` of a row, or NERD_PROVIDER_MODELS: the list, undefined when there is none. */
function onlyList(spec: string | undefined): string[] | undefined {
	const list = (spec ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	return list.length ? list : undefined;
}

/** Routes by path prefix: "" is /v1 itself, a name is /<name>/v1. */
export type Routes = Map<string, Route>;

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/**
 * The routes of a key file: one key for `chosen` (a URL), or a table of rows
 * "<name> <base> <key>", every row at /<name>/v1 and the row `chosen` names at /v1
 * too. The errors name lines and names, never a key.
 */
export function parseKeys(text: string, chosen: string, models?: string): Routes {
	const rows = text
		.split("\n")
		.map((l, i) => ({ n: i + 1, f: l.trim().split(/\s+/) }))
		.filter((r) => r.f[0] && !r.f[0].startsWith("#"));
	if (rows.length === 1 && rows[0].f.length === 1) {
		if (!/^https?:\/\//.test(chosen)) throw new Error(`the key file holds one key: NERD_PROVIDER_URL must be the provider's URL, not "${chosen}"`);
		return new Map([["", { upstream: chosen, key: rows[0].f[0], only: onlyList(models) }]]);
	}
	const routes: Routes = new Map();
	for (const { n, f } of rows) {
		const extra = f[3];
		if (f.length < 3 || f.length > 4 || (extra !== undefined && !extra.startsWith("only=")))
			throw new Error(`key file, line ${n}: a row is "<name> <base URL> <key> [only=<model>,<model>]"`);
		const [name, upstream, key] = f;
		if (!NAME.test(name) || name === "v1" || name === "health") throw new Error(`key file, line ${n}: "${name}" cannot name a provider`);
		if (!/^https?:\/\//.test(upstream)) throw new Error(`key file, line ${n}: the base of ${name} is not a URL`);
		if (routes.has(name)) throw new Error(`key file, line ${n}: ${name} again`);
		const only = onlyList(extra?.slice(5));
		if (extra !== undefined && !only) throw new Error(`key file, line ${n}: only= names no model`);
		routes.set(name, { upstream, key, only });
	}
	if (!routes.size) throw new Error("the key file is empty");
	const main = routes.get(chosen);
	if (main) routes.set("", main);
	else if (chosen) throw new Error(`NERD_PROVIDER_URL is "${chosen}", but the key file's table is ${[...routes.keys()].join(", ")}`);
	return routes;
}

/** The route of a request path and the path left for the provider; /<name>/... before /... */
export function route(routes: Routes, path: string): { r?: Route; rest: string } {
	const m = /^\/([^/?]+)(\/.*|\?.*)?$/.exec(path);
	if (m && m[1] !== "v1" && m[1] !== "health" && routes.has(m[1])) return { r: routes.get(m[1]), rest: m[2] || "/" };
	return { r: routes.get(""), rest: path };
}

/** Whether a request carries the token (`Authorization: Bearer <token>`); compared in constant time. */
export function tokenMatches(header: string | undefined, token: string): boolean {
	const got = Buffer.from(header ?? "");
	const want = Buffer.from(`Bearer ${token}`);
	return got.length === want.length && timingSafeEqual(got, want);
}

/**
 * The proxy. `token` (NERD_KEYPROXY_AUTH=on): a request without it is a 401 and never reaches a
 * provider; /health answers anyway (it names the provider's host only). Without a token, anyone who
 * reaches the proxy spends the key, which is what serving it to other tools of one's own may want.
 */
export function keyProxy(routes: Routes, log: (line: string) => void = (l) => console.log(l), token?: string): Server {
	const names = [...routes.keys()].filter(Boolean);
	return createServer((req, res) => {
		const t0 = Date.now();
		const path = req.url ?? "/";
		const done = (status: number) => log(`${new Date().toISOString()} ${req.method} ${path} ${status} ${Date.now() - t0}ms`);
		const { r, rest } = route(routes, path);
		const host = r && new URL(r.upstream).host;
		if (r && rest === "/health") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ keyproxy: host }));
			return;
		}
		if (token && !tokenMatches(req.headers.authorization, token)) {
			req.resume();
			res.writeHead(401, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: "keyproxy: this proxy takes the token of NERD_KEYPROXY_AUTH=on (var/keyproxy.token) as the API key" } }));
			done(401);
			return;
		}
		const url = r && upstreamUrl(r.upstream, rest);
		if (!r || !url) {
			const where = r ? `only /v1/... goes to ${host}` : `/v1 goes nowhere; the providers are /<name>/v1, <name> one of ${names.join(", ")}`;
			res.writeHead(404, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: `keyproxy: ${where}` } }));
			done(404);
			return;
		}
		const refuse = (status: number, message: string) => {
			res.writeHead(status, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: `keyproxy: ${message}` } }));
			done(status);
		};
		if (!r.only || ((req.method === "GET" || req.method === "HEAD") && bodiless(req))) {
			forward(r, url, req, res, done, host ?? "");
			return;
		}
		// A guarded route takes a POST with its model, or a bodiless GET (the model list); nothing else
		// goes on with the key unread.
		if (req.method !== "POST") {
			req.resume();
			return refuse(405, `a guarded provider takes POST, or GET without a body, not ${req.method}`);
		}
		const only = r.only;
		// The request's model is read before anything goes on.
		const parts: Buffer[] = [];
		let size = 0;
		req.on("data", (c: Buffer) => {
			size += c.length;
			if (size <= MAX_BODY) parts.push(c);
		});
		req.on("end", () => {
			if (size > MAX_BODY) return refuse(413, `a request over ${MAX_BODY} bytes is not read for its model`);
			const body = Buffer.concat(parts);
			const no = guardBody(body, only);
			if (no) return refuse(no.status, no.status === 403 ? `${host} ${no.message}` : no.message);
			forward(r, url, req, res, done, host ?? "", body);
		});
	});
}

/** The request to the provider with the key; `body`: already read (a guarded route), else piped. */
function forward(r: Route, url: URL, req: IncomingMessage, res: ServerResponse, done: (status: number) => void, host: string, body?: Buffer) {
	const headers = forwardHeaders(req.headers, r.key);
	if (body) headers["content-length"] = String(body.length);
	const send = url.protocol === "https:" ? httpsRequest : httpRequest;
	const up = send(url, { method: req.method, headers }, (p) => {
		res.writeHead(p.statusCode ?? 502, p.headers);
		p.pipe(res);
		p.on("end", () => done(p.statusCode ?? 502));
	});
	up.on("error", (e) => {
		if (!res.headersSent) {
			res.writeHead(502, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: `keyproxy: ${host}: ${e.message}` } }));
		} else res.destroy();
		done(502);
	});
	// The agent gave up (Pi's abort): stop the provider's request too.
	res.on("close", () => {
		if (!res.writableFinished) up.destroy();
	});
	if (body) up.end(body);
	else req.pipe(up);
}

if (import.meta.main) {
	const chosen = process.env.NERD_PROVIDER_URL ?? "";
	const keyFile = process.env.NERD_PROVIDER_KEY_FILE || "/run/secrets/provider_key";
	const routes = parseKeys(readFileSync(keyFile, "utf8"), chosen, process.env.NERD_PROVIDER_MODELS); // whole-read: a key or a table of a few rows
	const hostAddr = process.env.NERD_KEYPROXY_HOST || "0.0.0.0";
	const port = Number(process.env.NERD_KEYPROXY_PORT || KEYPROXY_PORT);
	const to = [...routes].map(([n, r]) => `${n ? `/${n}` : ""}/v1 -> ${r.upstream}${r.only ? ` (only ${r.only.join(", ")})` : ""}`).join(", ");
	const token = process.env.NERD_KEYPROXY_TOKEN || undefined;
	keyProxy(routes, undefined, token).listen(port, hostAddr, () =>
		console.log(`keyproxy: ${hostAddr}:${port}: ${to}${token ? "; a request needs the token" : "; open to anyone who reaches it"}`),
	);
}
