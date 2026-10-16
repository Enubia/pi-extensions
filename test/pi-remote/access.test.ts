import assert from "node:assert/strict";
import { test } from "node:test";
import { isAllowedAddress, isAuthorized } from "../../apps/pi-remote/access.ts";

test("allows loopback, private and link-local addresses", () => {
	for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.20", "169.254.3.4", "::1", "fc00::1", "fd12:3456::9", "fe80::1", "fe80::1%en0", "febf::1", "::ffff:192.168.1.5", "::ffff:127.0.0.1"]) {
		assert.equal(isAllowedAddress(address), true, address);
	}
});

test("rejects public and malformed addresses", () => {
	for (const address of [undefined, "", "8.8.8.8", "172.15.0.1", "172.32.0.1", "192.169.0.1", "169.255.0.1", "11.0.0.1", "2001:db8::1", "fec0::1", "::ffff:8.8.8.8", "garbage", "10.0.0", "10.0.0.256", "::"]) {
		assert.equal(isAllowedAddress(address), false, String(address));
	}
});

test("authorizes via bearer header or query token", () => {
	assert.equal(isAuthorized({ authorization: "Bearer secret" }, "/api/x", "secret"), true);
	assert.equal(isAuthorized({}, "/events?t=secret", "secret"), true);
	assert.equal(isAuthorized({ authorization: "Bearer secret" }, "/events?t=wrong", "secret"), true);
});

test("rejects missing, wrong or differently sized tokens", () => {
	assert.equal(isAuthorized({}, "/events", "secret"), false);
	assert.equal(isAuthorized({ authorization: "Bearer nope" }, "/events", "secret"), false);
	assert.equal(isAuthorized({ authorization: "Bearer secre" }, "/events", "secret"), false);
	assert.equal(isAuthorized({ authorization: "secret" }, "/events", "secret"), false);
	assert.equal(isAuthorized({}, "/events?t=", "secret"), false);
	assert.equal(isAuthorized({ authorization: "Bearer secret" }, "/events", ""), false);
});
