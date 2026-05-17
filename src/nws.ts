import axios from "axios";
import { warn } from "./colors";

export type TempUnit = "F" | "C";
export type WeatherProvider = "nws" | "open-meteo";

export interface LocationConfig {
  lat: number;
  lon: number;
  name: string;
  /** Unit Polymarket uses for this market's buckets. Forecast values are returned in this unit. */
  tempUnit: TempUnit;
  /** Weather data source. NWS is US-only; international cities use Open-Meteo. */
  provider: WeatherProvider;
}

export const LOCATIONS: Record<string, LocationConfig> = {
  // US cities — NWS, Fahrenheit (Polymarket markets use °F here)
  nyc: { lat: 40.7772, lon: -73.8726, name: "New York City", tempUnit: "F", provider: "nws" },
  chicago: { lat: 41.9742, lon: -87.9073, name: "Chicago", tempUnit: "F", provider: "nws" },
  miami: { lat: 25.7959, lon: -80.287, name: "Miami", tempUnit: "F", provider: "nws" },
  dallas: { lat: 32.8471, lon: -96.8518, name: "Dallas", tempUnit: "F", provider: "nws" },
  seattle: { lat: 47.4502, lon: -122.3088, name: "Seattle", tempUnit: "F", provider: "nws" },
  atlanta: { lat: 33.6407, lon: -84.4277, name: "Atlanta", tempUnit: "F", provider: "nws" },
  // International — Open-Meteo, Celsius (Polymarket bucket questions use °C for these)
  // London market resolves on London City Airport (EGLC) readings.
  london: { lat: 51.5053, lon: 0.0552, name: "London", tempUnit: "C", provider: "open-meteo" },
  // Hong Kong market resolves on Hong Kong Observatory (HKO) readings.
  "hong-kong": { lat: 22.3022, lon: 114.1744, name: "Hong Kong", tempUnit: "C", provider: "open-meteo" },
 chongqing: { lat: 29.4316, lon: 106.9123, name: "Chongqing", tempUnit: "C", provider: "open-meteo" }
};

export const NWS_ENDPOINTS: Record<string, string> = {
  nyc: "https://api.weather.gov/gridpoints/OKX/37,39/forecast/hourly",
  chicago: "https://api.weather.gov/gridpoints/LOT/66,77/forecast/hourly",
  miami: "https://api.weather.gov/gridpoints/MFL/106,51/forecast/hourly",
  dallas: "https://api.weather.gov/gridpoints/FWD/87,107/forecast/hourly",
  seattle: "https://api.weather.gov/gridpoints/SEW/124,61/forecast/hourly",
  atlanta: "https://api.weather.gov/gridpoints/FFC/50,82/forecast/hourly"
};

export const STATION_IDS: Record<string, string> = {
  nyc: "KLGA",
  chicago: "KORD",
  miami: "KMIA",
  dallas: "KDAL",
  seattle: "KSEA",
  atlanta: "KATL"
};

const USER_AGENT = "weatherbot-ts/1.0";

export type DailyForecast = Record<string, number>;

async function fetchNwsForecast(citySlug: string): Promise<DailyForecast> {
  const forecastUrl = NWS_ENDPOINTS[citySlug];
  const stationId = STATION_IDS[citySlug];
  const dailyMax: DailyForecast = {};
  const headers = { "User-Agent": USER_AGENT };

  // Real observations — what already happened today
  try {
    const obsUrl = `https://api.weather.gov/stations/${stationId}/observations?limit=48`;
    const r = await axios.get(obsUrl, { timeout: 10000, headers });
    const features = (r.data?.features ?? []) as any[];
    for (const obs of features) {
      const props = obs.properties ?? {};
      const timeStr = String(props.timestamp ?? "").slice(0, 10);
      const tempC = props.temperature?.value as number | null | undefined;
      if (typeof tempC === "number") {
        const tempF = Math.round((tempC * 9) / 5 + 32);
        if (!(timeStr in dailyMax) || tempF > dailyMax[timeStr]) {
          dailyMax[timeStr] = tempF;
        }
      }
    }
  } catch (e) {
    warn(`Observations error for ${citySlug}: ${String(e)}`);
  }

  // Hourly forecast — upcoming hours
  try {
    const r = await axios.get(forecastUrl, { timeout: 10000, headers });
    const periods = r.data?.properties?.periods ?? [];
    for (const p of periods as any[]) {
      const date = String(p.startTime ?? "").slice(0, 10);
      let temp = p.temperature as number;
      if (p.temperatureUnit === "C") {
        temp = Math.round((temp * 9) / 5 + 32);
      }
      if (!(date in dailyMax) || temp > dailyMax[date]) {
        dailyMax[date] = temp;
      }
    }
  } catch (e) {
    warn(`Forecast error for ${citySlug}: ${String(e)}`);
  }

  return dailyMax;
}

/**
 * Daily-max forecast from Open-Meteo. Returns integer values rounded to whole degrees
 * (Polymarket international buckets are at 1°C granularity). Dates are local to the
 * city (timezone=auto), which matches how the Polymarket market is resolved.
 */
async function fetchOpenMeteoForecast(citySlug: string): Promise<DailyForecast> {
  const loc = LOCATIONS[citySlug];
  if (!loc) return {};
  const unit = loc.tempUnit === "F" ? "fahrenheit" : "celsius";
  const url =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${loc.lat}&longitude=${loc.lon}` +
    `&daily=temperature_2m_max&temperature_unit=${unit}` +
    `&past_days=1&forecast_days=7&timezone=auto`;
  const dailyMax: DailyForecast = {};
  try {
    const r = await axios.get(url, { timeout: 10000 });
    const times = (r.data?.daily?.time ?? []) as string[];
    const maxes = (r.data?.daily?.temperature_2m_max ?? []) as number[];
    for (let i = 0; i < times.length; i++) {
      const t = times[i];
      const v = maxes[i];
      if (typeof t === "string" && typeof v === "number" && Number.isFinite(v)) {
        dailyMax[t] = Math.round(v);
      }
    }
  } catch (e) {
    warn(`Open-Meteo error for ${citySlug}: ${String(e)}`);
  }
  return dailyMax;
}

export async function getForecast(citySlug: string): Promise<DailyForecast> {
  const loc = LOCATIONS[citySlug];
  if (!loc) return {};
  return loc.provider === "nws"
    ? fetchNwsForecast(citySlug)
    : fetchOpenMeteoForecast(citySlug);
}
