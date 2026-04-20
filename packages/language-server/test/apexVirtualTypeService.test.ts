import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { ApexVirtualTypeService } from "../src/apex";

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

			let payload: unknown;
			const service = new ApexVirtualTypeService(
				{
					sendNotification: () => undefined,
				} as never,
				workspace,
				async (next) => {
					payload = next;
					return undefined;
				},
			);

			await service.initialize();

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

			expect(notifications.length).toBeGreaterThanOrEqual(1);
			const latest = notifications.at(-1) as {
				files: Array<{ moduleName: string }>;
			};
			expect(latest.files.map((file) => file.moduleName)).toContain(
				"@salesforce/apex/ContactController.count",
			);
		} finally {
			fs.rmSync(workspace, { recursive: true, force: true });
		}
	});
});
