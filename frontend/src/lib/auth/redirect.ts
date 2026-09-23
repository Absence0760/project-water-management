// Only follow same-app relative `?next=` targets (no open redirects).
export function safeNext(next: string | null, fallback: string): string {
	if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return fallback;
	return next;
}
