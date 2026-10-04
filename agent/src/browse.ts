// `browse`: open a page in headless Chromium the way a user would and print
// what a user would run into. For the agent's own checks (ticket 038): in the
// first acceptance run every hand-in was "verified" with curl while the page's
// JavaScript was dead (a SyntaxError, a missing import, HTML served as
// text/plain), which curl cannot see.
//
//   browse <url> [--click TEXT] [--fill FIELD=VALUE] [--press KEY] [--wait MS]
//                [--shot FILE.png] [--width PX] [--text CHARS]
//
// Actions run in the order given, after the page has loaded. --click finds a
// visible button, link or text by what it says; --fill finds a field by its
// label, placeholder or name (an empty FIELD means the first visible field;
// a select gets the option with that text or value);
// --press presses a key in the focused element (Enter, Tab, ...). After each
// action the page gets up to 3 s to settle. Every call is a fresh browser
// (the first agent to use it played a guessing game one guess per call and
// was puzzled that the secret kept changing), and the help says so.
//
// Prints: the main document's HTTP status and Content-Type, the requests the
// page made (status, type, path), console errors and warnings, uncaught
// exceptions, failed requests, then the visible text (truncated to --text,
// default 2000 characters). Exit code: 0 clean, 1 the page has errors (an
// exception, a console error, a failed request or HTTP >= 400, a main document
// that is not HTML), 2 the page could not be opened or an action failed.
//
// The image installs Chromium's headless shell under /opt/nerd/browsers
// (PLAYWRIGHT_BROWSERS_PATH, set by the /usr/local/bin/browse wrapper).

import { chromium, type Locator, type Page } from "playwright-core";

type Action = { kind: "click" | "fill" | "press" | "wait" | "reload"; arg: string };

const USAGE = `usage: browse <url> [--click TEXT] [--fill FIELD=VALUE] [--press KEY] [--wait MS] [--reload] [--shot FILE.png] [--width PX] [--text CHARS]
Opens <url> in headless Chromium, waits for the network to go idle, then runs the actions in order.
Every call starts a fresh browser: nothing (page state, storage, cookies) carries over from the previous
call, so a sequence of steps goes into one call. Dialogs (alert, confirm) are accepted and noted.
  --reload            reload the page; storage (localStorage, cookies) stays, as for a user
  --click TEXT        click the visible button, link or text that says TEXT
  --fill FIELD=VALUE  type VALUE into the field labelled, placeholdered or named FIELD (=VALUE: the first field); in a select, pick the option VALUE
  --press KEY         press a key (Enter, Tab, ArrowUp, ...)
  --wait MS           wait
  --shot FILE.png     full-page screenshot at the end    --width PX  viewport width (default 1280; < 600 is a phone)
  --text CHARS        how much visible text to print (default 2000; 0: none)
Prints HTTP status and Content-Type of the page, the requests it made, console errors and warnings,
uncaught exceptions, failed requests, and the visible text. Exit 0 clean, 1 the page has errors, 2 could not open / an action failed.`;

function parseArgs(argv: string[]) {
	let url: string | undefined;
	let shot: string | undefined;
	let width = 1280;
	let textMax = 2000;
	const actions: Action[] = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const next = () => {
			const v = argv[++i];
			if (v === undefined) throw new Error(`${a} needs a value`);
			return v;
		};
		if (a === "--click" || a === "--fill" || a === "--press" || a === "--wait") actions.push({ kind: a.slice(2) as Action["kind"], arg: next() });
		else if (a === "--reload") actions.push({ kind: "reload", arg: "" });
		else if (a === "--shot") shot = next();
		else if (a === "--width") width = Number(next());
		else if (a === "--text") textMax = Number(next());
		else if (a === "-h" || a === "--help") throw new Error("");
		else if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
		else if (url === undefined) url = a;
		else throw new Error(`unexpected argument ${a}`);
	}
	if (!url) throw new Error("no url");
	if (!/^[a-z]+:\/\//i.test(url)) url = `http://${url}`;
	return { url, shot, width, textMax, actions };
}

let opts: ReturnType<typeof parseArgs>;
try {
	opts = parseArgs(process.argv.slice(2));
} catch (e) {
	const m = (e as Error).message;
	console.error(m ? `browse: ${m}\n${USAGE}` : USAGE);
	process.exit(2);
}

const problems: string[] = [];
const notes: string[] = [];
const requests: string[] = [];
let step = "load";
const short = (u: string) => {
	try {
		const p = new URL(u);
		return p.origin === new URL(opts.url).origin ? p.pathname + p.search : u;
	} catch {
		return u;
	}
};
const where = (url: string, line?: number) => (url ? ` (${short(url)}${line !== undefined ? `:${line + 1}` : ""})` : "");

async function settle(page: Page, ms: number) {
	await page.waitForLoadState("networkidle", { timeout: ms }).catch(() => notes.push(`[${step}] network not idle after ${ms} ms`));
}

async function firstVisible(cands: Locator[]): Promise<Locator | undefined> {
	for (const l of cands) {
		const n = Math.min(await l.count().catch(() => 0), 20);
		for (let i = 0; i < n; i++) if (await l.nth(i).isVisible().catch(() => false)) return l.nth(i);
	}
	return undefined;
}

async function act(page: Page, a: Action): Promise<string> {
	if (a.kind === "wait") {
		await page.waitForTimeout(Number(a.arg));
		return "ok";
	}
	if (a.kind === "reload") {
		await page.reload();
		return "ok";
	}
	if (a.kind === "press") {
		await page.keyboard.press(a.arg);
		return "ok";
	}
	if (a.kind === "click") {
		const t = a.arg;
		const el = await firstVisible([
			page.getByRole("button", { name: t, exact: true }),
			page.getByRole("link", { name: t, exact: true }),
			page.getByText(t, { exact: true }),
			page.getByRole("button", { name: t }),
			page.getByRole("link", { name: t }),
			page.getByText(t),
		]);
		if (!el) return "FAILED: no visible element with this text";
		if (await el.isDisabled().catch(() => false)) return "FAILED: the element is disabled";
		await el.click({ timeout: 5000 });
		return "ok";
	}
	const eq = a.arg.indexOf("=");
	if (eq < 0) return "FAILED: --fill wants FIELD=VALUE";
	const field = a.arg.slice(0, eq);
	const value = a.arg.slice(eq + 1);
	const any = "input:not([type=hidden]):not([type=button]):not([type=submit]), textarea, select, [contenteditable=true]";
	const el = field
		? await firstVisible([page.getByLabel(field), page.getByPlaceholder(field), page.locator(`[name="${field.replace(/"/g, '\\"')}"]`), page.locator(`[id="${field.replace(/"/g, '\\"')}"]`)])
		: await firstVisible([page.locator(any)]);
	if (!el) return `FAILED: no visible field ${field ? `"${field}"` : "at all"}`;
	// A <select> takes the option by its visible text, else by its value.
	// Without this (ticket 043) the agent replaced a select with a text field
	// so that its check could fill it.
	if ((await el.evaluate((n) => n.tagName).catch(() => "")) === "SELECT") {
		await el.selectOption({ label: value }, { timeout: 2000 }).catch(() => el.selectOption(value, { timeout: 3000 }));
		return "ok";
	}
	await el.fill(value, { timeout: 5000 });
	return "ok";
}

const browser = await chromium.launch();
let code = 0;
try {
	const ctx = await browser.newContext({ viewport: { width: opts.width, height: 900 }, ...(opts.width < 600 ? { isMobile: true, hasTouch: true } : {}) });
	const page = await ctx.newPage();
	page.on("console", (m) => {
		const t = m.type();
		if (t !== "error" && t !== "warning") return;
		const loc = m.location();
		// The "HTTP <status>" line of the response handler already says it.
		if (/^Failed to load resource: the server responded with a status of/.test(m.text())) return;
		problems.push(`[${step}] console ${t}: ${m.text()}${where(loc.url, loc.lineNumber)}`);
	});
	// Uncaught exceptions from the DevTools protocol rather than "pageerror":
	// a script that does not parse has no stack, and only the protocol event
	// says which file and line it was.
	const cdp = await ctx.newCDPSession(page);
	cdp.on("Runtime.exceptionThrown", ({ exceptionDetails: d }) => {
		const what = (d.exception?.description ?? d.text).split("\n")[0];
		const frame = d.stackTrace?.callFrames?.[0];
		problems.push(`[${step}] uncaught ${what}${where(d.url ?? frame?.url ?? "", d.lineNumber ?? frame?.lineNumber)}`);
	});
	await cdp.send("Runtime.enable");
	// alert/confirm/prompt are accepted as a user would click OK, and noted.
	// Playwright dismisses them by default, so confirm() returned false and
	// the agent removed a confirmation from its page to pass the check (043).
	page.on("dialog", (d) => {
		notes.push(`[${step}] ${d.type()} "${d.message()}": accepted`);
		void d.accept().catch(() => {});
	});
	page.on("requestfailed", (r) => problems.push(`[${step}] request failed: ${r.method()} ${short(r.url())}: ${r.failure()?.errorText ?? "?"}`));
	page.on("response", (r) => {
		const ct = (r.headers()["content-type"] ?? "-").split(";")[0];
		requests.push(`${r.status()} ${ct} ${r.request().method()} ${short(r.url())}`);
		if (r.status() >= 400) problems.push(`[${step}] HTTP ${r.status()}: ${r.request().method()} ${short(r.url())}`);
	});

	const res = await page.goto(opts.url, { waitUntil: "load", timeout: 30000 }).catch((e: Error) => e);
	if (res instanceof Error) {
		console.log(`could not open ${opts.url}: ${res.message.split("\n")[0]}`);
		process.exitCode = 2;
		throw res;
	}
	const ct = res?.headers()["content-type"] ?? "(none)";
	console.log(`${opts.url} -> HTTP ${res?.status() ?? "?"}, Content-Type: ${ct}${res && res.url() !== new URL(opts.url).href ?`, final URL ${res.url()}` : ""}`);
	if (res && !/html/i.test(ct)) problems.push(`[load] the main document is not HTML (Content-Type: ${ct}): the browser shows it as plain text and runs no scripts`);
	await settle(page, 5000);

	for (const a of opts.actions) {
		step = a.kind === "reload" ? "reload" : `${a.kind} "${a.arg}"`;
		const r = await act(page, a).catch((e: Error) => `FAILED: ${e.message.split("\n")[0]}`);
		console.log(`${step}: ${r}`);
		if (r !== "ok") code = 2;
		await settle(page, 3000);
		await page.waitForTimeout(300);
	}
	step = "end";

	console.log(`\nrequests (${requests.length}):`);
	for (const r of requests.slice(0, 30)) console.log(`  ${r}`);
	if (requests.length > 30) console.log(`  ... ${requests.length - 30} more`);
	console.log(`\nproblems (${problems.length}):`);
	for (const p of problems) console.log(`  ${p}`);
	for (const n of notes) console.log(`  note: ${n}`);
	if (problems.length && code === 0) code = 1;

	if (opts.shot) {
		await page.screenshot({ path: opts.shot, fullPage: true });
		console.log(`\nscreenshot: ${opts.shot}`);
	}
	if (opts.textMax > 0) {
		const text = (await page.evaluate(() => document.body?.innerText ?? "").catch(() => "")).replace(/\n{3,}/g, "\n\n").trim();
		console.log(`\nvisible text (${text.length} chars${text.length > opts.textMax ? `, first ${opts.textMax}` : ""}):`);
		console.log(text.slice(0, opts.textMax) || "(none)");
	}
	process.exitCode = code;
} catch (e) {
	if (process.exitCode !== 2) {
		console.log(`browse failed: ${(e as Error).message.split("\n")[0]}`);
		process.exitCode = 2;
	}
} finally {
	await browser.close();
}
