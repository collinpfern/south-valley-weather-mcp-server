/** Read-only station diagnostics. All timestamps and durations are Unix seconds. */
export type Station = { station_id: number; station_name: string; [key: string]: unknown };
export type CollectionState = {
	station_id: number;
	last_successful_ts: number | null;
	last_attempt_ts: number | null;
	last_status: string | null;
};
export type HealthOptions = {
	lookback_hours: number;
	collection_interval_seconds: number;
	grace_seconds: number;
	interval_overrides: Record<string, number>;
};
export const defaultHealthOptions: HealthOptions = {
	lookback_hours: 24,
	collection_interval_seconds: 3600,
	grace_seconds: 300,
	interval_overrides: {},
};

function positive(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function assessStation(
	station: Station,
	state: CollectionState | undefined,
	timestamps: number[],
	latest: number | null,
	now: number,
	options: HealthOptions,
	truncated = false,
) {
	const start = now - options.lookback_hours * 3600;
	const diagnostics: string[] = [];
	const samples = [
		...new Set(timestamps.filter((t) => Number.isInteger(t) && t >= 0 && t <= now)),
	].sort((a, b) => a - b);
	const frequencies = new Map<number, number>();
	for (let i = 1; i < samples.length; i++) {
		const delta = samples[i] - samples[i - 1];
		frequencies.set(delta, (frequencies.get(delta) ?? 0) + 1);
	}
	const ranked = [...frequencies].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
	const total = samples.length - 1;
	// Sparse/outage-dominated histories cannot establish the station's native cadence.
	const inferred =
		ranked.length && ranked[0][1] >= 3 && ranked[0][1] / total >= 0.6 ? ranked[0][0] : null;
	const configured =
		options.interval_overrides[String(station.station_id)] ??
		station.reporting_interval_seconds;
	const davis = station.station_id === 155474 || station.station_id === 199778;
	const interval = positive(configured) ? configured : davis ? 900 : inferred;
	const intervalSource = positive(configured)
		? "configured"
		: davis
			? "known_davis_archive"
			: inferred
				? "observed_mode"
				: "unknown";
	const allowance = options.collection_interval_seconds + options.grace_seconds;
	const age = latest === null ? null : now - latest;
	const future = latest !== null && latest > now;
	if (future) diagnostics.push("future_observation_timestamp");
	if (!interval) diagnostics.push("reporting_interval_unknown");
	if (truncated) diagnostics.push("observation_scan_truncated");
	if (!state) diagnostics.push("collection_state_missing");
	const watermarkDelta =
		latest !== null && state?.last_successful_ts != null
			? state.last_successful_ts - latest
			: null;
	if (watermarkDelta !== null && watermarkDelta !== 0)
		diagnostics.push(
			watermarkDelta > 0
				? "collection_watermark_ahead_of_observations"
				: "collection_watermark_behind_observations",
		);
	const attemptAge = state?.last_attempt_ts != null ? now - state.last_attempt_ts : null;
	if (attemptAge !== null && attemptAge < 0)
		diagnostics.push("future_collection_attempt_timestamp");
	if (state?.last_successful_ts != null && state.last_successful_ts > now)
		diagnostics.push("future_collection_watermark");
	if (attemptAge !== null && attemptAge > allowance)
		diagnostics.push("collection_attempt_overdue");
	if (state?.last_status && state.last_status !== "success")
		diagnostics.push("collection_attempt_failed");
	if (state && state.last_attempt_ts === null) diagnostics.push("collection_attempt_missing");
	if (state && state.last_successful_ts === null)
		diagnostics.push("collection_watermark_missing");
	if (state && !state.last_status) diagnostics.push("collection_status_unknown");

	const gaps: { start_ts: number; end_ts: number; missing_intervals: number; kind: string }[] =
		[];
	let expected: number | null = null;
	let missing: number | null = null;
	let received: number | null = null;
	// Anchor slots to native observation phase, not wall-clock quarters. The newest
	// hourly batch is pending until collection interval + grace have elapsed.
	const anchor = samples[0];
	const dueEnd = now - allowance;
	if (interval && anchor !== undefined && !truncated && !future) {
		const first = anchor + Math.ceil((start - anchor) / interval) * interval;
		const last = anchor + Math.floor((dueEnd - anchor) / interval) * interval;
		expected = Math.max(0, Math.floor((last - first) / interval) + 1);
		const occupied = new Set<number>();
		for (const ts of samples) {
			const slot = Math.round((ts - first) / interval);
			if (
				slot >= 0 &&
				slot < expected &&
				Math.abs(ts - (first + slot * interval)) <= Math.min(60, interval * 0.1)
			)
				occupied.add(slot);
			else if (ts >= first && ts <= last) diagnostics.push("off_cadence_observation");
		}
		received = occupied.size;
		missing = expected - received;
		let open: number | null = null;
		for (let slot = 0; slot <= expected; slot++) {
			if (slot < expected && !occupied.has(slot)) {
				if (open === null) open = slot;
			} else if (open !== null) {
				const end = first + (slot - 1) * interval;
				gaps.push({
					start_ts: first + open * interval,
					end_ts: end,
					missing_intervals: slot - open,
					kind: end < (latest ?? 0) ? "historical" : "trailing",
				});
				open = null;
			}
		}
	}
	if (expected === null || expected === 0) diagnostics.push("completeness_not_evaluable");
	if (missing && missing > 0) diagnostics.push("missing_observation_intervals");
	const freshness =
		latest === null
			? "missing"
			: future
				? "invalid"
				: interval === null
					? "unknown"
					: age! > interval + allowance
						? "stale"
						: "active";
	const uniqueDiagnostics = [...new Set(diagnostics)];
	const health =
		freshness !== "active" ? freshness : uniqueDiagnostics.length ? "degraded" : "healthy";
	return {
		station_id: station.station_id,
		station_name: station.station_name,
		source: davis
			? "davis_weatherlink"
			: station.station_id >= 900000000
				? "probeschedule"
				: "unknown",
		health,
		freshness,
		latest_observation_ts: latest,
		observation_age_seconds: age,
		reporting_interval_seconds: interval,
		reporting_interval_source: intervalSource,
		stale_after_seconds: interval ? interval + allowance : null,
		collection_state: state ?? null,
		collection_attempt_age_seconds: attemptAge,
		collection_watermark_delta_seconds: watermarkDelta,
		completeness: {
			window_start_ts: start,
			due_through_ts: dueEnd,
			expected_intervals: expected,
			received_intervals: received,
			missing_intervals: missing,
			percent: expected ? Number(((received! / expected) * 100).toFixed(2)) : null,
			evaluable: expected !== null && expected > 0,
			scan_truncated: truncated,
			gaps,
		},
		diagnostics: uniqueDiagnostics,
		suitable_for_current_reporting: health === "healthy",
	};
}

export async function getStationHealth(
	db: D1Database,
	options: HealthOptions = defaultHealthOptions,
	stationName?: string,
	now = Math.floor(Date.now() / 1000),
) {
	const stationResult = await db
		.prepare(
			"SELECT * FROM stations WHERE (? IS NULL OR station_name = ?) ORDER BY station_name",
		)
		.bind(stationName ?? null, stationName ?? null)
		.all<Station>();
	if (stationName && !stationResult.results.length)
		throw new Error(`Unknown station: ${stationName}`);
	const stateResult = await db
		.prepare(
			"SELECT station_id, last_successful_ts, last_attempt_ts, last_status FROM collection_state",
		)
		.all<CollectionState>();
	const states = new Map(stateResult.results.map((s) => [s.station_id, s]));
	const stations = [];
	for (const station of stationResult.results) {
		const bounds = await db
			.prepare(
				"SELECT MAX(observation_ts) AS latest_ts FROM observations_15min WHERE station_id = ?",
			)
			.bind(station.station_id)
			.first<{ latest_ts: number | null }>();
		const start = now - options.lookback_hours * 3600;
		// Include the predecessor to detect gaps at the left boundary, even when the
		// latest observation is older than the requested window. Never silently cap.
		const rows = await db
			.prepare(`SELECT DISTINCT observation_ts FROM observations_15min
   WHERE station_id = ? AND observation_ts <= ? AND (observation_ts >= ? OR observation_ts =
    (SELECT MAX(observation_ts) FROM observations_15min WHERE station_id = ? AND observation_ts < ?))
   ORDER BY observation_ts LIMIT 10001`)
			.bind(station.station_id, now, start, station.station_id, start)
			.all<{ observation_ts: number }>();
		stations.push(
			assessStation(
				station,
				states.get(station.station_id),
				rows.results.map((r) => r.observation_ts),
				bounds?.latest_ts ?? null,
				now,
				options,
				rows.results.length > 10000,
			),
		);
	}
	return {
		evaluated_at_ts: now,
		timezone: "America/Los_Angeles",
		policy: options,
		station_count: stations.length,
		stations,
		limitations: [
			"Collection state is a watermark and last attempt, not a collection-run history. Gaps identify absent observations, not their cause.",
			"Timestamp completeness does not validate individual sensor values. Unknown cadence requires an interval override; inferred cadence may reflect upstream downsampling.",
		],
	};
}
