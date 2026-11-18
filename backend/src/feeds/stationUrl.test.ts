import { describe, expect, it } from 'vitest';
import { FEED_HOSTS } from './http.js';
import { OWN_UPSTREAM_HOSTS, urlProblem } from './stationUrl.js';

describe('the hosts a station URL may not point at', () => {
	it('cover every host our own feeds ask (FEED_HOSTS)', () => {
		const missing = FEED_HOSTS.map((h) => h.toLowerCase()).filter((h) => !OWN_UPSTREAM_HOSTS.some((o) => (o.startsWith('.') ? h.endsWith(o) : h === o)));
		expect(missing).toEqual([]);
	});

	it('are refused as hosts and as parents, not as look-alikes', () => {
		expect(urlProblem(new URL('https://data.chc.ucsb.edu/x'))).toMatch(/the app itself reads/);
		expect(urlProblem(new URL('https://gpm1.gesdisc.eosdis.nasa.gov/x'))).toMatch(/the app itself reads/);
		expect(urlProblem(new URL('https://chc.ucsb.edu.example.com/x'))).toBeNull();
	});
});
