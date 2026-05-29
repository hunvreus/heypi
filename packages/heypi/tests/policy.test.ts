import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyCommand } from "@hunvreus/heypi";

test("command classification blocks rm -rf root even when followed by more shell", () => {
	assert.equal(classifyCommand("rm -rf /").risk, "block");
	assert.equal(classifyCommand("rm -rf / && echo done").risk, "block");
});

test("command classification supports additive allow, approval, and block patterns", () => {
	assert.deepEqual(classifyCommand("curl -I https://example.com", { allow: [/^curl -I /] }), {
		risk: "allow",
		reason: "allowed by /^curl -I /",
	});
	assert.deepEqual(classifyCommand("make deploy", { approve: [/make deploy/] }), {
		risk: "approval",
		reason: "approval by /make deploy/",
	});
	assert.deepEqual(classifyCommand("gh repo delete test", { block: [/gh repo delete/] }), {
		risk: "block",
		reason: "blocked by /gh repo delete/",
	});
});

test("command classification requires approval for firewall mutation", () => {
	assert.equal(classifyCommand("sudo ufw allow 8090/tcp").risk, "approval");
	assert.equal(classifyCommand("sudo iptables -A INPUT -p tcp --dport 8090 -j ACCEPT").risk, "approval");
	assert.equal(classifyCommand("sudo nft add rule inet filter input tcp dport 8090 accept").risk, "approval");
});

test("command classification does not let one allowed segment allow a compound command", () => {
	const policy = { allow: [/^\s*curl\s+-I\s+http:\/\/127\.0\.0\.1:8090\b/] };

	assert.equal(classifyCommand("curl -I http://127.0.0.1:8090", policy).risk, "allow");
	assert.equal(classifyCommand("sudo ufw allow 8090/tcp && curl -I http://127.0.0.1:8090", policy).risk, "approval");
	assert.equal(classifyCommand("curl -I http://127.0.0.1:8090 || sudo ufw allow 8090/tcp", policy).risk, "approval");
});

test("command classification inspects nested shell command lists", () => {
	assert.equal(classifyCommand("if true; then sudo ufw allow 80/tcp; fi").risk, "approval");
	assert.equal(classifyCommand("for f in a; do sudo iptables -S; done").risk, "approval");
	assert.equal(classifyCommand("(sudo nft add rule inet filter input tcp dport 80 accept)").risk, "approval");
});

test("command classification fails closed when shell cannot be parsed", () => {
	assert.equal(classifyCommand("if true; then").risk, "approval");
});

test("command classification handles stateful regex flags deterministically", () => {
	const allow = /^curl -I /g;
	assert.equal(classifyCommand("curl -I https://example.com", { allow: [allow] }).risk, "allow");
	assert.equal(classifyCommand("curl -I https://example.com", { allow: [allow] }).risk, "allow");

	const block = /gh repo delete/y;
	assert.equal(classifyCommand("gh repo delete test", { block: [block] }).risk, "block");
	assert.equal(classifyCommand("gh repo delete test", { block: [block] }).risk, "block");
});
