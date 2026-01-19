/**
 * A simple in-memory virtual file system for storing file contents and versions.
 */
export interface VirtualFile {
	buffer: Buffer;
	version: number;
}

/**
 * A store for managing virtual files.
 */
export class VirtualFileStore {
	/**
	 * Map of file paths to their corresponding VirtualFile instances.
	 *
	 * @description
	 * Structure:
	 * ```
	 * {
	 *   "<path>": VirtualFile
	 * }
	 * ```
	 */
	private files = new Map<string, VirtualFile>();

	/**
	 * Sets the content of a virtual file, updating its version.
	 *
	 * @param path The file path to set in the virtual file system.
	 * @param content The content to store, either as a string or a Buffer.
	 */
	set(path: string, content: string | Buffer) {
		const buffer = Buffer.isBuffer(content)
			? content
			: Buffer.from(content, "utf8");
		const existing = this.files.get(path);
		const version = (existing?.version ?? 0) + 1;
		this.files.set(path, { buffer, version });
	}

	/**
	 * Sets a virtual file directly.
	 *
	 * @param path The file path to set in the virtual file system.
	 * @param virtualFile The VirtualFile instance to store.
	 */
	setVirtualFile(path: string, virtualFile: VirtualFile) {
		this.files.set(path, virtualFile);
	}

	/**
	 * Retrieves a virtual file by its path.
	 *
	 * @param path The file path to retrieve from the virtual file system.
	 */
	get(path: string) {
		return this.files.get(path);
	}

	/**
	 * Checks if a virtual file exists at the given path.
	 *
	 * @param path The file path to check in the virtual file system.
	 */
	has(path: string) {
		return this.files.has(path);
	}

	/**
	 * Deletes a virtual file at the given path.
	 *
	 * @param path The file path to delete from the virtual file system.
	 */
	delete(path: string) {
		return this.files.delete(path);
	}

	/**
	 * Clears all virtual files from the store.
	 */
	clear() {
		this.files.clear();
	}

	/**
	 * Returns an array of all file paths in the virtual file system.
	 */
	list() {
		return Array.from(this.files.keys());
	}
}
