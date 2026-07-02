//@ts-check

import search from "@salesforce/apex/ContactController.search";
import { LightningElement } from "lwc";

export default class ContactViewer extends LightningElement {
	connectedCallback() {
		search({ query: "Smith" });
	}
}
