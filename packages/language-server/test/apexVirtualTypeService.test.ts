import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { ApexVirtualTypeService } from "../src/apex";

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

			const payloads: unknown[] = [];
			const service = new ApexVirtualTypeService(
				{
					sendNotification: () => undefined,
				} as never,
				workspace,
				async (next) => {
					payloads.push(next);
					return undefined;
				},
			);

			await service.initialize();

			const payload = await waitFor(() => {
				const next = payloads.at(-1) as
					| {
							workspace: string;
							files: Array<{ moduleName: string; content: string }>;
					  }
					| undefined;
				return next?.files[0]?.moduleName ===
					"@salesforce/apex/ContactController.search"
					? next
					: undefined;
			});

			expect(payload).toMatchObject({ workspace });
			const files = (
				payload as { files: Array<{ moduleName: string; content: string }> }
			).files;
			expect(files).toHaveLength(1);
			expect(files[0]?.moduleName).toBe(
				"@salesforce/apex/ContactController.search",
			);
			expect(files[0]?.content).toContain("ContactControllerSearchParams");
			expect(files[0]?.content).toContain("Finds contacts matching the query.");
			expect(files[0]?.content).toContain("Promise<unknown[]>");
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
				{
					sendNotification: () => undefined,
				} as never,
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

			const latest = await waitFor(() => {
				const next = notifications.at(-1) as
					| { files: Array<{ moduleName: string }> }
					| undefined;
				return next?.files.some(
					(file) =>
						file.moduleName === "@salesforce/apex/ContactController.count",
				)
					? next
					: undefined;
			});
			expect(latest).toBeDefined();
			const value = latest as {
				files: Array<{ moduleName: string }>;
			};
			expect(value.files.map((file) => file.moduleName)).toContain(
				"@salesforce/apex/ContactController.count",
			);
		} finally {
			fs.rmSync(workspace, { recursive: true, force: true });
		}
	});
});
