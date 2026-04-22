import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	MAX_VALIDATE_ATTEMPTS,
	buildRetryHint,
	parseValidateMd,
	shouldRetry,
	type ValidateSchema,
	validateAgainstSchema,
} from "../src/sdk/index.js";

describe("SDK validate — schema check (Wish B Group 2)", () => {
	it("validateAgainstSchema passes a matching object", () => {
		const schema: ValidateSchema = {
			type: "object",
			required: ["answer"],
			properties: { answer: { type: "string" } },
		};
		const result = validateAgainstSchema({ answer: "42" }, schema);
		assert.equal(result.ok, true);
		assert.deepEqual([...result.errors], []);
	});

	it("flags wrong root type", () => {
		const schema: ValidateSchema = { type: "object" };
		const result = validateAgainstSchema([], schema);
		assert.equal(result.ok, false);
		assert.match(result.errors[0] ?? "", /expected object, got array/);
	});

	it("flags missing required fields", () => {
		const schema: ValidateSchema = {
			type: "object",
			required: ["a", "b"],
			properties: { a: { type: "string" }, b: { type: "number" } },
		};
		const result = validateAgainstSchema({ a: "x" }, schema);
		assert.equal(result.ok, false);
		assert.ok(result.errors.some((e) => /missing required "b"/.test(e)));
	});

	it("descends into nested object properties", () => {
		const schema: ValidateSchema = {
			type: "object",
			properties: {
				meta: {
					type: "object",
					required: ["id"],
					properties: { id: { type: "string" } },
				},
			},
		};
		const result = validateAgainstSchema({ meta: {} }, schema);
		assert.equal(result.ok, false);
		assert.ok(result.errors.some((e) => /meta: missing required "id"/.test(e)));
	});

	it("checks array items against items schema", () => {
		const schema: ValidateSchema = {
			type: "array",
			items: { type: "string" },
		};
		const result = validateAgainstSchema(["ok", 123, "ok"], schema);
		assert.equal(result.ok, false);
		assert.ok(result.errors.some((e) => /\[1\]: expected string/.test(e)));
	});

	it("treats `number` as accepting integer OR number", () => {
		const schema: ValidateSchema = { type: "number" };
		assert.equal(validateAgainstSchema(3, schema).ok, true);
		assert.equal(validateAgainstSchema(3.14, schema).ok, true);
		assert.equal(validateAgainstSchema("3", schema).ok, false);
	});

	it("enforces integer strictly", () => {
		const schema: ValidateSchema = { type: "integer" };
		assert.equal(validateAgainstSchema(3, schema).ok, true);
		assert.equal(validateAgainstSchema(3.14, schema).ok, false);
	});

	it("checks enum membership", () => {
		const schema: ValidateSchema = { type: "string", enum: ["a", "b"] };
		assert.equal(validateAgainstSchema("a", schema).ok, true);
		const fail = validateAgainstSchema("z", schema);
		assert.equal(fail.ok, false);
		assert.ok(fail.errors.some((e) => /not in enum/.test(e)));
	});
});

describe("parseValidateMd — VALIDATE.md loader", () => {
	it("extracts a ```json fenced schema block", () => {
		const md =
			'Schema below:\n\n```json\n{ "type": "object", "required": ["ok"] }\n```\n';
		const { schema, rawBlock } = parseValidateMd(md);
		assert.ok(schema);
		assert.equal(schema?.type, "object");
		assert.deepEqual([...(schema?.required ?? [])], ["ok"]);
		assert.ok(rawBlock && rawBlock.includes('"type": "object"'));
	});

	it("also accepts bare ``` fences", () => {
		const md = '```\n{"type":"string"}\n```';
		const { schema } = parseValidateMd(md);
		assert.equal(schema?.type, "string");
	});

	it("returns null schema when no fence is present", () => {
		const { schema, rawBlock } = parseValidateMd("no fence here");
		assert.equal(schema, null);
		assert.equal(rawBlock, null);
	});

	it("returns null schema when body isn't valid JSON but keeps raw block", () => {
		const md = "```json\nnot json\n```";
		const { schema, rawBlock } = parseValidateMd(md);
		assert.equal(schema, null);
		assert.ok(rawBlock?.includes("not json"));
	});
});

describe("shouldRetry + buildRetryHint — WISH.md G2 criterion 3", () => {
	it("passes do not retry", () => {
		assert.equal(
			shouldRetry({ ok: true, errors: [] }, 1),
			false,
		);
	});

	it("first failure retries (attempt 1 → retry)", () => {
		assert.equal(
			shouldRetry({ ok: false, errors: ["boom"] }, 1),
			true,
		);
	});

	it("second failure does not retry (attempt 2 → stop)", () => {
		assert.equal(
			shouldRetry({ ok: false, errors: ["boom"] }, MAX_VALIDATE_ATTEMPTS),
			false,
		);
	});

	it("buildRetryHint returns empty for passes", () => {
		assert.equal(buildRetryHint({ ok: true, errors: [] }), "");
	});

	it("buildRetryHint includes every error + schema snippet", () => {
		const result = {
			ok: false,
			errors: ["<root>: expected object, got array", "missing required x"],
			schemaSource: '{ "type": "object" }',
		};
		const hint = buildRetryHint(result);
		assert.match(hint, /did not match VALIDATE\.md/);
		for (const e of result.errors) assert.ok(hint.includes(e));
		assert.ok(hint.includes('"type": "object"'));
		assert.match(hint, /Emit a corrected payload/);
	});

	it("MAX_VALIDATE_ATTEMPTS is 2 per spec", () => {
		assert.equal(MAX_VALIDATE_ATTEMPTS, 2);
	});
});
