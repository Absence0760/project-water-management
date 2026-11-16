// The checks on a station API feed's URL and headers (issue #784) that need
// no network: the address ranges a feed may never ask, a URL's shape, and a
// header a person typed. Dependency-free (node:net and node:http only), so the
// feed config schema (config.ts) and the client (stationHttp.ts) share them
// without an import cycle. Why each rule: stationHttp.ts.
import { validateHeaderName, validateHeaderValue } from 'node:http';
import { BlockList, isIP } from 'node:net';

export const V4_BLOCKED = [
	'0.0.0.0/8',
	'10.0.0.0/8',
	'100.64.0.0/10',
	'127.0.0.0/8',
	'169.254.0.0/16',
	'172.16.0.0/12',
	'192.0.0.0/24',
	'192.0.2.0/24',
	'192.88.99.0/24',
	'192.168.0.0/16',
	'198.18.0.0/15',
	'198.51.100.0/24',
	'203.0.113.0/24',
	'224.0.0.0/4',
	'240.0.0.0/4'
];
/** Inside 2000::/3 (the only IPv6 space allowed at all), the special-purpose blocks. */
export const V6_BLOCKED = ['64:ff9b::/96', '64:ff9b:1::/48', '2001::/23', '2001:db8::/32', '2002::/16', '3fff::/20'];

const BLOCKED = (() => {
	const bl = new BlockList();
	for (const c of V4_BLOCKED) {
		const [net, bits] = c.split('/');
		bl.addSubnet(net!, Number(bits), 'ipv4');
	}
	for (const c of V6_BLOCKED) {
		const [net, bits] = c.split('/');
		bl.addSubnet(net!, Number(bits), 'ipv6');
	}
	return bl;
})();
const GLOBAL_V6 = (() => {
	const bl = new BlockList();
	bl.addSubnet('2000::', 3, 'ipv6');
	return bl;
})();
/** ::ffff:a.b.c.d or ::ffff:hhhh:hhhh (how the URL parser writes it). */
const MAPPED_V4 = /^::ffff:(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f]{1,4}:[0-9a-f]{1,4})$/i;

/**
 * Whether an address may be connected to. IPv4: not in V4_BLOCKED. IPv6: an
 * IPv4-mapped one is judged by its IPv4 (BlockList checks a mapped address
 * against the IPv4 rules); any other must be in 2000::/3 (global unicast) and
 * not in V6_BLOCKED, which leaves out loopback, unspecified, IPv4-compatible,
 * ULA (fc00::/7, the EC2 metadata fd00:ec2::254 included), link- and
 * site-local and multicast.
 */
export function addressAllowed(address: string): boolean {
	const fam = isIP(address);
	if (fam === 4) return !BLOCKED.check(address, 'ipv4');
	if (fam !== 6) return false;
	if (MAPPED_V4.test(address)) return !BLOCKED.check(address, 'ipv6');
	return GLOBAL_V6.check(address, 'ipv6') && !BLOCKED.check(address, 'ipv6');
}

/** Header names a person may not set: the transport's own, and the ones that would change what the request is. */
const RESERVED_HEADERS = new Set([
	'host',
	'content-length',
	'transfer-encoding',
	'connection',
	'keep-alive',
	'te',
	'upgrade',
	'expect',
	'cookie',
	'accept-encoding',
	'user-agent',
	'trailer'
]);
export const MAX_HEADERS = 8;

/** The reason a header can't be sent, or null. Names are case-insensitive; values one line, ≤ 4096 characters. */
export function headerProblem(name: string, value: string): string | null {
	try {
		validateHeaderName(name);
	} catch {
		return `“${name.slice(0, 40)}” is not a valid header name`;
	}
	const n = name.toLowerCase();
	if (RESERVED_HEADERS.has(n) || n.startsWith('proxy-') || n.startsWith('sec-')) return `the ${n} header is set by the app, not the feed`;
	if (value.length > 4096) return `the ${n} header’s value is too long`;
	try {
		validateHeaderValue(name, value);
	} catch {
		return `the ${n} header’s value has a character a header can’t carry`;
	}
	return null;
}

/**
 * The hosts our own feeds and the bulk ingest ask (FEED_HOSTS, ingest/*.py), and their parents' suffixes. A station
 * URL may not point at them: our fetcher shares an outbound address with those jobs, and a source that blocks by
 * address for volume (CHC did, 2026-10-25) would cut off our own data. stationUrl.test.ts checks FEED_HOSTS is covered.
 */
export const OWN_UPSTREAM_HOSTS: readonly string[] = [
	'data.chc.ucsb.edu',
	'www.dws.gov.za',
	'dws.gov.za',
	'www.cpc.ncep.noaa.gov',
	'deafrica-services.s3.af-south-1.amazonaws.com',
	'deafrica-sentinel-2-l2a-c1.s3.af-south-1.amazonaws.com',
	'deafrica-sentinel-1.s3.af-south-1.amazonaws.com',
	'api.digitalearth.africa',
	'geoserver.digitalearth.africa',
	'explorer.digitalearth.africa',
	'storage.googleapis.com',
	'edcintl.cr.usgs.gov',
	'cds.climate.copernicus.eu',
	'power.larc.nasa.gov',
	'ecmwf-forecasts.s3.eu-central-1.amazonaws.com',
	'.earthdata.nasa.gov',
	'.eosdis.nasa.gov'
];

const ownUpstream = (host: string) => OWN_UPSTREAM_HOSTS.some((h) => (h.startsWith('.') ? host.endsWith(h) : host === h));

/** Why a URL can't be asked, or null: https, the default port, no user:password, a public host. Checked at save and before each request. */
export function urlProblem(url: URL): string | null {
	if (url.protocol !== 'https:') return 'the URL must start with https://';
	if (url.port !== '' && url.port !== '443') return 'the URL must use the standard HTTPS port (no :port)';
	if (url.username || url.password) return 'put the user name and password in the key, not in the URL';
	const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
	if (isIP(host)) return addressAllowed(host) ? null : 'the URL points at a private or reserved address';
	if (!host.includes('.') || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
		return 'the URL’s host must be a public internet name';
	}
	if (ownUpstream(host.toLowerCase())) return 'the URL points at a data source the app itself reads, which a station feed may not ask';
	return null;
}

