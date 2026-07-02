import { describe, expect, it } from "vitest";

import { VirtualFileStore } from "../src/lib/vfs";

describe("VirtualFileStore", () => {
	it("stores buffers and versions", () => {
		const vfs = new VirtualFileStore();
		vfs.set("/workspace/file.d.ts", "one");

		const initial = vfs.get("/workspace/file.d.ts");
		expect(initial?.buffer.toString("utf8")).toBe("one");
		expect(initial?.version).toBe(1);

		vfs.set("/workspace/file.d.ts", Buffer.from("two", "utf8"));
		const updated = vfs.get("/workspace/file.d.ts");
		expect(updated?.buffer.toString("utf8")).toBe("two");
		expect(updated?.version).toBe(2);

		vfs.set("/workspace/file.d.ts", "two");
		expect(vfs.get("/workspace/file.d.ts")?.version).toBe(2);
	});

	it("matches directory prefixes without scanning twice", () => {
		const vfs = new VirtualFileStore();
		vfs.set("/workspace/.tatzeroko/virtual/apex/A.foo.d.ts", "one");
		vfs.set("/workspace/.tatzeroko/virtual/apex/B.bar.js", "two");
		vfs.set("/workspace/other.txt", "three");

		expect(vfs.hasPrefix("/workspace/.tatzeroko/virtual/apex/")).toBe(true);
		expect(vfs.hasPrefix("/workspace/missing/")).toBe(false);
		expect(
			vfs.listUnderPrefix("/workspace/.tatzeroko/virtual/apex/", [".d.ts"]),
		).toEqual(["/workspace/.tatzeroko/virtual/apex/A.foo.d.ts"]);
	});
});
