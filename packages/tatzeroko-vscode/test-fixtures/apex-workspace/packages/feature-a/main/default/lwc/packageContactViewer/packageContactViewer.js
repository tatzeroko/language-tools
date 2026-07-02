//@ts-check

import search from "@salesforce/apex/ContactController.search";
import { LightningElement } from "lwc";

export default class PackageContactViewer extends LightningElement {
	connectedCallback() {
		search({ query: "Smith" });
	}
}
