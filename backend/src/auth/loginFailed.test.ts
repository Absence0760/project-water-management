// The login_failed line (auth/loginFailed.ts) that the login-failed alarm
// counts (infra/alarms.tf): the exact event name the metric filter matches,
// and nothing but the route's pattern and a reason code. The routes' use of it
// (identical answers for an unknown address and a wrong password, no line on
// success) is in login-throttle.security.db.test.ts.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logLoginFailed, type LoginFailureReason } from './loginFailed.js';

afterEach(() => vi.restoreAllMocks());

describe('logLoginFailed', () => {
	it('logs one JSON line with the event, the route pattern and the reason only', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		logLoginFailed('/auth/login', 'bad_password');
		expect(warn).toHaveBeenCalledTimes(1);
		const line = warn.mock.calls[0]![0] as string;
		expect(typeof line).toBe('string');
		// The metric filter's pattern is `{ $.event = "login_failed" }`: one JSON object per line.
		expect(line).not.toContain('\n');
		expect(JSON.parse(line)).toEqual({ event: 'login_failed', route: '/auth/login', reason: 'bad_password' });
	});

	it('takes no argument that could carry an address, an id or a token', () => {
		// The signature is the guard: two closed unions, so a caller can't pass
		// the typed email even by mistake (a type error), and every reason's
		// line has exactly these three keys.
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const reasons: LoginFailureReason[] = ['unknown_account', 'bad_password', 'locked', 'invalid_link'];
		for (const reason of reasons) logLoginFailed('/auth/reset-password', reason);
		const lines = warn.mock.calls.map((c) => JSON.parse(c[0] as string) as Record<string, unknown>);
		expect(lines.map((l) => Object.keys(l).sort())).toEqual(reasons.map(() => ['event', 'reason', 'route']));
		expect(lines.map((l) => l.reason)).toEqual(reasons);
		expect(logLoginFailed.length).toBe(2);
	});
});
