import search from "@salesforce/apex/ContactController.search";

async function run() {
	return await search({ query: "test" });
}

run();
