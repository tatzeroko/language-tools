// Prepares everything the desktop test needs and prints the exact settings to use.
// Downloads (once) and SHA-256-verifies the pinned TypeScript Apex server; only *locates* Jorje.
import { findOfficialJorjeJar } from "../src/jorje-locator.ts";
import { fetchServer } from "./fetch-server.ts";

const dir = fetchServer();
const jar = findOfficialJorjeJar();
console.log(
	"\nAdd to the workspace/user settings (nothing else is required):\n",
);
console.log(
	JSON.stringify(
		{
			"tatzeroko.experimental.apexMultiProject.enabled": true,
			"tatzeroko.experimental.apexMultiProject.typescriptServerDir": dir,
		},
		null,
		2,
	),
);
console.log(
	jar
		? `\nOfficial Salesforce Apex extension JAR found (read in place, never copied):\n  ${jar}`
		: "\nNo official Salesforce Apex extension JAR found (Jorje engine unavailable until the Salesforce Apex extension is installed).",
);
