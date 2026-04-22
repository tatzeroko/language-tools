import search from "@salesforce/apex/ContactController.search";

async function run() {
	return await search({ query: 1 });
}

run();
