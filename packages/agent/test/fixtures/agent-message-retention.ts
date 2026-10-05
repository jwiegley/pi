import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { Agent, type AgentMessageSource } from "../../src/agent.ts";

assert(global.gc, "Run with --expose-gc");
const gc = global.gc;

function unusedStream(): never {
	throw new Error("Unexpected stream call");
}

function createCase(capture: "none" | "deferred" | "adopted") {
	const agent = new Agent({ streamFn: unusedStream });
	const prefix = { role: "user" as const, content: "prefix", timestamp: 1 };
	const tail = { role: "user" as const, content: "tail", timestamp: 2 };
	const source: AgentMessageSource = {
		length: 1,
		materialize: () => [prefix],
		last: () => prefix,
		iterateReverse: () => [prefix],
	};
	agent.setMessageSource(source);
	agent.appendMessage(tail);
	let hasPrefix = capture === "deferred" ? agent.captureMessagePrefix() : undefined;
	assert.equal(agent.state.messages.length, 2);
	if (capture === "adopted") hasPrefix = agent.captureMessagePrefix();
	return { agent, hasPrefix, source: new WeakRef(source), messages: [new WeakRef(prefix), new WeakRef(tail)] };
}

async function collect(refs: WeakRef<object>[], label: string) {
	for (let attempt = 0; attempt < 10; attempt++) {
		// WeakRef targets remain alive until the current job ends, including after deref().
		await setImmediate();
		gc();
		if (refs.every((ref) => ref.deref() === undefined)) return;
	}
	assert.fail(
		`${label}: removed objects remain strongly retained at indexes ${refs.flatMap((ref, index) => (ref.deref() === undefined ? [] : [index])).join(", ")}`,
	);
}

for (const capture of ["none", "deferred", "adopted"] as const) {
	for (const mutation of ["length", "splice", "pop"] as const) {
		const fixture = createCase(capture);
		if (mutation === "length") fixture.agent.state.messages.length = 0;
		else if (mutation === "splice") fixture.agent.state.messages.splice(0);
		else while (fixture.agent.messageCount > 0) fixture.agent.popMessage();
		await collect([fixture.source, ...fixture.messages], `${capture}/${mutation}`);
		assert.equal(fixture.agent.messageCount, 0);
		if (fixture.hasPrefix) {
			assert.equal(fixture.hasPrefix(), false);
			fixture.agent.state.messages.length = 2;
			assert.equal(fixture.hasPrefix(), false, "collected messages must not match empty array slots");
		}
	}
}

const live = createCase("deferred");
await collect([live.source], "materialized source with live messages");
assert.equal(live.hasPrefix?.(), true);
live.agent.state.messages = [...live.agent.state.messages];
assert.equal(live.hasPrefix?.(), true, "source collection must preserve equivalent shallow copies");
live.agent.state.messages.splice(0);
await collect(live.messages, "previously live messages");
assert.equal(live.hasPrefix?.(), false);

function replaceDeferredSource() {
	const agent = new Agent({ streamFn: unusedStream });
	const message = { role: "user" as const, content: "cancelled prefix", timestamp: 1 };
	const source: AgentMessageSource = {
		length: 1,
		materialize: () => [message],
		last: () => message,
		iterateReverse: () => [message],
	};
	agent.setMessageSource(source);
	const hasPrefix = agent.captureMessagePrefix();
	agent.state.messages = [];
	return { agent, hasPrefix, refs: [new WeakRef<object>(source), new WeakRef<object>(message)] };
}

const replaced = replaceDeferredSource();
await collect(replaced.refs, "replaced deferred source with retained checker");
assert.equal(replaced.agent.messageCount, 0);
assert.equal(replaced.hasPrefix(), false);
