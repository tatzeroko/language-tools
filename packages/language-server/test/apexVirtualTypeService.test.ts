import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { ApexVirtualTypeService } from "../src/apex";
import { generateApexVirtualFiles } from "../src/apex-generator";
import { ApexWorkerClient } from "../src/apex-worker-client";

type ApexPayload = {
	workspace: string;
	files: Array<{ moduleName: string; content: string }>;
};

function isApexPayload(value: unknown): value is ApexPayload {
	return (
		typeof value === "object" &&
		value !== null &&
		"workspace" in value &&
		"files" in value
	);
}

async function waitFor<T>(fn: () => T | undefined, timeoutMs = 3000) {
	const started = Date.now();
	let value: T | undefined;
	while (Date.now() - started < timeoutMs) {
		value = fn();
		if (value !== undefined) {
			return value;
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return value;
}

describe("ApexVirtualTypeService", () => {
	it("generates a virtual declaration from an Apex class", async () => {
		const workspace = fs.mkdtempSync(
			path.join(process.cwd(), "apex-workspace-"),
		);
		try {
			const apexPath = path.join(
				workspace,
				"force-app",
				"main",
				"default",
				"classes",
				"ContactController.cls",
			);
			fs.mkdirSync(path.dirname(apexPath), { recursive: true });
			fs.writeFileSync(
				apexPath,
				`global with sharing class ContactController {
    /**
     * Finds contacts matching the query.
     * @param query - The search term against Contact.Name.
     * @return matching contacts.
     */
    @AuraEnabled(cacheable=true)
    public static List<Contact> search(String query) {
        return new List<Contact>();
    }
}`,
				"utf8",
			);

			const payloads: ApexPayload[] = [];
			const service = new ApexVirtualTypeService(
				{ sendNotification: () => undefined },
				workspace,
				async (next) => {
					if (isApexPayload(next)) {
						payloads.push(next);
					}
					return undefined;
				},
			);

			await service.initialize();

			await waitFor(() => {
				return payloads.length >= 2 ? true : undefined;
			});

			const latestPayload = payloads.at(-1);
			const firstPayload = payloads[0];
			expect(firstPayload).toMatchObject({ workspace });
			expect(firstPayload?.files[0]?.content).toContain("params: unknown");
			expect(firstPayload?.files[0]?.content).toContain("Promise<unknown>");
			expect(firstPayload?.files[0]?.content).toContain("@param params.query");
			expect(latestPayload).toMatchObject({ workspace });
			const files = latestPayload?.files ?? [];
			expect(files).toHaveLength(1);
			expect(files[0]?.moduleName).toBe(
				"@salesforce/apex/ContactController.search",
			);
			expect(files[0]?.content).toContain("query: string");
			expect(files[0]?.content).toContain("Finds contacts matching the query.");
			expect(files[0]?.content).toContain("Promise<unknown[]>");
		} finally {
			fs.rmSync(workspace, { recursive: true, force: true });
		}
	});

	it("refreshes generated typings when a watched Apex file changes on disk", async () => {
		const workspace = fs.mkdtempSync(
			path.join(process.cwd(), "apex-workspace-"),
		);
		try {
			const apexPath = path.join(
				workspace,
				"force-app",
				"main",
				"default",
				"classes",
				"ContactController.cls",
			);
			fs.mkdirSync(path.dirname(apexPath), { recursive: true });
			fs.writeFileSync(
				apexPath,
				`global with sharing class ContactController {
    @AuraEnabled(cacheable=true)
    public static List<Contact> search(String query) {
        return new List<Contact>();
    }
}`,
				"utf8",
			);

			const payloads: ApexPayload[] = [];
			const service = new ApexVirtualTypeService(
				{ sendNotification: () => undefined },
				workspace,
				async (next) => {
					if (isApexPayload(next)) {
						payloads.push(next);
					}
					return undefined;
				},
			);

			await service.initialize();
			await waitFor(() => (payloads.length >= 2 ? true : undefined));

			fs.writeFileSync(
				apexPath,
				`global with sharing class ContactController {
    @AuraEnabled(cacheable=true)
    public static List<Contact> search(String query) {
        return new List<Contact>();
    }

    @AuraEnabled(cacheable=true)
    public static Integer count() {
        return 0;
    }
}`,
				"utf8",
			);

			await waitFor(() =>
				payloads.some((payload) =>
					payload.files.some((file) => file.moduleName.endsWith(".count")),
				)
					? true
					: undefined,
			);

			const latestPayload = payloads.at(-1);
			expect(latestPayload?.files.map((file) => file.moduleName)).toContain(
				"@salesforce/apex/ContactController.count",
			);
		} finally {
			fs.rmSync(workspace, { recursive: true, force: true });
		}
	});

	it("generates typings for multiple Apex classes", async () => {
		const workspace = fs.mkdtempSync(
			path.join(process.cwd(), "apex-workspace-"),
		);
		try {
			const firstApexPath = path.join(
				workspace,
				"force-app",
				"main",
				"default",
				"classes",
				"ContactController.cls",
			);
			const secondApexPath = path.join(
				workspace,
				"force-app",
				"main",
				"default",
				"classes",
				"AccountController.cls",
			);
			fs.mkdirSync(path.dirname(firstApexPath), { recursive: true });
			fs.writeFileSync(
				firstApexPath,
				`global class ContactController {
				@AuraEnabled
				public static List<Contact> search(String query) {
					return new List<Contact>();
				}
			}`,
				"utf8",
			);
			fs.writeFileSync(
				secondApexPath,
				`global class AccountController {
				@AuraEnabled
				public static Integer count() {
					return 0;
				}
			}`,
				"utf8",
			);

			const payloads: ApexPayload[] = [];
			const service = new ApexVirtualTypeService(
				{ sendNotification: () => undefined },
				workspace,
				async (next) => {
					if (isApexPayload(next)) {
						payloads.push(next);
					}
					return undefined;
				},
			);

			await service.initialize();
			await waitFor(() => (payloads.length >= 2 ? true : undefined));

			const latestPayload = payloads.at(-1);
			expect(latestPayload?.files.map((file) => file.moduleName)).toEqual(
				expect.arrayContaining([
					"@salesforce/apex/ContactController.search",
					"@salesforce/apex/AccountController.count",
				]),
			);
		} finally {
			fs.rmSync(workspace, { recursive: true, force: true });
		}
	});

	it("refreshes generated typings when the Apex source changes", async () => {
		const workspace = fs.mkdtempSync(
			path.join(process.cwd(), "apex-workspace-"),
		);
		try {
			const apexPath = path.join(workspace, "classes", "ContactController.cls");
			fs.mkdirSync(path.dirname(apexPath), { recursive: true });
			fs.writeFileSync(
				apexPath,
				`global class ContactController {
    @AuraEnabled
    public static List<Contact> search(String query) {
        return new List<Contact>();
    }
}`,
				"utf8",
			);

			const notifications: unknown[] = [];
			const service = new ApexVirtualTypeService(
				{ sendNotification: () => undefined },
				workspace,
				async (next) => {
					notifications.push(next);
					return undefined;
				},
			);

			await service.initialize();
			service.handleDocumentSaved(
				`file://${apexPath}`,
				`global class ContactController {
    @AuraEnabled
    public static List<Contact> search(String query) {
        return new List<Contact>();
    }

    @AuraEnabled
    public static Integer count() {
        return 0;
    }
}`,
			);

			await waitFor(() => {
				return notifications.length >= 2 ? true : undefined;
			});
			const latestNotification = notifications.at(-1) as
				| { files: Array<{ moduleName: string; content: string }> }
				| undefined;
			expect(latestNotification).toBeDefined();
			const value = latestNotification as {
				files: Array<{ moduleName: string; content: string }>;
			};
			expect(value.files.map((file) => file.moduleName)).toContain(
				"@salesforce/apex/ContactController.count",
			);
		} finally {
			fs.rmSync(workspace, { recursive: true, force: true });
		}
	});

	it("falls back to direct generation when the worker script is missing", async () => {
		const workspace = fs.mkdtempSync(
			path.join(process.cwd(), "apex-workspace-"),
		);
		try {
			const worker = new ApexWorkerClient(workspace);
			(
				worker as unknown as { hasWorkerScript: () => boolean }
			).hasWorkerScript = () => false;
			const apexPath = path.join(workspace, "classes", "ContactController.cls");
			fs.mkdirSync(path.dirname(apexPath), { recursive: true });
			fs.writeFileSync(
				apexPath,
				`global class ContactController {
				    @AuraEnabled
				    public static Integer count() {
				        return 0;
				    }
				}`,
				"utf8",
			);

			const files = await worker.generate([
				[apexPath, fs.readFileSync(apexPath, "utf8")],
			]);
			expect(files).toHaveLength(1);
			expect(files[0]?.moduleName).toBe(
				"@salesforce/apex/ContactController.count",
			);
		} finally {
			fs.rmSync(workspace, { recursive: true, force: true });
		}
	});

	it("keeps nested class methods scoped to their class body", () => {
		const files = generateApexVirtualFiles("/workspace", [
			[
				"/workspace/classes/OuterController.cls",
				`global class OuterController {
    @AuraEnabled
    public static String outer() {
        return 'ok';
    }

    public class InnerController {
        @AuraEnabled
        public static Integer inner() {
            return 1;
        }
    }
}`,
			],
		]);

		expect(files.map((file) => file.moduleName)).toEqual([
			"@salesforce/apex/OuterController.outer",
			"@salesforce/apex/InnerController.inner",
		]);
	});
});
