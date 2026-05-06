//@ts-check
// Test fixture: keep the import order stable.

import search from "@salesforce/apex/ContactController.search";
import { LightningElement } from "lwc";

export default class PackageContactViewer extends LightningElement {
	connectedCallback() {
		search({ query: "Smith" });
	}
}
