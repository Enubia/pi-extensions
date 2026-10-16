import { isIPv4, isIPv6 } from "node:net";
import { timingSafeEqual } from "node:crypto";

function ipv4Allowed(address: string): boolean {
	const parts = address.split(".").map(Number);
	if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
	const [a, b] = parts;
	return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

function ipv6Allowed(address: string): boolean {
	const lower = address.toLowerCase();
	if (lower === "::1") return true;
	const first = lower.split(":")[0];
	if (!first) return false;
	const value = Number.parseInt(first, 16);
	if (!Number.isFinite(value)) return false;
	return (value & 0xfe00) === 0xfc00 || (value & 0xffc0) === 0xfe80;
}

export function isAllowedAddress(address: string | undefined): boolean {
	if (!address) return false;
	let value = address;
	const zone = value.indexOf("%");
	if (zone !== -1) value = value.slice(0, zone);
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(value);
	if (mapped) value = mapped[1];
	if (isIPv4(value)) return ipv4Allowed(value);
	if (isIPv6(value)) return ipv6Allowed(value);
	return false;
}

function tokensMatch(candidate: string, expected: string): boolean {
	if (!expected || !candidate) return false;
	const a = Buffer.from(candidate);
	const b = Buffer.from(expected);
	return a.length === b.length && timingSafeEqual(a, b);
}

export function isAuthorized(headers: { authorization?: string | string[] }, url: string, token: string): boolean {
	const header = Array.isArray(headers.authorization) ? headers.authorization[0] : headers.authorization;
	const bearer = header && /^Bearer (.+)$/.exec(header)?.[1];
	if (bearer && tokensMatch(bearer, token)) return true;
	const query = new URL(url, "http://localhost").searchParams.get("t");
	return query !== null && tokensMatch(query, token);
}
