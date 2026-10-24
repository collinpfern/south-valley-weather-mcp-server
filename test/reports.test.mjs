import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { saveReport, getReport, listReports, saveReportSchema, sha256 } from "../src/reports.ts";

let mf;
let db;
const migration = await readFile(
	new URL("../migrations/0001_report_archive.sql", import.meta.url),
	"utf8",
);

function input(overrides = {}) {
	return saveReportSchema.parse({
		report_date: "2026-10-24",
		request_id: randomUUID(),
		expected_revision: 0,
		title: "South Valley Morning Report",
		issued_at: "2026-10-24T07:00:00-07:00",
		content_markdown: "# Summary\nDry today.\n\n| Day | High |\n|---|---|\n| Saturday | 74°F |",
		document_url: "https://example.com/report.docx",
		sop_version: "0.3",
		sources: ["https://www.weather.gov/hnx/"],
		...overrides,
	});
}

before(async () => {
	mf = new Miniflare(convertV4MiniflareOptions({
		modules: true,
		script: "export default { fetch() { return new Response('test'); } }",
		d1Databases: ["DB"],
		compatibilityDate: "2026-07-02",
	}));
	db = await mf.getD1Database("DB");
	for (const statement of migration.split(";").filter((sql) => sql.trim()))
		await db.prepare(statement).run();
});
after(async () => {
	await mf?.dispose();
});

test("D1 saves complete text and metadata, and retrieves it after retry", async () => {
	const report = input();
	const saved = await saveReport(db, report);
	assert.equal(saved.revision, 1);
	assert.equal(saved.duplicate_request, false);
	assert.equal(saved.content_sha256, await sha256(report.content_markdown));
	assert.equal((await saveReport(db, report)).duplicate_request, true);
	const found = await getReport(db, { report_date: report.report_date, edition: "morning" });
	assert.equal(found.found, true);
	assert.equal(found.report.content_markdown, report.content_markdown);
	assert.deepEqual(found.report.sources, report.sources);
	assert.equal(found.report.document_url, report.document_url);
	assert.equal(found.report.request_sha256, undefined);
	assert.equal(found.report.request_id, undefined);
	await assert.rejects(
		saveReport(db, { ...report, content_markdown: "Changed" }),
		/already used/,
	);
});

test("corrections preserve originals, reject stale writes, and support delayed retries", async () => {
	const first = input({ report_date: "2026-10-23" });
	await saveReport(db, first);
	await saveReport(db, {
		...first,
		request_id: randomUUID(),
		expected_revision: 1,
		content_markdown: "Corrected forecast",
	});
	assert.equal(
		(await getReport(db, { report_date: first.report_date, edition: "morning" })).report
			.revision,
		2,
	);
	assert.equal(
		(await getReport(db, { report_date: first.report_date, edition: "morning", revision: 1 }))
			.report.content_markdown,
		first.content_markdown,
	);
	await assert.rejects(
		saveReport(db, { ...first, request_id: randomUUID() }),
		/Revision conflict/,
	);
	const retry = await saveReport(db, first);
	assert.equal(retry.revision, 1);
	assert.equal(retry.duplicate_request, true);
	await assert.rejects(saveReport(db, { ...first, report_date: "2026-10-25" }), /already used/);
	assert.equal(
		(await getReport(db, { report_date: "2026-10-25", edition: "morning" })).found,
		false,
	);
});

test("concurrent corrections allow exactly one new revision", async () => {
	const first = input({ report_date: "2026-10-22" });
	await saveReport(db, first);
	const results = await Promise.allSettled(
		["A", "B"].map((text) =>
			saveReport(db, {
				...first,
				request_id: randomUUID(),
				expected_revision: 1,
				content_markdown: text,
			}),
		),
	);
	assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
	assert.equal(results.filter((r) => r.status === "rejected").length, 1);
	assert.equal(
		(await getReport(db, { report_date: first.report_date, edition: "morning" })).report
			.revision,
		2,
	);
});

test("lists newest revisions, supports date/search filters, and paginates without full bodies", async () => {
	const filter = {
		start_date: "2026-10-22",
		end_date: "2026-10-24",
		edition: "morning",
		include_revisions: false,
		limit: 2,
		offset: 0,
	};
	const firstPage = await listReports(db, filter);
	assert.deepEqual(
		firstPage.reports.map((r) => r.report_date),
		["2026-10-24", "2026-10-23"],
	);
	assert.equal(firstPage.reports[0].content_markdown, undefined);
	assert.equal(firstPage.has_more, true);
	assert.equal(firstPage.next_offset, 2);
	const lastPage = await listReports(db, { ...filter, offset: firstPage.next_offset });
	assert.deepEqual(
		lastPage.reports.map((r) => r.report_date),
		["2026-10-22"],
	);
	assert.equal(lastPage.has_more, false);
	assert.equal((await listReports(db, { ...filter, query: "CORRECTED" })).count, 1);
	assert.equal((await listReports(db, { ...filter, query: "%' OR 1=1 --" })).count, 0);
	const history = await listReports(db, {
		...filter,
		start_date: "2026-10-23",
		end_date: "2026-10-23",
		include_revisions: true,
	});
	assert.deepEqual(
		history.reports.map((r) => r.revision),
		[2, 1],
	);
	await assert.rejects(listReports(db, { ...filter, end_date: "2026-10-01" }), /end_date/);
});

test("editions are independent and missing reports return found=false", async () => {
	await saveReport(db, input({ edition: "afternoon" }));
	assert.equal(
		(await getReport(db, { report_date: "2026-10-24", edition: "afternoon" })).report.revision,
		1,
	);
	assert.equal(
		(await getReport(db, { report_date: "2026-10-01", edition: "morning" })).found,
		false,
	);
	assert.equal(
		(await getReport(db, { report_date: "2026-10-24", edition: "morning", revision: 999 }))
			.found,
		false,
	);
});

test("rejects invalid dates, unsafe links, blank/oversized text, and fractional revisions", () => {
	for (const invalid of [
		{ report_date: "2026-02-30" },
		{ report_date: "2026-13-01" },
		{ document_url: "javascript:alert(1)" },
		{ document_url: "https://user:secret@example.com" },
		{ content_markdown: "  \n" },
		{ content_markdown: "x".repeat(100001) },
		{ expected_revision: 0.5 },
		{ issued_at: "2026-10-24T07:00:00" },
	])
		assert.throws(() => input(invalid));
	assert.equal(input({ report_date: "2028-02-29" }).report_date, "2028-02-29");
});

test("migration can be reapplied without deleting archived data", async () => {
	for (const statement of migration.split(";").filter((sql) => sql.trim()))
		await db.prepare(statement).run();
	assert.equal(
		(await getReport(db, { report_date: "2026-10-24", edition: "morning" })).found,
		true,
	);
});
