//@ts-check
/** biome-ignore-all assist/source/organizeImports: This file is used for testing and should only be edited in a way that is relevant to the test. */

import { LightningElement } from "lwc";

import search from "@salesforce/apex/ContactController.search";

export default class ContactViewer extends LightningElement {
	connectedCallback() {
		search({ query: "Smith" });
	}
}
