# South Valley Weather MCP server

Authenticated, read-only Cloudflare Worker backed by the South Valley Weather D1 database. Cloudflare Access JWT validation runs before MCP requests are handled.

## Station health

Call `get_station_health` before treating observations as current or using them for forecast verification. It evaluates **every registered station**, including stations with no observations or collection state. Existing observation and collection tools remain compatible.

Example arguments:

```json
{
  "lookback_hours": 24,
  "collection_interval_seconds": 3600,
  "grace_seconds": 300,
  "interval_overrides": { "900009504": 3600 }
}
```

Optional `station_name` is an exact-name filter; an unknown name returns an error. Lookback is 1–168 elapsed hours (Unix seconds, unaffected by DST). Intervals and grace are seconds. Overrides are keyed by numeric station ID as a string and should use the station's **native observation frequency**, rather than the collector schedule.

The tool returns:

- `freshness`: `active`, `stale`, `missing`, `unknown` (cadence cannot be established), or `invalid` (future observation).
- `health`: `healthy`, `degraded`, or the non-active freshness state. Fresh readings with historical holes, collection errors or mismatches are degraded.
- Latest observation timestamp, age, reporting interval and its provenance, stale threshold, raw collection state, collection attempt age, and signed watermark difference (`last_successful_ts - latest_observation_ts`).
- Completeness: due expected slots, received slots, missing count, percentage and contiguous missing ranges with first/last expected timestamps. `historical` gaps precede the newest reading; `trailing` gaps follow it. `null` completeness means it cannot safely be evaluated.
- Machine-readable diagnostic codes and `suitable_for_current_reporting`, which is true only for healthy stations. This flag validates freshness and timestamp coverage; it does not validate sensor accuracy or completeness of individual measurements.

### Cadence and collection semantics

The deployed collection records use `last_successful_ts` as an **observation watermark**, not the wall-clock time of a successful request. `last_attempt_ts` and `last_status` describe the most recent collection attempt. A successful request alone never makes an old observation current.

The current Ranch 27 (155474) and Ranch 33 (199778) Davis archives report every 900 seconds. ProbeSchedule samples observed in the live database report hourly; the `observations_15min` table name does not define their cadence. Resolution precedence is an explicit override, station metadata `reporting_interval_seconds` if present, the two known Davis archive intervals, then the modal positive observation spacing. Inference requires at least three matching spacings and 60% support. Unknown or sparse stations require configuration to assess freshness. The tool exposes inferred provenance: repeated upstream omissions or downsampling can resemble a slower native interval, so use overrides when the configured station frequency is known. Source labels use the existing known Davis IDs and ProbeSchedule's 900000000 station ID namespace; unrecognized IDs are labeled unknown and still assessed.

Hourly collection is the default. Freshness allows one reporting interval plus one collection interval plus five minutes of grace. A quarter-hour Davis reading becomes stale after 80 minutes; an hourly probe after 125 minutes. All thresholds are configurable. Native expected slots are anchored to the observation phase, so hourly probes at `:30` are not forced onto `:00`. Up to 60 seconds (or 10% of the interval, whichever is smaller) of timestamp jitter is accepted. Duplicate timestamps do not increase completeness.

Completeness includes only slots older than the collection interval plus grace; recent readings awaiting the next collection are pending, not missing. The predecessor before the window establishes the left boundary. Without that predecessor, pre-first-observation slots are included as missing; a newly installed station can therefore appear incomplete until a full window has accrued. Stations with no history have unknown completeness. An interruption that is later fully backfilled clears automatically; a resumed but incomplete history remains degraded.

### Limits and operations

This is an on-demand diagnostic tool, not a scheduled alert or a collector. It performs no writes, recovery, or external station API calls. It uses the existing `stations`, `observations_15min`, and `collection_state` schema; no migration is needed. Existing `(station_id, observation_ts)` indexes are recommended for bounded scans. Each station uses one latest-timestamp query and a bounded history query; scans exceeding 10,000 distinct observations explicitly mark completeness unevaluable. Database errors propagate instead of producing healthy empty reports. Reads can race collection writes; transient watermark discrepancies should be rechecked after collection finishes.

Collection state contains no run history. Absent observation intervals do not prove whether a failure happened at the station, upstream provider, or collector. This tool cannot count past failed collection runs, certify hardware operation, or validate temperature, rainfall or other sensor values. Davis ranch/exterior and ProbeSchedule in-field observations remain distinct.

## Development

Use Node.js 24 or later:

```sh
npm ci
npm test
npm run type-check
npx wrangler deploy --dry-run
```

Tests use Node's test runner and real in-memory SQLite query execution, with fixed Unix times. They cover native cadence, collection latency, exact stale thresholds, missing stations, duplicates, historical/trailing/leading gaps, recovery, clock errors, failed attempts, watermark mismatches, sparse history, truncation, filtering, and database failures. GitHub Actions runs tests, type checks and a Worker bundle dry run.

Deploy manually with `npm run deploy` after reviewing the PR. Deployment requires the existing Cloudflare Access and D1 configuration in `wrangler.jsonc`.
