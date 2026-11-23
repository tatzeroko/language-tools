import { readdirSync, readFileSync } from "node:fs";

const kb = (pid: number, file: string, key: string) =>
	Number(
		new RegExp(`${key}:\\s+(\\d+)`).exec(
			readFileSync(`/proc/${pid}/${file}`, "utf8"),
		)?.[1] ?? 0,
	);

function tree(pid: number): number[] {
	const kids = readdirSync("/proc")
		.filter((d) => /^\d+$/.test(d))
		.filter((d) => {
			try {
				return (
					Number(
						readFileSync(`/proc/${d}/stat`, "utf8")
							.split(") ")[1]
							.split(" ")[1],
					) === pid
				);
			} catch {
				return false;
			}
		})
		.map(Number);
	return [pid, ...kids.flatMap(tree)];
}

/** RSS/PSS (MB) summed over the process tree; threads counted from /proc status. Linux only. */
export function processTreeStats(pid: number) {
	const pids = tree(pid);
	const sum = (f: string, k: string) =>
		pids.reduce((a, p) => a + kb(p, f, k), 0);
	return {
		processes: pids.length,
		threads: sum("status", "Threads"),
		rssMB: Math.round(sum("status", "VmRSS") / 1024),
		pssMB: Math.round(sum("smaps_rollup", "Pss") / 1024),
	};
}
