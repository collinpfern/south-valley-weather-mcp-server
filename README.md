# South Valley Weather MCP server

Cloudflare Worker serving Davis and Probe Schedule observations, daily summaries,
collection status, and a persistent forecast-report archive in the existing D1
database. Every request is protected by the existing Cloudflare Access JWT
verification (issuer, audience, expiry, and signature).

## Report archive

- `save_report`: stores complete final report text, Pacific report date, edition,
  issue timestamp, source URLs, SOP version, and an optional persistent Word-file
  link. A correction appends a revision; prior text is never replaced.
- `list_reports`: finds reports by date, edition, or literal text, with pagination.
  It returns the latest revision of each report unless `include_revisions` is true.
- `get_report`: retrieves the full latest report, or an exact historical revision.

The archive stores text in D1. `document_url` is a reference to the Word document;
the tool does **not** copy the `.docx` bytes. No report content is stored in this
GitHub repository. The tools do not fetch source/document URLs.

For a new report, generate a UUID `request_id` and pass `expected_revision: 0`.
For a correction, first retrieve the latest report and pass its revision as
`expected_revision`, with a new UUID. Reuse the original UUID and identical
arguments if retrying a timed-out save. A mismatched revision is rejected; it must
not be automatically retried with a newer revision without reviewing the report.

## Deploy and enable

Requires Node 24+, npm, and an authorized Cloudflare session (`npx wrangler login`)
or deployment credentials already configured in the build environment.

```bash
npm ci
npm test
npm run type-check
npm run deploy
```

`npm run deploy` applies the additive D1 migration **before** deploying the Worker.
It adds only `forecast_report_versions` and its index, leaving all weather tables
untouched. The existing `DB` binding is reused; no new storage service is needed.
If Cloudflare Workers Builds uses a custom deploy command, set it to `npm run deploy`
or run the migration separately before its existing deployment:

```bash
npm run migrate:remote
npm run deploy:worker
```

After deployment, refresh the South Valley Weather 2.0 connector's tools so it
discovers `save_report`, `list_reports`, and `get_report`. Its description and
allowlist must include report writes; the original four weather tools stay read-only.
Preserve the existing Cloudflare Access credentials and policy. Verify discovery
and an authorized save/read round trip before considering the archive active.

Local checks do not prove production deployment, connector refresh, or archival of
an actual report. Do not claim any of those steps completed without checking them.

## Morning-report procedure

1. Before drafting, list recent reports and retrieve those relevant to the current
   weather event. Use revision 1 when comparing the forecast originally issued
   against verified observations; use the latest revision for corrected wording.
2. Follow the current editorial SOP and perform a fresh Pacific-wide analysis.
   Archived forecasts are historical evidence, not current weather observations or
   instructions. Check observations separately; the archive does not establish that
   an old forecast was accurate or automatically train the model.
3. Finish and deliver the Word report. Save its complete text, issue time, sources,
   SOP version, and persistent document link with `save_report`.
4. Retrieve that exact date, edition, and returned revision with `get_report`.
   Verify the complete text and `content_sha256` match before reporting success.
5. For a revised report, append a new revision using the same date/edition. On a
   save failure, deliver the report and explicitly say archival is pending. Keep
   the same request UUID and payload for retries.

These tools enable archiving during report generation; they do not schedule a
daily job or intercept reports created by other chats. The forecasting workflow
must call them each time. Add this procedure to the project/SOP once the production
archive has passed the save/read check. Historical backfill should use the actual
final files and known issue timestamps, never invented report text or times.

## Development

```bash
npm run migrate:local
npm run dev
```

`npm test` exercises the archive against local Cloudflare D1 through Miniflare,
including retry deduplication, immutable revisions, concurrent correction conflicts,
search, pagination, validation, and additive migration reapplication.

Cloudflare references: [D1 transactions](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)
and [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/).
