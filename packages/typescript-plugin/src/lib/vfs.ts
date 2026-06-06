type VirtualFile = {
	buffer: Buffer;
	version: number;
};

/** In-memory store for virtual file contents and their versions. */
export class VirtualFileStore {
	private files = new Map<string, VirtualFile>();

	set(path: string, content: string | Buffer) {
		const buffer = Buffer.isBuffer(content)
			? content
			: Buffer.from(content, "utf8");
		const existing = this.files.get(path);
		if (existing && Buffer.compare(existing.buffer, buffer) === 0) return;
		this.files.set(path, { buffer, version: (existing?.version ?? 0) + 1 });
	}

	get(path: string) {
		return this.files.get(path);
	}

	has(path: string) {
		return this.files.has(path);
	}

	delete(path: string) {
		return this.files.delete(path);
	}

	clear() {
		this.files.clear();
	}

	list() {
		return Array.from(this.files.keys());
	}

	/** Returns `true` if any stored path begins with `prefix`. */
	hasPrefix(prefix: string) {
		for (const path of this.files.keys()) {
			if (path.startsWith(prefix)) {
				return true;
			}
		}
		return false;
	}

	/** Returns paths under `prefix`, optionally filtered to the given extensions. */
	listUnderPrefix(prefix: string, extensions?: readonly string[]) {
		const paths: string[] = [];
		for (const filePath of this.files.keys()) {
			if (!filePath.startsWith(prefix)) continue;
			if (
				extensions?.length &&
				!extensions.some((ext) => filePath.endsWith(ext))
			)
				continue;
			paths.push(filePath);
		}
		return paths;
	}
}
