// What of a session event goes into the headless run's events log (--log). Process ticket 089:
// every message_update carried the whole message streamed so far (`message`, and again as
// `assistantMessageEvent.partial`), so a long reply wrote itself out once per token —
// 1-9 GB of log per run, 135 GB for one stand. An update keeps its delta only: the text is
// the deltas in order (from message_start), and message_end still carries the whole message.

type Ev = { type?: string; message?: unknown; assistantMessageEvent?: Record<string, unknown> };

export function logged<T extends object>(event: T): object {
	const e = event as Ev;
	if (e.type !== "message_update") return event;
	const { message: _message, assistantMessageEvent, ...rest } = e;
	if (!assistantMessageEvent) return rest;
	const { partial: _partial, ...delta } = assistantMessageEvent;
	return { ...rest, assistantMessageEvent: delta };
}
