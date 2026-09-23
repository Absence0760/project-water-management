// Where a long email address may wrap. An address has no spaces, so on a narrow
// screen the browser breaks it wherever the line ends (mid-word, "catchme|nt").
// EmailText.svelte puts a <wbr> after each part here instead, so it wraps
// before the "@" and after a ".", "-", "_" or "+", like a person would.

/** "jo.smith@farm-a.example" → ["jo.", "smith", "@farm-", "a.", "example"]. Joined, the parts give back the address. */
export function emailParts(email: string): string[] {
	return email.split(/(?=@)|(?<=[.\-_+])/).filter((p) => p.length > 0);
}
