```
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


// ====================================================
// CLOUDFLARE ACCESS CONFIGURATION
// ====================================================

const ACCESS_TEAM_DOMAIN =
	"https://fragrant-river-2b15.cloudflareaccess.com";

const ACCESS_AUD =
	"23afb6551a3dac57a80dff9f93dbcb1cd70edf2fbdcf8050c2db0113d7a80766";

const ACCESS_JWKS_URL =
	`${ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`;


// ====================================================
// JWT / ACCESS HELPERS
// ====================================================

type JwtHeader = {
	alg?: string;
	kid?: string;
	typ?: string;
};

type JwtPayload = {
	iss?: string;
	aud?: string | string[];
	exp?: number;
	nbf?: number;
	iat?: number;
	email?: string;
	sub?: string;
	[key: string]: unknown;
};

type Jwk = {
	kty: string;
	kid?: string;
	use?: string;
	alg?: string;
	n?: string;
	e?: string;
	[key: string]: unknown;
};

let cachedJwks:
	| {
			keys: Jwk[];
			fetchedAt: number;
	  }
	| null = null;

const JWKS_CACHE_MS = 10 * 60 * 1000;


function decodeBase64Url(input: string): Uint8Array {
	const normalized =
		input
			.replace(/-/g, "+")
			.replace(/_/g, "/");

	const padding =
		normalized.length % 4 === 0
			? ""
			: "=".repeat(
					4 -
						(normalized.length % 4)
			  );

	const binary =
		atob(normalized + padding);

	const bytes =
		new Uint8Array(binary.length);

	for (
		let i = 0;
		i < binary.length;
		i++
	) {
		bytes[i] =
			binary.charCodeAt(i);
	}

	return bytes;
}


function decodeJwtJson<T>(
	segment: string
): T {
	const bytes =
		decodeBase64Url(segment);

	const text =
		new TextDecoder().decode(
			bytes
		);

	return JSON.parse(text) as T;
}


async function fetchJwks(
	forceRefresh = false
): Promise<Jwk[]> {

	const now =
		Date.now();

	if (
		!forceRefresh &&
		cachedJwks &&
		now -
			cachedJwks.fetchedAt <
			JWKS_CACHE_MS
	) {
		return cachedJwks.keys;
	}

	const response =
		await fetch(
			ACCESS_JWKS_URL,
			{
				headers: {
					Accept:
						"application/json",
				},
			}
		);

	if (!response.ok) {
		throw new Error(
			`Unable to retrieve Cloudflare Access signing keys: HTTP ${response.status}`
		);
	}

	const data =
		(await response.json()) as {
			keys?: Jwk[];
		};

	if (
		!Array.isArray(
			data.keys
		)
	) {
		throw new Error(
			"Cloudflare Access JWKS response did not contain keys."
		);
	}

	cachedJwks = {
		keys:
			data.keys,
		fetchedAt:
			now,
	};

	return data.keys;
}


async function findJwk(
	kid: string
): Promise<Jwk> {

	let keys =
		await fetchJwks(false);

	let jwk =
		keys.find(
			(key) =>
				key.kid === kid
		);

	// If Access rotated its signing key,
	// immediately refresh the JWKS once.
	if (!jwk) {
		keys =
			await fetchJwks(true);

		jwk =
			keys.find(
				(key) =>
					key.kid === kid
			);
	}

	if (!jwk) {
		throw new Error(
			`No Cloudflare Access signing key found for kid ${kid}.`
		);
	}

	return jwk;
}


function audienceMatches(
	aud:
		| string
		| string[]
		| undefined
): boolean {

	if (
		typeof aud ===
		"string"
	) {
		return (
			aud === ACCESS_AUD
		);
	}

	if (
		Array.isArray(aud)
	) {
		return aud.includes(
			ACCESS_AUD
		);
	}

	return false;
}


async function verifyAccessJwt(
	request: Request
): Promise<JwtPayload> {

	const token =
		request.headers.get(
			"Cf-Access-Jwt-Assertion"
		);

	if (!token) {
		throw new Error(
			"Missing Cf-Access-Jwt-Assertion header."
		);
	}

	const parts =
		token.split(".");

	if (
		parts.length !== 3
	) {
		throw new Error(
			"Malformed Cloudflare Access JWT."
		);
	}

	const [
		headerSegment,
		payloadSegment,
		signatureSegment,
	] = parts;

	const header =
		decodeJwtJson<JwtHeader>(
			headerSegment
		);

	const payload =
		decodeJwtJson<JwtPayload>(
			payloadSegment
		);

	if (
		header.alg !==
		"RS256"
	) {
		throw new Error(
			`Unexpected JWT algorithm: ${header.alg ?? "missing"}`
		);
	}

	if (!header.kid) {
		throw new Error(
			"JWT is missing kid."
		);
	}


	// ----------------------------------------------
	// VERIFY ISSUER
	// ----------------------------------------------

	if (
		payload.iss !==
		ACCESS_TEAM_DOMAIN
	) {
		throw new Error(
			"JWT issuer does not match this Cloudflare Access team."
		);
	}


	// ----------------------------------------------
	// VERIFY AUDIENCE
	// ----------------------------------------------

	if (
		!audienceMatches(
			payload.aud
		)
	) {
		throw new Error(
			"JWT audience does not match the South Valley Weather application."
		);
	}


	// ----------------------------------------------
	// VERIFY EXPIRATION / NOT-BEFORE
	// ----------------------------------------------

	const nowSeconds =
		Math.floor(
			Date.now() / 1000
		);

	if (
		typeof payload.exp !==
			"number" ||
		payload.exp <=
			nowSeconds
	) {
		throw new Error(
			"Cloudflare Access JWT is expired or missing expiration."
		);
	}

	if (
		typeof payload.nbf ===
			"number" &&
		payload.nbf >
			nowSeconds + 30
	) {
		throw new Error(
			"Cloudflare Access JWT is not valid yet."
		);
	}


	// ----------------------------------------------
	// FETCH SIGNING KEY
	// ----------------------------------------------

	const jwk =
		await findJwk(
			header.kid
		);

	if (
		jwk.kty !== "RSA"
	) {
		throw new Error(
			"Unexpected Cloudflare Access signing key type."
		);
	}


	// ----------------------------------------------
	// IMPORT PUBLIC KEY
	// ----------------------------------------------

	const cryptoKey =
		await crypto.subtle.importKey(
			"jwk",
			jwk as JsonWebKey,
			{
				name:
					"RSASSA-PKCS1-v1_5",
				hash:
					"SHA-256",
			},
			false,
			["verify"]
		);


	// ----------------------------------------------
	// VERIFY SIGNATURE
	// ----------------------------------------------

	const signedData =
		new TextEncoder().encode(
			`${headerSegment}.${payloadSegment}`
		);

	const signature =
		decodeBase64Url(
			signatureSegment
		);

	const valid =
		await crypto.subtle.verify(
			{
				name:
					"RSASSA-PKCS1-v1_5",
			},
			cryptoKey,
			signature,
			signedData
		);

	if (!valid) {
		throw new Error(
			"Cloudflare Access JWT signature verification failed."
		);
	}

	return payload;
}


// ====================================================
// WEATHER HELPERS
// ====================================================

function unixToPacific(
	ts: number
): string {

	return new Intl.DateTimeFormat(
		"en-US",
		{
			timeZone:
				"America/Los_Angeles",

			year:
				"numeric",

			month:
				"2-digit",

			day:
				"2-digit",

			hour:
				"2-digit",

			minute:
				"2-digit",

			second:
				"2-digit",

			hour12:
				false,

			timeZoneName:
				"short",
		}
	).format(
		new Date(
			ts * 1000
		)
	);
}


// ====================================================
// CREATE MCP SERVER
// ====================================================

function createServer(
	env: WeatherEnv
) {

	const server =
		new McpServer({
			name:
				"South Valley Weather",

			version:
				"1.1.0",
		});


	// ==================================================
	// TOOL 1 — LATEST OBSERVATIONS
	// ==================================================

	server.registerTool(
		"get_latest_observations",
		{
			description:
				"Get the newest stored South Valley Weather observation for every station in D1, including Davis and Probe Schedule stations.",

			inputSchema:
				z.object({}),
		},

		async () => {

			const result =
				await env.DB
					.prepare(`
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
							ON s.station_id =
							   o.station_id

						INNER JOIN (
							SELECT
								station_id,
								MAX(observation_ts) AS newest_ts

							FROM observations_15min

							GROUP BY
								station_id
						) latest

							ON latest.station_id =
							   o.station_id

							AND latest.newest_ts =
							    o.observation_ts

						ORDER BY
							s.station_name
					`)
					.all<ObservationRow>();


			const observations =
				result.results.map(
					(row) => ({
						...row,

						local_time:
							unixToPacific(
								row.observation_ts
							),
					})
				);


			return {
				content: [
					{
						type:
							"text",

						text:
							JSON.stringify(
								{
									timezone:
										"America/Los_Angeles",

									observation_count:
										observations.length,

									observations,
								},
								null,
								2
							),
					},
				],
			};
		}
	);


	// ==================================================
	// TOOL 2 — HISTORICAL OBSERVATIONS
	// ==================================================

	server.registerTool(
		"get_observations",
		{
			description:
				"Get stored South Valley Weather 15-minute observations for any available historical date/time range. Includes Davis and Probe Schedule stations. No 24-hour historical cutoff is imposed.",

			inputSchema:
				z.object({
					start_ts: z.number().int().nonnegative().describe(
						"Start of requested range as a Unix timestamp in seconds."
					),
					end_ts: z.number().int().nonnegative().describe(
						"End of requested range as a Unix timestamp in seconds."
					),
					station_name: z.string().min(1).optional().describe(
						"Optional exact station name. Omit to retrieve all stations."
					),
					limit: z.number().int().min(1).max(5000).default(2500).describe(
						"Maximum rows to return in this page."
					),
					offset: z.number().int().min(0).default(0).describe(
						"Number of matching rows to skip for pagination."
					),
				}),
		},

		async ({
			start_ts,
			end_ts,
			station_name,
			limit,
			offset,
		}) => {
			if (end_ts < start_ts) {
				throw new Error(
					"end_ts must be greater than or equal to start_ts."
				);
			}

			let query = `
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
				WHERE
					o.observation_ts >= ?
					AND o.observation_ts <= ?
			`;

			const bindings: (string | number)[] = [start_ts, end_ts];

			if (station_name) {
				query += `
					AND s.station_name = ?
				`;
				bindings.push(station_name);
			}

			query += `
				ORDER BY
					o.observation_ts ASC,
					s.station_name ASC
				LIMIT ?
				OFFSET ?
			`;

			bindings.push(limit + 1, offset);

			const result =
				await env.DB
					.prepare(query)
					.bind(...bindings)
					.all<ObservationRow>();

			const hasMore = result.results.length > limit;
			const rows = hasMore
				? result.results.slice(0, limit)
				: result.results;

			const observations =
				rows.map((row) => ({
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
								start_timestamp: start_ts,
								end_timestamp: end_ts,
								station_name: station_name ?? null,
								observation_count: observations.length,
								offset,
								limit,
								has_more: hasMore,
								next_offset: hasMore
									? offset + observations.length
									: null,
								observations,
							},
							null,
							2
						),
					},
				],
			};
		}
	);


	// ==================================================
	// TOOL 3 — DAILY SUMMARY
	// ==================================================

	server.registerTool(
		"get_daily_summary",
		{
			description:
				"Get stored South Valley Weather daily summaries for any available date range, including Davis and Probe Schedule stations. Use for historical daily highs, lows, averages, rainfall, dew point, humidity, wet bulb, wind, pressure, solar radiation, and observation counts.",

			inputSchema:
				z.object({
					start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe(
						"First summary date in YYYY-MM-DD format."
					),
					end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe(
						"Last summary date in YYYY-MM-DD format."
					),
					station_name: z.string().min(1).optional().describe(
						"Optional exact station name. Omit to retrieve all stations."
					),
				}),
		},

		async ({
			start_date,
			end_date,
			station_name,
		}) => {
			if (end_date < start_date) {
				throw new Error(
					"end_date must be greater than or equal to start_date."
				);
			}

			let query = `
				SELECT
					s.station_name,
					s.location_name,
					d.summary_date,
					d.temp_high_f,
					d.temp_low_f,
					d.temp_avg_f,
					d.dew_point_high_f,
					d.dew_point_low_f,
					d.dew_point_avg_f,
					d.humidity_high_pct,
					d.humidity_low_pct,
					d.humidity_avg_pct,
					d.wet_bulb_high_f,
					d.wet_bulb_low_f,
					d.wet_bulb_avg_f,
					d.wind_avg_mph,
					d.wind_max_mph,
					d.gust_max_mph,
					d.rain_total_in,
					d.pressure_high_inhg,
					d.pressure_low_inhg,
					d.pressure_avg_inhg,
					d.solar_avg_wm2,
					d.solar_max_wm2,
					d.observation_count
				FROM daily_summary d
				JOIN stations s
					ON s.station_id = d.station_id
				WHERE
					d.summary_date >= ?
					AND d.summary_date <= ?
			`;

			const bindings: string[] = [start_date, end_date];

			if (station_name) {
				query += `
					AND s.station_name = ?
				`;
				bindings.push(station_name);
			}

			query += `
				ORDER BY
					d.summary_date ASC,
					s.station_name ASC
			`;

			const result =
				await env.DB
					.prepare(query)
					.bind(...bindings)
					.all();

			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(
							{
								timezone: "America/Los_Angeles",
								start_date,
								end_date,
								station_name: station_name ?? null,
								summary_count: result.results.length,
								summaries: result.results,
							},
							null,
							2
						),
					},
				],
			};
		}
	);


	// ==================================================
	// TOOL 4 — COLLECTION STATUS
	// ==================================================

	server.registerTool(
		"get_collection_status",
		{
			description:
				"Get the South Valley Weather collection state from D1 so the client can determine when each station was last successfully collected.",

			inputSchema:
				z.object({}),
		},

		async () => {
			const result =
				await env.DB
					.prepare(`
						SELECT
							s.station_name,
							cs.*
						FROM collection_state cs
						LEFT JOIN stations s
							ON s.station_id = cs.station_id
						ORDER BY
							s.station_name
					`)
					.all();

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
							2
						),
					},
				],
			};
		}
	);

	return server;
}


// ====================================================
// MAIN WORKER
// ====================================================

export default {

	async fetch(
		request: Request,
		env: WeatherEnv,
		ctx: ExecutionContext
	): Promise<Response> {

		// ----------------------------------------------
		// VERIFY CLOUDFLARE ACCESS JWT FIRST
		// ----------------------------------------------

		try {

			await verifyAccessJwt(
				request
			);

		} catch (error) {

			const message =
				error instanceof Error
					? error.message
					: "Unknown authentication error";

			return new Response(
				`Forbidden: ${message}`,
				{
					status: 403,

					headers: {
						"Content-Type":
							"text/plain; charset=utf-8",
					},
				}
			);
		}


		// ----------------------------------------------
		// AUTHENTICATED REQUEST — HAND TO MCP SERVER
		// ----------------------------------------------

		const handler =
			createMcpHandler(
				() =>
					createServer(
						env
					)
			);

		return handler(
			request,
			env,
			ctx
		);
	},

} satisfies ExportedHandler<WeatherEnv>;
```
