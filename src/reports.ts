import { z } from "zod";

const calendarDate = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/)
	.refine((value) => {
		const date = new Date(`${value}T00:00:00Z`);
		return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
	}, "Use a valid calendar date in YYYY-MM-DD format.");
const edition = z.enum(["morning", "afternoon", "special"]);
const httpsUrl = z
	.string()
	.max(2048)
	.url()
	.refine((value) => {
		const url = new URL(value);
		return url.protocol === "https:" && !url.username && !url.password;
	}, "Use an HTTPS URL without embedded credentials.");

export const saveReportSchema = z.object({
	report_date: calendarDate.describe("Report date in America/Los_Angeles."),
	edition: edition.default("morning"),
	request_id: z
		.string()
		.uuid()
		.describe("New UUID for this save. Reuse the same UUID and arguments when retrying."),
	expected_revision: z
		.number()
		.int()
		.nonnegative()
		.describe(
			"0 for a new report; latest revision from get_report for a correction. Prevents overwriting concurrent work.",
		),
	title: z.string().trim().min(1).max(200),
	issued_at: z.iso
		.datetime({ offset: true })
		.describe(
			"Actual report issue time with UTC or an explicit offset; do not substitute archive time for historical reports.",
		),
	content_markdown: z
		.string()
		.min(1)
		.max(100000)
		.refine((value) => value.trim().length > 0, "Report text cannot be blank.")
		.describe("Complete final report text, including all forecast sections and tables."),
	document_url: httpsUrl
		.optional()
		.describe(
			"Persistent link to the final Word file. File bytes are not copied by this tool.",
		),
	sop_version: z.string().trim().min(1).max(100).optional(),
	sources: z
		.array(httpsUrl)
		.max(50)
		.default([])
		.describe("Source URLs used to prepare this report. Stored as references, never fetched."),
});

export const getReportSchema = z.object({
	report_date: calendarDate,
	edition: edition.default("morning"),
	revision: z
		.number()
		.int()
		.positive()
		.optional()
		.describe("Omit for the latest revision; use 1 for the original issued forecast."),
});

export const listReportsSchema = z.object({
	start_date: calendarDate.optional(),
	end_date: calendarDate.optional(),
	edition: edition.optional(),
	query: z
		.string()
		.trim()
		.min(1)
		.max(200)
		.optional()
		.describe("Literal text to find in the title or report body."),
	include_revisions: z
		.boolean()
		.default(false)
		.describe("By default return only the latest revision of each report."),
	limit: z.number().int().min(1).max(100).default(30),
	offset: z.number().int().nonnegative().default(0),
});

type SaveReport = z.infer<typeof saveReportSchema>;
type ReportRow = {
	report_date: string;
	edition: string;
	revision: number;
	request_id: string;
	title: string;
	issued_at: string;
	content_markdown: string;
	document_url: string | null;
	sop_version: string | null;
	sources_json: string;
	content_sha256: string;
	request_sha256: string;
	created_at: string;
};

const metadataColumns = `r.report_date, r.edition, r.revision, r.title, r.issued_at,
	r.document_url, r.sop_version, r.content_sha256, r.created_at`;

export async function sha256(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
		"",
	);
}

function publicReport(row: ReportRow) {
	const { sources_json, request_sha256: _requestHash, request_id: _requestId, ...report } = row;
	return { ...report, sources: JSON.parse(sources_json) as string[] };
}

export async function saveReport(db: D1Database, input: SaveReport) {
	const data = saveReportSchema.parse(input);
	const contentHash = await sha256(data.content_markdown);
	// Fixed key order from schema parsing gives retries a stable payload fingerprint.
	const requestHash = await sha256(JSON.stringify(data));
	// The revision check and insert are one SQL statement. D1 batch is a transaction,
	// so concurrent corrections cannot silently supersede one another.
	const results = await db.batch([
		db
			.prepare(`INSERT INTO forecast_report_versions (
			report_date, edition, revision, request_id, title, issued_at, content_markdown,
			document_url, sop_version, sources_json, content_sha256, request_sha256
		) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
		WHERE COALESCE((SELECT MAX(revision) FROM forecast_report_versions
			WHERE report_date = ? AND edition = ?), 0) = ?
		ON CONFLICT(request_id) DO NOTHING`)
			.bind(
				data.report_date,
				data.edition,
				data.expected_revision + 1,
				data.request_id,
				data.title,
				data.issued_at,
				data.content_markdown,
				data.document_url ?? null,
				data.sop_version ?? null,
				JSON.stringify(data.sources),
				contentHash,
				requestHash,
				data.report_date,
				data.edition,
				data.expected_revision,
			),
		db
			.prepare(`SELECT * FROM forecast_report_versions WHERE request_id = ?`)
			.bind(data.request_id),
		db
			.prepare(`SELECT COALESCE(MAX(revision), 0) AS revision FROM forecast_report_versions
			WHERE report_date = ? AND edition = ?`)
			.bind(data.report_date, data.edition),
	]);
	const row = results[1].results[0] as ReportRow | undefined;
	if (!row) {
		const current = results[2].results[0] as { revision: number };
		throw new Error(
			`Revision conflict: current revision is ${current.revision}. Retrieve and review the latest report before saving a correction.`,
		);
	}
	if (row.request_sha256 !== requestHash) {
		throw new Error(
			"request_id was already used with different arguments. Retrieve the existing report and use a new UUID for a new save.",
		);
	}
	return {
		saved: true,
		duplicate_request: results[0].meta.changes === 0,
		report_date: row.report_date,
		edition: row.edition,
		revision: row.revision,
		content_sha256: row.content_sha256,
		created_at: row.created_at,
	};
}

export async function getReport(db: D1Database, input: z.infer<typeof getReportSchema>) {
	const data = getReportSchema.parse(input);
	const bindings: (string | number)[] = [data.report_date, data.edition];
	let query = `SELECT * FROM forecast_report_versions WHERE report_date = ? AND edition = ?`;
	if (data.revision !== undefined) {
		query += " AND revision = ?";
		bindings.push(data.revision);
	}
	query += " ORDER BY revision DESC LIMIT 1";
	const row = await db
		.prepare(query)
		.bind(...bindings)
		.first<ReportRow>();
	return {
		found: row !== null,
		timezone: "America/Los_Angeles",
		report: row ? publicReport(row) : null,
	};
}

export async function listReports(db: D1Database, input: z.infer<typeof listReportsSchema>) {
	const data = listReportsSchema.parse(input);
	if (data.start_date && data.end_date && data.end_date < data.start_date) {
		throw new Error("end_date must be greater than or equal to start_date.");
	}
	const where: string[] = [];
	const bindings: (string | number)[] = [];
	if (!data.include_revisions) {
		where.push(`r.revision = (SELECT MAX(v.revision) FROM forecast_report_versions v
			WHERE v.report_date = r.report_date AND v.edition = r.edition)`);
	}
	if (data.start_date) {
		where.push("r.report_date >= ?");
		bindings.push(data.start_date);
	}
	if (data.end_date) {
		where.push("r.report_date <= ?");
		bindings.push(data.end_date);
	}
	if (data.edition) {
		where.push("r.edition = ?");
		bindings.push(data.edition);
	}
	if (data.query) {
		where.push(
			"(instr(lower(r.title), lower(?)) > 0 OR instr(lower(r.content_markdown), lower(?)) > 0)",
		);
		bindings.push(data.query, data.query);
	}
	const result = await db
		.prepare(`SELECT ${metadataColumns} FROM forecast_report_versions r
		${where.length ? `WHERE ${where.join(" AND ")}` : ""}
		ORDER BY r.report_date DESC, r.edition ASC, r.revision DESC LIMIT ? OFFSET ?`)
		.bind(...bindings, data.limit + 1, data.offset)
		.all();
	const hasMore = result.results.length > data.limit;
	const reports = result.results.slice(0, data.limit);
	return {
		timezone: "America/Los_Angeles",
		reports,
		count: reports.length,
		has_more: hasMore,
		next_offset: hasMore ? data.offset + reports.length : null,
	};
}
