import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

type WeatherEnv = {
	DB: D1Database;
};

type ObservationRow = {
	station_name: string;
	location_name: string | null;
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

type DailySummaryRow = {
	station_name: string;
	location_name: string | null;
	summary_date: string;
	temp_high_f: number | null;
	temp_low_f: number | null;
	temp_avg_f: number | null;
	dew_point_high_f: number | null;
	dew_point_low_f: number | null;
	dew_point_avg_f: number | null;
	humidity_high_pct: number | null;
	humidity_low_pct: number | null;
	humidity_avg_pct: number | null;
	wet_bulb_high_f: number | null;
	wet_bulb_low_f: number | null;
	wet_bulb_avg_f: number | null;
	wind_avg_mph: number | null;
	wind_max_mph: number | null;
	gust_max_mph: number | null;
	rain_total_in: number | null;
	pressure_high_inhg: number | null;
	pressure_low_inhg: number | null;
	pressure_avg_inhg: number | null;
	solar_avg_wm2: number | null;
	solar_max_wm2: number | null;
	observation_count: number | null;
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


function decodeBase64Url(
	input: string
): Uint8Array {

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

	if (
		payload.iss !==
		ACCESS_TEAM_DOMAIN
	) {
		throw new Error(
			"JWT issuer does not match this Cloudflare Access team."
		);
	}

	if (
		!audienceMatches(
			payload.aud
		)
	) {
		throw new Error(
			"JWT audience does not match the South Valley Weather application."
		);
	}

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


function isValidDateString(
	value: string
): boolean {

	if (
		!/^\d{4}-\d{2}-\d{2}$/.test(
			value
		)
	) {
		return false;
	}

	const parsed =
		new Date(
			`${value}T00:00:00Z`
		);

	return (
		!Number.isNaN(
			parsed.getTime()
		) &&
		parsed
			.toISOString()
			.slice(0, 10) === value
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
				"2.0.0",
		});


	// ==================================================
	// TOOL 1 — LATEST OBSERVATIONS
	// ==================================================

	server.registerTool(
		"get_latest_observations",
		{
			description:
				"Get the newest stored South Valley Weather observation for every active station, including Davis and Probe Schedule stations.",

			inputSchema:
				z.object({}),
		},

		async () => {

			const result =
				await env.DB
					.prepare(`
						SELECT
							s.station_name,
							s.location_name,
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

						WHERE
							s.active = 1

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
				"Get stored South Valley Weather observations for any available historical date/time range. Includes Davis and Probe Schedule stations. No 24-hour or historical-age cutoff is imposed. Use pagination for large requests.",

			inputSchema:
				z.object({

					start_ts:
						z
							.number()
							.int()
							.nonnegative()
							.describe(
								"Start of requested range as a Unix timestamp in seconds."
							),

					end_ts:
						z
							.number()
							.int()
							.nonnegative()
							.describe(
								"End of requested range as a Unix timestamp in seconds."
							),

					station_name:
						z
							.string()
							.min(1)
							.optional()
							.describe(
								"Optional exact station name. Omit to retrieve all stations."
							),

					limit:
						z
							.number()
							.int()
							.min(1)
							.max(5000)
							.default(2500)
							.describe(
								"Maximum number of observations to return in this page."
							),

					offset:
						z
							.number()
							.int()
							.min(0)
							.default(0)
							.describe(
								"Number of matching observations to skip for pagination."
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

			if (
				end_ts <
				start_ts
			) {
				throw new Error(
					"end_ts must be greater than or equal to start_ts."
				);
			}

			let query = `
				SELECT
					s.station_name,
					s.location_name,
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

				WHERE
					o.observation_ts >= ?
					AND o.observation_ts <= ?
			`;

			const bindings:
				(string | number)[] =
				[
					start_ts,
					end_ts,
				];

			if (station_name) {

				query += `
					AND s.station_name = ?
				`;

				bindings.push(
					station_name
				);
			}

			query += `
				ORDER BY
				
