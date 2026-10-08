// Types for what the agent's done gate (agent/src/done-gate.ts) imports from
// parse.mjs: the checker and the gate share one rule for the start command.
export const START_HEADING: RegExp;
export function readmeCommands(md: string, headingRe: RegExp): string[];
export function startCommand(
	pkg: { scripts?: Record<string, string> } | null | undefined,
	readme: string | null,
): { cmd: string | null; why: string };
export function findPorts(log: string): number[];
