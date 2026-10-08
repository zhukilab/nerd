// Loaded by the done gate (done-gate.ts) into the project's `npm test` and
// start command through NODE_OPTIONS=--require. The gate runs them in a clean
// clone, but in the agent's container, where the agent's own server may still
// listen: a test that talks to localhost:8000 without starting a server then
// passes against the live one, and fails in the operator's clean container
// (run 0006 rerun, 2026-10-07). Network namespaces are not allowed there
// (`unshare -rn`), so this refuses, in Node, connections to loopback ports that
// were listening before the check began (NERD_GATE_BLOCKED_PORTS, comma
// separated), as an empty machine would: ECONNREFUSED. Child processes inherit
// NODE_OPTIONS, so a test that spawns node is covered too.
"use strict";
const net = require("node:net");

const blocked = new Set(
	String(process.env.NERD_GATE_BLOCKED_PORTS || "")
		.split(",")
		.map((p) => Number(p))
		.filter((p) => p > 0),
);

const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|::1|0\.0\.0\.0|::|\[::1\])$/i;

function target(args) {
	const a = args[0];
	if (Array.isArray(a)) return target(a); // internal normalized form
	if (a && typeof a === "object") {
		if (a.path) return undefined;
		return { port: Number(a.port), host: a.host || "localhost" };
	}
	if (typeof a === "number" || (typeof a === "string" && /^\d+$/.test(a))) {
		return { port: Number(a), host: typeof args[1] === "string" ? args[1] : "localhost" };
	}
	return undefined;
}

if (blocked.size) {
	const connect = net.Socket.prototype.connect;
	net.Socket.prototype.connect = function (...args) {
		const t = target(args);
		if (t && blocked.has(t.port) && LOOPBACK.test(t.host)) {
			const err = Object.assign(new Error(`connect ECONNREFUSED ${t.host}:${t.port}`), {
				code: "ECONNREFUSED",
				errno: -111,
				syscall: "connect",
				address: t.host,
				port: t.port,
			});
			this.connecting = true;
			process.nextTick(() => this.destroy(err));
			return this;
		}
		return connect.apply(this, args);
	};
}
