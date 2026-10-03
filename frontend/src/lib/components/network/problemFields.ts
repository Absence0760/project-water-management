// Which fields a message from the model check is about (lib/model/validate:
// supplyIssues, developmentIssue), so the one-node form marks those fields
// aria-invalid and points them at the message (aria-describedby): a
// screen-reader user on "Back to the dam at" hears that it is the problem.
// Matched on the messages' own words; a message nothing matches marks no field.

export type SupplyField = 'rule' | 'pump' | 'levels';

/** The Supply section's fields a supplyIssues message is about. */
export function supplyProblemFields(message: string): SupplyField[] {
	if (/switch levels|switch-back level/.test(message)) return ['levels'];
	if (/pump capacity can't be negative/.test(message)) return ['pump'];
	if (/supply rule|run of river/.test(message)) return ['rule'];
	return [];
}

export type DevelopmentField = 'survey' | 'sediment' | 'in-service' | 'abstraction';

/** The development fields a developmentIssue message is about. */
export function developmentProblemFields(message: string | null): DevelopmentField[] {
	if (!message) return [];
	if (/has a dam/.test(message)) return ['survey', 'sediment', 'in-service'];
	if (/sediment rate needs the date/.test(message)) return ['survey', 'sediment'];
	if (/sediment rate/.test(message)) return ['sediment'];
	if (/survey date/.test(message)) return ['survey'];
	if (/in-service date/.test(message)) return ['in-service'];
	if (/abstraction|gauge takes no water/.test(message)) return ['abstraction'];
	return [];
}
