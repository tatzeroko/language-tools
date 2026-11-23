import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

const REPO = "forcedotcom/apex-language-support";
// Pinned nightly so results are reproducible.
const TAG = process.env.APEX_LS_TAG ?? "v0.11.85-nightly.20261122";
// SHA-256 of the pinned asset (matches the digest GitHub publishes for the release asset).
const PINNED_SHA256 =
	"221a755901a488dd0d38f3791797944bc9094d977867a4845ffcebd3155c8709";
const cacheDir = path.resolve(import.meta.dirname, "..", ".cache");

/** Downloads the latest desktop VSIX into the gitignored cache and unpacks it. Returns the extension dir. */
export function fetchServer(): string {
	const out = path.join(cacheDir, "extension");
	if (existsSync(path.join(out, "extension", "dist", "server.node.js"))) {
		return path.join(out, "extension");
	}
	mkdirSync(cacheDir, { recursive: true });
	execFileSync(
		"gh",
		[
			"release",
			"download",
			TAG,
			"--repo",
			REPO,
			"--clobber",
			"--pattern",
			`apex-language-server-extension-${TAG.slice(1).split("-")[0]}.vsix`,
			"--dir",
			cacheDir,
		],
		{ stdio: "inherit" },
	);
	return unpack();
}

function unpack(): string {
	const vsix = execFileSync("sh", [
		"-c",
		`ls ${cacheDir}/*.vsix | grep -v web | head -1`,
	])
		.toString()
		.trim();
	if (!process.env.APEX_LS_TAG) {
		const actual = createHash("sha256")
			.update(readFileSync(vsix))
			.digest("hex");
		if (actual !== PINNED_SHA256) {
			throw new Error(`VSIX hash mismatch: ${actual} != ${PINNED_SHA256}`);
		}
	}
	const out = path.join(cacheDir, "extension");
	mkdirSync(out, { recursive: true });
	execFileSync("unzip", ["-q", "-o", vsix, "-d", out]);
	return path.join(out, "extension");
}

if (import.meta.main) {
	console.log(fetchServer());
}
