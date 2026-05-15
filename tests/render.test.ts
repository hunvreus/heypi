import assert from "node:assert/strict";
import { test } from "node:test";
import { chunkText } from "../src/render/chunk.js";

test("chunkText keeps short text intact", () => {
	assert.deepEqual(chunkText("hello", 10), ["hello"]);
});

test("chunkText drops empty text", () => {
	assert.deepEqual(chunkText("", 10), []);
});

test("chunkText splits on paragraph boundaries when possible", () => {
	const text = ["alpha beta", "gamma delta", "epsilon"].join("\n\n");

	assert.deepEqual(chunkText(text, 24), ["alpha beta\n\ngamma delta", "epsilon"]);
});

test("chunkText splits long lines without exceeding the limit", () => {
	const chunks = chunkText("alpha beta gamma delta epsilon", 12);

	assert.deepEqual(chunks, ["alpha beta", "gamma delta", "epsilon"]);
	assert.equal(
		chunks.every((chunk) => chunk.length <= 12),
		true,
	);
});

test("chunkText hard-splits long words", () => {
	const chunks = chunkText("abcdefghijklmnop", 5);

	assert.deepEqual(chunks, ["abcde", "fghij", "klmno", "p"]);
});

test("chunkText rejects invalid limits", () => {
	assert.throws(() => chunkText("hello", 0), /invalid chunk limit/);
	assert.throws(() => chunkText("hello", 1.5), /invalid chunk limit/);
});
