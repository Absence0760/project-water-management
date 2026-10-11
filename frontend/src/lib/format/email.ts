// Where a long email address may wrap. An address has no spaces, so on a narrow
// screen the browser breaks it wherever the line ends (mid-word, "catchme|nt").
// EmailText.svelte puts a <wbr> after each part here instead, so it wraps
// before the "@" and after a ".", "-", "_" or "+", like a person would.

const escapeClass = (chars: string) => chars.replace(/[\\\]^-]/g, '\\$&');

/**
 * "jo.smith@farm-a.example" → ["jo.", "smith", "@farm-", "a.", "example"]. Joined, the parts give back the address.
 * `breakAfter` narrows where it may wrap after a character: "." keeps it to before the "@" and after a "." (the team
 * page's members, issue #520), so "@farm-a.example" never splits at its hyphen.
 */
export function emailParts(email: string, breakAfter = '.-_+'): string[] {
	const after = breakAfter ? `|(?<=[${escapeClass(breakAfter)}])` : '';
	return email.split(new RegExp(`(?=@)${after}`)).filter((p) => p.length > 0);
}

/**
 * emailParts grouped at the "@": the name's parts, then the domain's ("@farm-a.", "example"). EmailText draws each
 * group as one unit, so the address wraps at its "@" first and inside a group (after a ".") only when the group is
 * wider than the line: "demo" / "@example.com", never "demo@example." / "com" (issue #520).
 */
export function emailGroups(email: string, breakAfter?: string): string[][] {
	const parts = emailParts(email, breakAfter);
	const at = parts.findIndex((p) => p.startsWith('@'));
	return (at < 0 ? [parts] : [parts.slice(0, at), parts.slice(at)]).filter((g) => g.length > 0);
}
