// The step log (step-log.ts, process ticket 067): the plan's steps with their check commands, a
// commit seen in a bash call, and after it the checks of the steps not yet done run in a clean
// clone — the done ones logged, the first red one told to the model.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { commits, planSteps, stepLog, stepsOn } from "../src/step-log.ts";
import { tempDir } from "./tmp.ts";

test("steps: off by default; NERD_STEPS=1 on", () => {
	assert.equal(stepsOn({}), false);
	assert.equal(stepsOn({ NERD_STEPS: "1" }), true);
});

test("plan steps with their check commands, in the forms plans write them", () => {
	const plan = `# Plan

## Task

> make it

## Steps

1. Save the pages — check: ls notes/web/*.md | wc -l returns 3 and each file contains the URL string.
2. Set up the project — check: \`node -e "require('ws')"\` exits 0
3. Write the rules engine — check: node --test src/rules.test.js exits 0 with 15 passing tests
4. Write the README — check: grep -q "相生" README.md && grep -q "相克" README.md
5. Commit everything — git add -A && git commit -m "game"
6. Look at it — check: open it in a browser and see the board

## Done when

- it works — check: \`npm test\`
`;
	const s = planSteps(plan);
	assert.deepEqual(s.map((x) => x.n), [1, 2, 3, 4, 5, 6]);
	assert.equal(s[0].cmd, undefined, "an output expected in words: not checkable by the exit code");
	assert.equal(s[1].cmd, `node -e "require('ws')"`);
	assert.equal(s[2].cmd, "node --test src/rules.test.js");
	assert.equal(s[3].cmd, 'grep -q "相生" README.md && grep -q "相克" README.md');
	assert.equal(s[4].cmd, undefined, "no check: in the step");
	assert.equal(s[5].cmd, undefined, "a check in words");
	assert.deepEqual(planSteps("# Plan\n\nno steps here\n"), []);
	// The A/B of 067: the command named in words, not given.
	const words = planSteps(
		"## Steps\n\n1. Create semver.js — check: one-line `node -e` import smoke-check of parse('1.2.3'), exiting 0\n2. Verify the cases — check: inline `node -e` script (command below) exits 0.\n3. Run it — check: `python3 -c`\n",
	);
	assert.deepEqual(words.map((x) => x.cmd), [undefined, undefined, undefined]);
	// A baseline step expects the tests to fail: not a check of being done.
	const base = planSteps("## Steps\n\n1. Establish baseline — check: `npm test` exits non-zero (the stub)\n2. Fix it — check: `npm test` exits 0\n");
	assert.deepEqual(base.map((x) => x.cmd), [undefined, "npm test"]);
});

test("a commit is seen in the forms bash calls take", () => {
	for (const c of ['git commit -m "x"', 'git add -A && git commit -qm x', "cd /workspace && git -C . commit -am y", "(git add a; git commit -m z)"]) assert.ok(commits(c), c);
	for (const c of ["git status", "git log --oneline", 'echo "git commit later"x', "npm test"]) assert.ok(!commits(c) || c.includes("echo"), c);
	assert.ok(!commits("git log -1 --format=%s"));
});

type Handler = (event: unknown, ctx: unknown) => unknown;

function fakePi() {
	const handlers = new Map<string, Handler>();
	const entries: { type: string; data: Record<string, unknown> }[] = [];
	const pi = {
		on: (name: string, h: Handler) => handlers.set(name, h),
		appendEntry: (type: string, data: Record<string, unknown>) => entries.push({ type, data }),
	} as unknown as ExtensionAPI;
	return { pi, handlers, entries };
}

function repo(): { d: string; g: (...a: string[]) => void } {
	const d = tempDir("nerd-steps-test-");
	const g = (...a: string[]) => {
		spawnSync("git", a, { cwd: d, stdio: "pipe" });
	};
	g("init", "-q");
	g("config", "user.name", "t");
	g("config", "user.email", "t@t");
	writeFileSync(
		join(d, "PLAN.md"),
		"# Plan\n\n## Steps\n\n1. Write a.txt — check: `test -f a.txt`\n2. Write b.txt with hi — check: `grep -q hi b.txt`\n3. Tidy up — check: by eye\n\n## Done when\n\n- both — check: `test -f b.txt`\n",
	);
	g("add", "PLAN.md");
	g("commit", "-qm", "Plan");
	return { d, g };
}

test("after a commit: the steps whose checks pass are done and logged, the first red one goes to the model", async () => {
	const { d, g } = repo();
	const { pi, handlers, entries } = fakePi();
	const log = stepLog(pi, { timeoutMs: 20_000 });
	const call = (command: string) =>
		handlers.get("tool_result")?.({ toolName: "bash", isError: false, input: { command }, content: [{ type: "text", text: "ok" }] }, { cwd: d }) as Promise<
			{ content: { text: string }[] } | undefined
		>;

	writeFileSync(join(d, "a.txt"), "a\n");
	g("add", "a.txt");
	g("commit", "-qm", "a");
	const first = await call('git add a.txt && git commit -m "a"');
	const note = first?.content.at(-1)?.text ?? "";
	assert.match(note, /Plan steps by their checks, run on commit \w{7} in a clean clone: 1 of 2 checked steps done \(step 1\); step 3 has no command to check\. Step 2 is not done: its check `grep -q hi b\.txt` exited with/);
	assert.deepEqual(log.done(), [1]);
	assert.deepEqual(entries.map((e) => [e.type, e.data.step, e.data.done]), [["nerd-step", 1, true], ["nerd-step", 2, false]]);

	writeFileSync(join(d, "b.txt"), "hi\n");
	g("add", "b.txt");
	g("commit", "-qm", "b");
	const second = await call("git commit -am b");
	assert.match(second?.content.at(-1)?.text ?? "", /2 of 2 checked steps done \(steps 1, 2\); step 3 has no command to check\.$/);
	assert.deepEqual(log.done(), [1, 2]);

	assert.equal(await call("git status"), undefined, "not a commit: nothing added");
});
