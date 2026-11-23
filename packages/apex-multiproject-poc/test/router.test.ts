import { describe, expect, it } from "vitest";
import type { DxProject } from "../src/discovery.ts";
import { ApexRouter, ServerUnavailableError } from "../src/router.ts";
import type { ApexServerInstance } from "../src/server-host.ts";

const project = (root: string): DxProject => ({
	root,
	namespace: "",
	packageDirectories: [],
	nestedRoots: [],
});
const fake = (root: string, alive = true) =>
	({
		project: project(root),
		alive,
		exitInfo: undefined,
	}) as unknown as ApexServerInstance;

describe("ApexRouter", () => {
	const parent = fake("/ws");
	const child = fake("/ws/packages/child");
	const router = new ApexRouter([parent, child]);

	it("routes to the nearest owning instance", () => {
		expect(router.instanceFor("/ws/force-app/A.cls")).toBe(parent);
		expect(router.instanceFor("/ws/packages/child/force-app/B.cls")).toBe(
			child,
		);
	});

	it("rejects files outside every project", () => {
		expect(() => router.instanceFor("/other/C.cls")).toThrow(/No Apex project/);
	});

	it("never falls back to another project when the owner is down", () => {
		const down = fake("/ws/packages/child", false);
		const r = new ApexRouter([parent, down]);
		expect(() => r.instanceFor("/ws/packages/child/force-app/B.cls")).toThrow(
			ServerUnavailableError,
		);
		expect(r.instanceFor("/ws/force-app/A.cls")).toBe(parent);
	});

	it("replace swaps only the matching project's instance", () => {
		const down = fake("/ws/packages/child", false);
		const r = new ApexRouter([parent, down]);
		const fresh = fake("/ws/packages/child");
		r.replace(fresh);
		expect(r.instanceFor("/ws/packages/child/force-app/B.cls")).toBe(fresh);
		expect(r.instanceFor("/ws/force-app/A.cls")).toBe(parent);
	});
});
