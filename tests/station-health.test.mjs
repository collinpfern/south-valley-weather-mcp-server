import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
	assessStation,
	getStationHealth,
	defaultHealthOptions as defaults,
} from "../src/station-health.ts";
const now = 1791903600;
const station = { station_id: 155474, station_name: "Ranch 27" };
const state = {
	station_id: 155474,
	last_successful_ts: now,
	last_attempt_ts: now,
	last_status: "success",
};
const times = (interval = 900) =>
	Array.from({ length: 86400 / interval + 1 }, (_, i) => now - 86400 + i * interval);
const assess = (ts = times(), latest = now, cs = state, s = station, opts = defaults) =>
	assessStation(s, cs, ts, latest, now, opts);

test("healthy Davis: hourly collector does not imply hourly observation cadence", () => {
	const h = assess(
		times().filter((t) => t <= now - 2700),
		now - 2700,
		{ ...state, last_successful_ts: now - 2700, last_attempt_ts: now - 2700 },
	);
	assert.equal(h.health, "healthy");
	assert.equal(h.completeness.missing_intervals, 0);
	assert.equal(h.reporting_interval_seconds, 900);
});
test("stale cutoff includes collection schedule and grace, boundary is inclusive", () => {
	assert.equal(
		assess([], now - 4800, { ...state, last_successful_ts: now - 4800 }).freshness,
		"active",
	);
	assert.equal(
		assess([], now - 4801, { ...state, last_successful_ts: now - 4801 }).freshness,
		"stale",
	);
});
test("hourly ProbeSchedule cadence inferred without manufacturing quarter-hour gaps", () => {
	const h = assess(times(3600), now, state, {
		station_id: 900006397,
		station_name: "Almonds Temp",
	});
	assert.equal(h.health, "healthy");
	assert.equal(h.reporting_interval_seconds, 3600);
	assert.equal(h.completeness.expected_intervals, 23);
});
test("current observations remain degraded after an interruption with unfilled gaps", () => {
	const h = assess(times().filter((t) => t < now - 18000 || t > now - 14400));
	assert.equal(h.freshness, "active");
	assert.equal(h.health, "degraded");
	assert.equal(h.completeness.missing_intervals, 5);
	assert.equal(h.completeness.gaps[0].kind, "historical");
	assert.equal(h.suitable_for_current_reporting, false);
	assert.equal(assess().health, "healthy");
});
test("missing stations, unknown cadence, explicit overrides, and duplicates", () => {
	assert.equal(assess([], null, undefined).health, "missing");
	const probe = { station_id: 900009504, station_name: "R8 Air Temp" };
	assert.equal(assess([now - 864000], now - 864000, state, probe).freshness, "unknown");
	const h = assess([now - 864000], now - 864000, state, probe, {
		...defaults,
		interval_overrides: { 900009504: 3600 },
	});
	assert.equal(h.freshness, "stale");
	assert.equal(h.completeness.percent, 0);
	assert.equal(assess([...times(), ...times()]).completeness.missing_intervals, 0);
});
test("failed attempt, old attempt and both watermark directions are separate diagnostics", () => {
	const h = assess(times(), now, {
		...state,
		last_attempt_ts: now - 7200,
		last_status: "error: WeatherLink HTTP 400",
		last_successful_ts: now - 900,
	});
	assert.equal(h.freshness, "active");
	assert.equal(h.health, "degraded");
	assert.ok(h.diagnostics.includes("collection_attempt_failed"));
	assert.ok(h.diagnostics.includes("collection_attempt_overdue"));
	assert.ok(h.diagnostics.includes("collection_watermark_behind_observations"));
	assert.ok(
		assess(times(), now, { ...state, last_successful_ts: now + 900 }).diagnostics.includes(
			"collection_watermark_ahead_of_observations",
		),
	);
});
test("future observations cannot be healthy, missing collection state cannot be healthy", () => {
	assert.equal(assess(times(), now + 60).health, "invalid");
	assert.equal(assessStation(station, undefined, times(), now, now, defaults).health, "degraded");
});
test("pending tail is excluded; mature trailing and leading holes are reported", () => {
	const h = assess(
		times().filter((t) => t >= now - 82800 && t <= now - 10800),
		now - 10800,
		{ ...state, last_successful_ts: now - 10800 },
	);
	assert.equal(h.completeness.gaps.length, 2);
	assert.equal(h.completeness.gaps[0].missing_intervals, 4);
	assert.equal(h.completeness.gaps[1].kind, "trailing");
});
test("sparse outage-dominated cadence and truncated scans do not claim completeness", () => {
	const h = assess([now - 86400, now - 82800, now], now, state, {
		station_id: 900006397,
		station_name: "Probe",
	});
	assert.equal(h.reporting_interval_seconds, null);
	assert.equal(h.completeness.evaluable, false);
	const truncated = assessStation(station, state, times(), now, now, defaults, true);
	assert.equal(truncated.completeness.percent, null);
	assert.equal(truncated.health, "degraded");
});
test("Unix arithmetic works across DST, off-cadence rows do not mask gaps", () => {
	const h = assess(times().map((t) => (t === now - 18000 ? t + 400 : t)));
	assert.equal(h.completeness.missing_intervals, 1);
	assert.ok(h.diagnostics.includes("off_cadence_observation"));
	assert.equal(assess().completeness.expected_intervals, 92);
});
function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`CREATE TABLE stations(station_id INTEGER PRIMARY KEY,station_name TEXT);
 CREATE TABLE observations_15min(station_id INTEGER, observation_ts INTEGER);
 CREATE TABLE collection_state(station_id INTEGER,last_successful_ts INTEGER,last_attempt_ts INTEGER,last_status TEXT);`);
	const db = {
		prepare(sql) {
			let values = [];
			return {
				bind(...args) {
					values = args;
					return this;
				},
				async all() {
					return { results: sqlite.prepare(sql).all(...values) };
				},
				async first() {
					return sqlite.prepare(sql).get(...values) ?? null;
				},
			};
		},
	};
	return { sqlite, db };
}
test("real SQLite queries include never-seen stations, filter names, and include predecessor", async () => {
	const { sqlite, db } = fixture();
	try {
		sqlite.exec(
			`INSERT INTO stations VALUES(155474,'Ranch 27'),(900009504,'R8 Air Temp'),(900009529,'Never seen');`,
		);
		const insert = sqlite.prepare("INSERT INTO observations_15min VALUES(?,?)");
		for (const ts of times()) insert.run(155474, ts);
		insert.run(900009504, now - 864000);
		sqlite
			.prepare("INSERT INTO collection_state VALUES(?,?,?,?)")
			.run(155474, now, now, "success");
		const options = { ...defaults, interval_overrides: { 900009504: 3600 } };
		const result = await getStationHealth(db, options, undefined, now);
		assert.equal(result.station_count, 3);
		assert.equal(
			result.stations.find((s) => s.station_name === "Never seen").health,
			"missing",
		);
		assert.equal(
			result.stations.find((s) => s.station_name === "R8 Air Temp").completeness.percent,
			0,
		);
		const filtered = await getStationHealth(db, options, "Ranch 27", now);
		assert.equal(filtered.station_count, 1);
		assert.equal(filtered.stations[0].health, "healthy");
		await assert.rejects(getStationHealth(db, options, "' OR 1=1 --", now), /Unknown station/);
	} finally {
		sqlite.close();
	}
});
test("database failures propagate rather than returning healthy empty results", async () => {
	const db = {
		prepare() {
			throw new Error("D1 unavailable");
		},
	};
	await assert.rejects(getStationHealth(db), /D1 unavailable/);
});

test("metadata and explicit overrides take priority over inferred cadence", () => {
	const probe = {
		station_id: 900006397,
		station_name: "Probe",
		reporting_interval_seconds: 1800,
	};
	const ts = times(1800);
	assert.equal(assess(ts, now, state, probe).reporting_interval_seconds, 1800);
	assert.equal(
		assess(ts, now, state, probe, { ...defaults, interval_overrides: { 900006397: 3600 } })
			.reporting_interval_seconds,
		3600,
	);
});
test("elapsed completeness stays constant across actual spring and fall DST transitions", () => {
	for (const end of [
		Date.parse("2026-03-09T08:00:00Z") / 1000,
		Date.parse("2026-11-02T08:00:00Z") / 1000,
	]) {
		const ts = Array.from({ length: 97 }, (_, i) => end - 86400 + i * 900);
		const h = assessStation(
			station,
			{ ...state, last_successful_ts: end, last_attempt_ts: end },
			ts,
			end,
			end,
			defaults,
		);
		assert.equal(h.health, "healthy");
		assert.equal(h.completeness.expected_intervals, 92);
	}
});
test("minute timestamp jitter is accepted with configured cadence", () => {
	const ts = times().map((t, i) => (i % 2 ? t + 30 : t));
	const h = assess(ts);
	assert.equal(h.completeness.missing_intervals, 0);
});
