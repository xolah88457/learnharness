import assert from "node:assert/strict";
import { it } from "node:test";
import { createNotesImportQueue } from "../components/notes-import-queue.ts";
import type { NotesImportResult } from "../components/notes-import.tsx";
import { MAX_IMPORT_BYTES } from "../lib/notes-import-limits.ts";
const tick = () => new Promise<void>((done) => setImmediate(done));
const file = (name: string, path?: string) => { const f = new File(["notes"], name); if (path) Object.defineProperty(f, "webkitRelativePath", { value: path }); return f; };
const success = (name: string): NotesImportResult => ({ requestIndex: 0, filePath: name, ok: true, outcome: "completed", stats: { nodes: 0 } });

it("one appendable queue stays three-wide across same-tick selections, refilling behind a slow first file", async () => {
	const calls: { file: File; resolve: (rows: NotesImportResult[]) => void; reject: (error: Error) => void }[] = [];
	const queue = createNotesImportQueue(async (files) => new Promise((resolve, reject) => { assert.equal(files.length, 1); calls.push({ file: files[0]!, resolve, reject }); }));
	queue.append([file("a.md"), file("b.md"), file("c.md"), file("d.md")]);
	queue.append([file("e.md"), file("f.md")]);
	assert.equal(calls.length, 3);
	calls[1]!.resolve([success("b.md")]); await tick();
	assert.equal(calls.length, 4); assert.equal(calls[3]!.file.name, "d.md");
	calls[2]!.reject(new Error("lost response")); await tick();
	assert.equal(calls.length, 5); assert.equal(calls[4]!.file.name, "e.md");
	calls[3]!.resolve([success("d.md")]); await tick();
	assert.equal(calls.length, 6);
	calls[4]!.resolve([success("e.md")]); calls[5]!.resolve([success("f.md")]); await tick();
	assert.equal(queue.getSnapshot().importing, true, "slow a still running");
	assert.equal(queue.getSnapshot().completion, 0);
	calls[0]!.resolve([success("a.md")]); await tick();
	assert.equal(queue.getSnapshot().importing, false); assert.equal(queue.getSnapshot().completion, 1);
	assert.deepEqual(queue.getSnapshot().errors, ["c.md: lost response"]);
	assert.equal(calls.length, 6, "no automatic retry");
});

it("errors/notices keep selection order across appends even when requests settle backwards", async () => {
	const pending: ((results: NotesImportResult[]) => void)[] = [];
	const queue = createNotesImportQueue(async () => new Promise((resolve) => pending.push(resolve)));
	queue.append([file("same.md", "A/same.md"), file("same.md", "B/same.md")]);
	queue.append([file("c.pdf", "B/c.pdf")]);
	pending[2]!([{ ...success("B/c.pdf"), notice: "Scanner caveat" }]);
	pending[1]!([{ requestIndex: 0, filePath: "B/same.md", ok: false, outcome: "partial", error: "second" }]);
	pending[0]!([{ requestIndex: 0, filePath: "A/same.md", ok: false, outcome: "busy", error: "first" }]);
	await tick();
	assert.deepEqual(queue.getSnapshot().errors, ["A/same.md: first", "B/same.md: second"]);
	assert.deepEqual(queue.getSnapshot().notices, ["B/c.pdf: Scanner caveat"]);
});

it("unsupported-only directories are never sent; picker .DS_Store is ignored and eligible siblings proceed", async () => {
	const paths: string[] = [];
	const queue = createNotesImportQueue(async ([f]) => { const path = f!.webkitRelativePath || f!.name; paths.push(path); return [success(path)]; });
	queue.append([file(".DS_Store", "Root/.DS_Store"), file("a.png", "Root/Images/a.png"), file("notes.md", "Root/Sub/notes.md"), file("bad.txt", "../bad.txt")]);
	await tick();
	assert.deepEqual(paths, ["Root/Sub/notes.md"]);
	assert.deepEqual(queue.getSnapshot().errors, ["../bad.txt: Unsafe relative path."]);
	assert.deepEqual(queue.getSnapshot().notices, ["1 file skipped (unsupported format)."]);
});

it("folder picks skip dot-directories such as .obsidian/ silently, even when the chosen root itself is hidden", async () => {
	const paths: string[] = [];
	const queue = createNotesImportQueue(async ([f]) => { const path = f!.webkitRelativePath || f!.name; paths.push(path); return [success(path)]; });
	queue.append([file("app.json", "Vault/.obsidian/app.json"), file("old.md", "Vault/.trash/old.md"), file("notes.md", "Vault/Sub/notes.md")]);
	queue.append([file("a.md", ".notes/a.md")]);
	await tick();
	assert.deepEqual(paths, ["Vault/Sub/notes.md", ".notes/a.md"]);
	assert.deepEqual(queue.getSnapshot().errors, []);
});

it("synchronous transport failures settle one wave once without reentrant pump recursion", async () => {
	let calls = 0;
	const queue = createNotesImportQueue(() => { calls++; throw new Error("transport failure"); });
	queue.append([file("a.md"), file("b.md"), file("c.md"), file("d.md")]);
	await tick();
	assert.equal(calls, 4); assert.equal(queue.getSnapshot().completion, 1); assert.equal(queue.getSnapshot().importing, false);
	assert.equal(queue.getSnapshot().errors.length, 4);
});

const QUOTA_MESSAGE = "Daily free model quota exhausted. Wait for reset or configure another model/provider.";
const quotaResult = (name: string): NotesImportResult => ({ requestIndex: 0, filePath: name, ok: false, outcome: "failed", error: QUOTA_MESSAGE, code: "quota_exhausted" });
const failureResult = (name: string, error: string, code?: string): NotesImportResult => ({ requestIndex: 0, filePath: name, ok: false, outcome: "failed", error, ...(code ? { code } : {}) });

it("confirmed quota_exhausted stops dispatch, lets in-flight settle, drains pending as unattempted, completes, and a fresh selection works", async () => {
	const calls: { file: File; resolve: (rows: NotesImportResult[]) => void; reject: (error: Error) => void }[] = [];
	const queue = createNotesImportQueue(async (files) => new Promise((resolve, reject) => { assert.equal(files.length, 1); calls.push({ file: files[0]!, resolve, reject }); }));
	queue.append([file("a.md"), file("quota.md"), file("b.md"), file("c.md"), file("d.md")]);
	assert.equal(calls.length, 3, "three-wide dispatch");
	calls[1]!.resolve([quotaResult("quota.md")]); await tick();
	assert.equal(calls.length, 3, "no new dispatch after confirmed quota exhaustion");
	assert.equal(queue.getSnapshot().importing, true, "in-flight a.md/b.md still settle honestly");
	calls[0]!.resolve([success("a.md")]); calls[2]!.resolve([success("b.md")]); await tick();
	assert.equal(queue.getSnapshot().importing, false, "drained pending lets the cycle complete");
	assert.equal(queue.getSnapshot().completion, 1);
	assert.deepEqual(queue.getSnapshot().errors, [
		`quota.md: ${QUOTA_MESSAGE}\nquota_exhausted`,
		"c.md: Not attempted (daily quota exhausted).",
		"d.md: Not attempted (daily quota exhausted).",
	], "unattempted files are reported distinctly from the attempted quota failure");
	queue.append([file("f.md")]);
	assert.equal(calls.length, 4, "a fresh selection dispatches again");
	calls[3]!.resolve([success("f.md")]); await tick();
	assert.equal(queue.getSnapshot().importing, false);
	assert.equal(queue.getSnapshot().completion, 2);
	assert.deepEqual(queue.getSnapshot().errors, [], "fresh selection clears the drained cycle's errors");
});

it("a selection appended while quota-stopped work is still settling is drained as unattempted, never dispatched", async () => {
	const calls: { file: File; resolve: (rows: NotesImportResult[]) => void }[] = [];
	const queue = createNotesImportQueue(async (files) => new Promise((resolve) => { calls.push({ file: files[0]!, resolve }); }));
	queue.append([file("a.md"), file("q.md"), file("b.md"), file("c.md")]);
	assert.equal(calls.length, 3);
	calls[1]!.resolve([quotaResult("q.md")]); await tick();
	queue.append([file("late.md")]);
	assert.equal(calls.length, 3, "late.md is not dispatched after quota exhaustion");
	await tick();
	calls[0]!.resolve([success("a.md")]); calls[2]!.resolve([success("b.md")]); await tick();
	assert.equal(queue.getSnapshot().importing, false);
	assert.equal(queue.getSnapshot().completion, 1);
	assert.deepEqual(queue.getSnapshot().errors, [
		`q.md: ${QUOTA_MESSAGE}\nquota_exhausted`,
		"c.md: Not attempted (daily quota exhausted).",
		"late.md: Not attempted (daily quota exhausted).",
	]);
});

it("non-quota failures (provider_key_missing, raw quota-like text without the code) never halt dispatch", async () => {
	const calls: { file: File; resolve: (rows: NotesImportResult[]) => void }[] = [];
	const queue = createNotesImportQueue(async (files) => new Promise((resolve) => { calls.push({ file: files[0]!, resolve }); }));
	queue.append([file("a.md"), file("b.md"), file("c.md"), file("d.md"), file("e.md")]);
	assert.equal(calls.length, 3);
	calls[0]!.resolve([failureResult("a.md", "No OpenRouter key is set — add one in Settings → Keys", "provider_key_missing")]); await tick();
	assert.equal(calls.length, 4, "key refusal refills the pool");
	calls[1]!.resolve([failureResult("b.md", "500: upstream rate_limit [429]: Rate limit exceeded: free-models-per-day", "provider_key_missing")]); await tick();
	assert.equal(calls.length, 5, "raw quota-like text without code=quota_exhausted does NOT stop the queue");
	for (const call of calls.slice(2)) call.resolve([success(call.file.name)]);
	await tick();
	assert.equal(queue.getSnapshot().importing, false);
	assert.equal(queue.getSnapshot().completion, 1);
	assert.equal(queue.getSnapshot().errors.length, 2);
});

it("explicit unsupported picks are errors, folder unsupported files get one concise summary, unsafe/oversized stay distinct errors", async () => {
	const paths: string[] = [];
	const queue = createNotesImportQueue(async ([f]) => { const path = f!.webkitRelativePath || f!.name; paths.push(path); return [success(path)]; });
	const big = new File([new Uint8Array(MAX_IMPORT_BYTES + 1)], "big.md");
	queue.append([
		file("a.png"),
		file("x.png", "Root/x.png"),
		file("y.jpg", "Root/Sub/y.jpg"),
		file("evil.png", "Root/../evil.png"),
		file("bad.txt", "../bad.txt"),
		big,
		file("ok.md", "Root/ok.md"),
	]);
	await tick();
	assert.deepEqual(paths, ["Root/ok.md"], "only the eligible sibling is sent");
	assert.deepEqual(queue.getSnapshot().errors, [
		"a.png: Unsupported format.",
		"Root/../evil.png: Unsafe relative path.",
		"../bad.txt: Unsafe relative path.",
		"big.md: Too big. Max 25 MB.",
	], "unsafe paths stay explicit errors even for unsupported files, with wording distinct from format/size");
	assert.deepEqual(queue.getSnapshot().notices, ["2 files skipped (unsupported format)."], "ONE concise summary, no filename wall");
});

it("a folder summary notice reserves its own index and never collides with a later appended file's notice", async () => {
	const pending: ((results: NotesImportResult[]) => void)[] = [];
	const queue = createNotesImportQueue(async () => new Promise((resolve) => pending.push(resolve)));
	queue.append([file("skip.png", "R/skip.png"), file("a.pdf", "R/a.pdf")]);
	queue.append([file("b.pdf")]);
	assert.equal(pending.length, 2);
	pending[0]!([{ ...success("R/a.pdf"), notice: "Scanned pages may have errors." }]);
	pending[1]!([{ ...success("b.pdf"), notice: "Scanned pages may have errors." }]);
	await tick();
	assert.deepEqual(queue.getSnapshot().notices, [
		"R/a.pdf: Scanned pages may have errors.",
		"1 file skipped (unsupported format).",
		"b.pdf: Scanned pages may have errors.",
	], "summary and per-file notices coexist without overwrite");
});
