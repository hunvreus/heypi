import assert from "node:assert/strict";
import { test } from "node:test";
import { controlActionText, parseControlAction } from "../src/io/control-action.js";

const tokens = {
	approve: "heypi_approve",
	deny: "heypi_deny",
	cancel: "heypi_cancel",
	status: "heypi_status",
};

test("control actions parse provider tokens into canonical commands", () => {
	assert.deepEqual(parseControlAction("heypi_approve:approval-1", tokens), { kind: "approve", id: "approval-1" });
	assert.deepEqual(parseControlAction("heypi_deny:approval-1", tokens), { kind: "deny", id: "approval-1" });
	assert.deepEqual(parseControlAction("heypi_cancel:trace-1", tokens), { kind: "cancel", id: "trace-1" });
	assert.deepEqual(parseControlAction("heypi_status", tokens), { kind: "status" });
	assert.deepEqual(parseControlAction("heypi_status:trace-1", tokens), { kind: "status", id: "trace-1" });
});

test("control actions preserve ids that contain delimiters", () => {
	assert.deepEqual(parseControlAction("heypi_cancel:job:default:daily:1", tokens), {
		kind: "cancel",
		id: "job:default:daily:1",
	});
});

test("control actions reject malformed callbacks", () => {
	assert.equal(parseControlAction(undefined, tokens), undefined);
	assert.equal(parseControlAction("heypi_approve:", tokens), undefined);
	assert.equal(parseControlAction("heypi_unknown:approval-1", tokens), undefined);
	assert.equal(parseControlAction(":approval-1", tokens), undefined);
});

test("control action text maps canonical actions to slash commands", () => {
	assert.equal(controlActionText({ kind: "approve", id: "approval-1" }), "/approve approval-1");
	assert.equal(controlActionText({ kind: "deny", id: "approval-1" }), "/deny approval-1");
	assert.equal(controlActionText({ kind: "cancel", id: "trace-1" }), "/cancel trace-1");
	assert.equal(controlActionText({ kind: "status" }), "/status");
	assert.equal(controlActionText({ kind: "status", id: "trace-1" }), "/status trace-1");
});
