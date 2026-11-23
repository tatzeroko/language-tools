import { readdirSync, readFileSync } from "node:fs";

export type ProcSample = {
	pid: number;
	ppid: number;
	cmd: string;
	threads: number;
	rssMb: number;
	/** Proportional set size: shared pages divided among sharers. */
	pssMb: number;
};

const mb = (kb: number) => Math.round((kb / 1024) * 10) / 10;

function field(text: string, name: string) {
	const m = new RegExp(`^${name}:\\s+(\\d+)`, "m").exec(text);
	return m ? Number(m[1]) : 0;
}

function sample(pid: number): ProcSample | undefined {
	try {
		const status = readFileSync(`/proc/${pid}/status`, "utf8");
		let pss = 0;
		try {
			pss = field(readFileSync(`/proc/${pid}/smaps_rollup`, "utf8"), "Pss");
		} catch {}
		return {
			pid,
			ppid: field(status, "PPid"),
			cmd: readFileSync(`/proc/${pid}/cmdline`, "utf8")
				.split("\0")
				.slice(0, 3)
				.join(" "),
			threads: field(status, "Threads"),
			rssMb: mb(field(status, "VmRSS")),
			pssMb: mb(pss),
		};
	} catch {
		return undefined;
	}
}

/** `root` plus all of its descendants (Linux /proc only). */
export function processTree(root: number): ProcSample[] {
	const all = readdirSync("/proc")
		.filter((n) => /^\d+$/.test(n))
		.map((n) => sample(Number(n)))
		.filter((s): s is ProcSample => s !== undefined);
	const out: ProcSample[] = [];
	const queue = [root];
	while (queue.length > 0) {
		const pid = queue.shift() as number;
		const self = all.find((s) => s.pid === pid);
		if (self) out.push(self);
		for (const child of all) if (child.ppid === pid) queue.push(child.pid);
	}
	return out;
}

export type TreeSummary = {
	rootRssMb: number;
	rootPssMb: number;
	treeRssMb: number;
	treePssMb: number;
	processes: number;
	rootThreads: number;
	treeThreads: number;
};

export function summarizeTree(root: number): TreeSummary {
	const tree = processTree(root);
	const sum = (f: (s: ProcSample) => number) =>
		Math.round(tree.reduce((a, s) => a + f(s), 0) * 10) / 10;
	const head = tree[0];
	return {
		rootRssMb: head?.rssMb ?? 0,
		rootPssMb: head?.pssMb ?? 0,
		treeRssMb: sum((s) => s.rssMb),
		treePssMb: sum((s) => s.pssMb),
		processes: tree.length,
		rootThreads: head?.threads ?? 0,
		treeThreads: sum((s) => s.threads),
	};
}

/** cgroup v2 memory.current in MB, or undefined when unavailable. */
export function cgroupMemoryMb(): number | undefined {
	for (const f of [
		"/sys/fs/cgroup/memory.current",
		"/sys/fs/cgroup/memory/memory.usage_in_bytes",
	]) {
		try {
			return Math.round(Number(readFileSync(f, "utf8")) / 1048576);
		} catch {}
	}
	return undefined;
}
