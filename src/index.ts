import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

type WeatherEnv = {
	DB: D1Database;
};

type ObservationRow = {
	station_name: string;
	observation_ts: number;
	temperature_f: number | null;
	temp_high_interval_f: number | null;
	temp_low_interval_f: number | null;
	humidity_pct: number | null;
	dew_point_f: number | null;
	wet_bulb_f: number | null;
	wind_speed_mph: number | null;
	wind_direction_deg: number | null;
	wind_max_interval_mph: number | null;
	rain_rate_in_hr: number | null;
	rain_interval_in: number | null;
	rain_1hr_in: number | null;
	rain_24hr_in: number | null;
	rain_today_in: number | null;
	solar_radiation_wm2: number | null;
	solar_max_interval_wm2: number | null;
	pressure_inhg: number | null;
	et_interval_in: number | null;
};

function unixToPacific(ts: number): string {
	return new Intl.DateTimeFormat("en-US", {
		timeZone: "America/Los_Angeles",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
		timeZoneName: "short",
	}).format(new Date(ts * 1000));
}

function createServer(env: WeatherEnv) {
	const server = new McpServer({
		name: "South Valley Weather",
		version: "1.0.0",
	});

	server.registerTool(
		"get_latest_observations",
		{
			description:
				"Get the newest stored Davis weather observation for every South Valley weather station.",
			inputSchema: z.object({}),
		},
		async () => {
			const result = await env.DB.prepare(`
				SELECT
					s.station_name,
					o.observation_ts,
					o.temperature_f,
					o.temp_high_interval_f,
					o.temp_low_interval_f,
					o.humidity_pct,
					o.dew_point_f,
					o.wet_bulb_f,
					o.wind_speed_mph,
					o.wind_direction_deg,
					o.wind_max_interval_mph,
					o.rain_rate_in_hr,
					o.rain_interval_in,
					o.rain_1hr_in,
					o.rain_24hr_in,
					o.rain_today_in,
					o.solar_radiation_wm2,
					o.solar_max_interval_wm2,
					o.pressure_inhg,
					o.et_interval_in
				FROM observations_15min o
				JOIN stations s
					ON s.station_id = o.station_id
				INNER JOIN (
					SELECT station_id, MAX(observation_ts) AS newest_ts
					FROM observations_15min
					GROUP BY station_id
				) latest
					ON latest.station_id = o.station_id
					AND latest.newest_ts = o.observation_ts
				ORDER BY s.station_name
			`).all<ObservationRow>();

			const observations = result.results.map((row) => ({
				...row,
				local_time: unixToPacific(row.observation_ts),
			}));

			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(
							{
								timezone: "America/Los_Angeles",
								observation_count: observations.length,
								observations,
							},
							null,
							2,
						),
					},
				],
			};
		},
	);

	server.registerTool(
		"get_observations",
		{
			description:
				"Get stored 15-minute Davis weather observations for the requested number of recent hours. Use this for overnight trends, temperature/dew-point analysis, wind, rain, solar radiation, and forecast verification.",
			inputSchema: z.object({
				hours: z
					.number()
					.int()
					.min(1)
					.max(24)
					.default(24)
					.describe("Number of recent hours to retrieve, from 1 through 24."),
			}),
		},
		async ({ hours }) => {
			const now = Math.floor(Date.now() / 1000);
			const startTs = now - hours * 3600;

			const result = await env.DB.prepare(`
				SELECT
					s.station_name,
					o.observation_ts,
					o.temperature_f,
					o.temp_high_interval_f,
					o.temp_low_interval_f,
					o.humidity_pct,
					o.dew_point_f,
					o.wet_bulb_f,
					o.wind_speed_mph,
					o.wind_direction_deg,
					o.wind_max_interval_mph,
					o.rain_rate_in_hr,
					o.rain_interval_in,
					o.rain_1hr_in,
					o.rain_24hr_in,
					o.rain_today_in,
					o.solar_radiation_wm2,
					o.solar_max_interval_wm2,
					o.pressure_inhg,
					o.et_interval_in
				FROM observations_15min o
				JOIN stations s
					ON s.station_id = o.station_id
				WHERE o.observation_ts >= ?
				ORDER BY o.observation_ts ASC, s.station_name ASC
				LIMIT 2500
			`)
				.bind(startTs)
				.all<ObservationRow>();

			const observations = result.results.map((row) => ({
				...row,
				local_time: unixToPacific(row.observation_ts),
			}));

			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(
							{
								timezone: "America/Los_Angeles",
								requested_hours: hours,
								start_timestamp: startTs,
								observation_count: observations.length,
								observations,
							},
							null,
							2,
						),
					},
				],
			};
		},
	);

	server.registerTool(
		"get_collection_status",
		{
			description:
				"Get the Davis collection state from D1 so the client can determine when each station was last successfully collected.",
			inputSchema: z.object({}),
		},
		async () => {
			const result = await env.DB.prepare(`
				SELECT
					s.station_name,
					cs.*
				FROM collection_state cs
				LEFT JOIN stations s
					ON s.station_id = cs.station_id
				ORDER BY s.station_name
			`).all();

			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(
							{
								timezone: "America/Los_Angeles",
								collection_state: result.results,
							},
							null,
							2,
						),
					},
				],
			};
		},
	);

	return server;
}

export default {
	fetch(request: Request, env: WeatherEnv, ctx: ExecutionContext) {
		const handler = createMcpHandler(() => createServer(env));
		return handler(request, env, ctx);
	},
} satisfies ExportedHandler<WeatherEnv>;
