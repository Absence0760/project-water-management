// Who made a row, once their account is deleted. The project's record stays
// with the name gone (138, issue #112; docs/security.md § Personal
// information), so a maker's name can be null on a run, an ensemble, a
// nomination, a scenario, an import and the rest. Workspace text (English);
// farmer pages say t('A former member') themselves.

/** Name shown for whoever made something, once their account is gone. */
export const FORMER_MEMBER = 'a former member';
