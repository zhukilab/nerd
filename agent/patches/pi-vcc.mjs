// nerd's patch of @sting8k/pi-vcc 0.8.1 (process ticket 057), applied by apply.mjs.
//
// pi-vcc keeps the last user turn whole and summarizes what is before it; only a tail over
// 25K x 2.5 = 62.5K tokens is cut to its 25K budget, and with no user message to anchor on it
// cuts to the budget. Pi records the system prompt as a message entry (again whenever the
// prompt or the tool set changes, which the plan step does), so the task is seldom the first
// live message: the first compaction in the task's turn summarized just the system message
// and kept everything — it freed nothing, and the next came a call later (96 of 124 such
// back-to-back compactions in Bonsai's runs, 130 of 157 runs with a compaction in the work).
// Patched: only system messages before the last user turn is no anchor either.
// The test: agent/test/pi-vcc-patch.test.ts.

export default {
	file: "node_modules/@sting8k/pi-vcc/src/hooks/before-compact.ts",
	// the file as pi-vcc 0.8.1 ships it; another version must be looked at again, not patched blind
	sha256: "5d97b089e04ccf9e081775a5216aa2ffb3b9b3630eaba84cc45b98de2528142a",
	marker: "nerd patch (process ticket 057)",
	old: `  // Case B: oversized user-boundary tail. Only re-cut when the kept tail exceeds
`,
	new: `  // nerd patch (process ticket 057): only system messages before the last user turn are
  // no anchor either. Pi records the system prompt as a message entry, so the task is
  // seldom first; keeping its whole turn summarized just the system message.
  if (cut.messages.length > 0 && cut.messages.every((m: any) => m.role === "system")) {
    const idx = findBudgetCutIndex(live, maxTokens, opts.charsPerToken);
    if (idx > cut.messages.length) return budgetResult(idx, "no_anchor");
  }

  // Case B: oversized user-boundary tail. Only re-cut when the kept tail exceeds
`,
};
