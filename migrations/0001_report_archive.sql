-- Additive migration: existing station and observation tables are untouched.
CREATE TABLE IF NOT EXISTS forecast_report_versions (
    report_date TEXT NOT NULL,
    edition TEXT NOT NULL CHECK (edition IN ('morning', 'afternoon', 'special')),
    revision INTEGER NOT NULL CHECK (revision > 0),
    request_id TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    issued_at TEXT NOT NULL,
    content_markdown TEXT NOT NULL,
    document_url TEXT,
    sop_version TEXT,
    sources_json TEXT NOT NULL DEFAULT '[]',
    content_sha256 TEXT NOT NULL,
    request_sha256 TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (report_date, edition, revision)
);

CREATE INDEX IF NOT EXISTS forecast_reports_by_edition_date
    ON forecast_report_versions (edition, report_date DESC, revision DESC);
