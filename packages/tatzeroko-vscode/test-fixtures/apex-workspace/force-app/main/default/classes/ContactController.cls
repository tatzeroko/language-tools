global with sharing class ContactController {
	/**
	 * Finds contacts matching the query.
	 * @param query - The search term against Contact.Name.
	 * @return matching contacts.
	 */
	@AuraEnabled(cacheable=true)
	public static List<Contact> search(String query) {
		return new List<Contact>();
	}
}
