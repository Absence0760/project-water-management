// The scenario editor's "Application details" card (issue #521): the one-line
// summaries its folds show closed, so the card answers "whose proposal, how
// much of the statement, which base?" without opening anything. Pure, so
// the wording is unit-tested.

/** How many names a summary line lists before "and N more". */
const LISTED = 2;

/**
 * The proposer's units and users, as the fold's line reads after "Proposer:":
 * "none ticked", "Upper farm", "Upper farm, Lower farm", "Upper farm, Lower
 * farm and 3 more".
 */
export function proposerSummary(names: readonly string[]): string {
	if (!names.length) return 'none ticked';
	const listed = names.slice(0, LISTED).join(', ');
	const more = names.length - LISTED;
	return more > 0 ? `${listed} and ${more} more` : listed;
}

/** The statement's line after "Statement:": "0 of 3 answered". */
export const statementSummary = (answered: number, total: number): string => `${answered} of ${total} answered`;
