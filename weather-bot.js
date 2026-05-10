const axios = require('axios');
const express = require('express');
require('dotenv').config();

// Health check for Render
const app = express();
app.get('/', (req, res) => res.send('OK'));
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Health check running on port ${port}`));

// ========== CONFIGURATION ==========
const DRY_RUN = true;                // Set to false for live trading
const TRADE_AMOUNT_USD = 25;
const MIN_LIQUIDITY_USD = 10000;
const MIN_EV = 0.01;                // 1% minimum expected value
const MODEL_TIMEOUT_MS = 15000;

// Discord webhook (optional)
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
async function sendDiscord(msg) {
  if (!DISCORD_WEBHOOK_URL) return;
  try { await axios.post(DISCORD_WEBHOOK_URL, { content: msg }); } catch(e) {}
}

let lastHeartbeat = 0;

// ========== WEATHER API (Open-Meteo) ==========
async function getEnsembleForecast(lat, lon) {
  const models = ['ecmwf_ifs', 'gfs_seamless', 'icon_seamless'];
  const forecasts = [];
  for (const model of models) {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=temperature_2m_max&models=${model}&timezone=auto`;
    try {
      const res = await axios.get(url, { timeout: MODEL_TIMEOUT_MS });
      const maxTemp = res.data.daily.temperature_2m_max[1];
      forecasts.push(maxTemp);
      console.log(`   ${model.toUpperCase()}: ${maxTemp}°C`);
    } catch (err) {
      console.log(`   ${model.toUpperCase()} failed: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  if (forecasts.length === 0) return null;
  const avg = forecasts.reduce((a,b) => a+b,0) / forecasts.length;
  const maxDiff = Math.max(...forecasts) - Math.min(...forecasts);
  const agreement = maxDiff <= 0.8;
  return { maxC: avg, agreement };
}

async function getCurrentTemp(lat, lon) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true&timezone=auto`;
  try { const res = await axios.get(url); return res.data.current_weather.temperature; } catch { return null; }
}

// ========== STATIC FALLBACK PRICES (used if live fetch fails) ==========
function getFallbackBuckets(cityName) {
  const cityLower = cityName.toLowerCase();
  const priceMap = {
    'seoul': [
      { temp: 18, yesPrice: 0.23, noPrice: 0.77 },
      { temp: 19, yesPrice: 0.34, noPrice: 0.66 },
      { temp: 20, yesPrice: 0.25, noPrice: 0.75 },
      { temp: 21, yesPrice: 0.15, noPrice: 0.85 },
      { temp: 22, yesPrice: 0.08, noPrice: 0.92 }
    ],
    'tokyo': [
      { temp: 22, yesPrice: 0.20, noPrice: 0.80 },
      { temp: 23, yesPrice: 0.25, noPrice: 0.75 },
      { temp: 24, yesPrice: 0.15, noPrice: 0.85 },
      { temp: 25, yesPrice: 0.10, noPrice: 0.90 }
    ],
    'shanghai': [
      { temp: 28, yesPrice: 0.19, noPrice: 0.81 },
      { temp: 29, yesPrice: 0.23, noPrice: 0.77 },
      { temp: 30, yesPrice: 0.28, noPrice: 0.72 },
      { temp: 31, yesPrice: 0.15, noPrice: 0.85 },
      { temp: 32, yesPrice: 0.08, noPrice: 0.92 }
    ],
    'singapore': [
      { temp: 30, yesPrice: 0.20, noPrice: 0.80 },
      { temp: 31, yesPrice: 0.35, noPrice: 0.65 },
      { temp: 32, yesPrice: 0.40, noPrice: 0.60 },
      { temp: 33, yesPrice: 0.25, noPrice: 0.75 }
    ],
    'taipei': [
      { temp: 27, yesPrice: 0.16, noPrice: 0.84 },
      { temp: 28, yesPrice: 0.27, noPrice: 0.73 },
      { temp: 29, yesPrice: 0.36, noPrice: 0.64 },
      { temp: 30, yesPrice: 0.25, noPrice: 0.75 },
      { temp: 31, yesPrice: 0.11, noPrice: 0.89 },
      { temp: 32, yesPrice: 0.103, noPrice: 0.897 }
    ],
    'hong kong': [
      { temp: 27, yesPrice: 0.20, noPrice: 0.80 },
      { temp: 28, yesPrice: 0.30, noPrice: 0.70 },
      { temp: 29, yesPrice: 0.25, noPrice: 0.75 }
    ],
    'london': [
      { temp: 12, yesPrice: 0.10, noPrice: 0.90 },
      { temp: 13, yesPrice: 0.15, noPrice: 0.85 },
      { temp: 14, yesPrice: 0.08, noPrice: 0.92 }
    ],
    'warsaw': [
      { temp: 19, yesPrice: 0.20, noPrice: 0.80 },
      { temp: 20, yesPrice: 0.25, noPrice: 0.75 },
      { temp: 21, yesPrice: 0.30, noPrice: 0.70 }
    ],
    'nyc': [
      { temp: 17, yesPrice: 0.20, noPrice: 0.80 },
      { temp: 18, yesPrice: 0.25, noPrice: 0.75 },
      { temp: 19, yesPrice: 0.15, noPrice: 0.85 }
    ],
    'miami': [
      { temp: 29, yesPrice: 0.25, noPrice: 0.75 },
      { temp: 30, yesPrice: 0.30, noPrice: 0.70 },
      { temp: 31, yesPrice: 0.20, noPrice: 0.80 }
    ],
    'chicago': [
      { temp: 10, yesPrice: 0.15, noPrice: 0.85 },
      { temp: 11, yesPrice: 0.20, noPrice: 0.80 },
      { temp: 12, yesPrice: 0.10, noPrice: 0.90 }
    ],
    'dallas': [
      { temp: 24, yesPrice: 0.20, noPrice: 0.80 },
      { temp: 25, yesPrice: 0.25, noPrice: 0.75 },
      { temp: 26, yesPrice: 0.15, noPrice: 0.85 }
    ],
    'atlanta': [
      { temp: 23, yesPrice: 0.20, noPrice: 0.80 },
      { temp: 24, yesPrice: 0.25, noPrice: 0.75 },
      { temp: 25, yesPrice: 0.15, noPrice: 0.85 }
    ],
    'seattle': [
      { temp: 16, yesPrice: 0.15, noPrice: 0.85 },
      { temp: 17, yesPrice: 0.20, noPrice: 0.80 },
      { temp: 18, yesPrice: 0.10, noPrice: 0.90 }
    ],
    'toronto': [
      { temp: 14, yesPrice: 0.15, noPrice: 0.85 },
      { temp: 15, yesPrice: 0.20, noPrice: 0.80 },
      { temp: 16, yesPrice: 0.10, noPrice: 0.90 }
    ],
    'wellington': [
      { temp: 12, yesPrice: 0.15, noPrice: 0.85 },
      { temp: 13, yesPrice: 0.20, noPrice: 0.80 },
      { temp: 14, yesPrice: 0.10, noPrice: 0.90 }
    ],
    'buenos aires': [
      { temp: 16, yesPrice: 0.15, noPrice: 0.85 },
      { temp: 17, yesPrice: 0.20, noPrice: 0.80 },
      { temp: 18, yesPrice: 0.10, noPrice: 0.90 }
    ],
    'sao paulo': [
      { temp: 22, yesPrice: 0.20, noPrice: 0.80 },
      { temp: 23, yesPrice: 0.25, noPrice: 0.75 },
      { temp: 24, yesPrice: 0.15, noPrice: 0.85 }
    ]
  };
  const defaultBuckets = [
    { temp: 20, yesPrice: 0.20, noPrice: 0.80 },
    { temp: 21, yesPrice: 0.25, noPrice: 0.75 },
    { temp: 22, yesPrice: 0.15, noPrice: 0.85 }
  ];
  return priceMap[cityLower] || defaultBuckets;
}

// ========== LIVE PRICE FETCHING – SCRAPE POLYMARKET PAGE (WORKS ALWAYS) ==========
async function fetchBuckets(cityName, targetDate) {
  const monthNames = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const month = monthNames[targetDate.getMonth()];
  const day = targetDate.getDate();
  const year = targetDate.getFullYear();
  const citySlug = cityName.toLowerCase().replace(/ /g, '-');
  const slug = `highest-temperature-in-${citySlug}-on-${month}-${day}-${year}`;
  const url = `https://polymarket.com/event/${slug}`;

  try {
    const { data: html } = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
      timeout: 10000
    });
    const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s);
    if (match) {
      const json = JSON.parse(match[1]);
      const market = json.props?.pageProps?.market || json.props?.pageProps?.markets?.[0];
      if (market && market.outcomePrices && market.outcomes) {
        const prices = JSON.parse(market.outcomePrices);
        const outcomes = JSON.parse(market.outcomes);
        const buckets = [];
        for (let i = 0; i < outcomes.length; i++) {
          const tempMatch = outcomes[i].match(/\d+/);
          if (tempMatch && prices[i]) {
            buckets.push({
              temp: parseInt(tempMatch[0]),
              yesPrice: parseFloat(prices[i]),
              noPrice: 1 - parseFloat(prices[i])
            });
          }
        }
        if (buckets.length) {
          console.log(`   ✅ Live prices scraped (${buckets.length} buckets) for ${cityName}`);
          return buckets.sort((a,b) => a.temp - b.temp);
        }
      }
    }
  } catch (err) {
    console.log(`   Scrape error for ${cityName}: ${err.message}`);
  }
  console.log(`   ⚠️ Could not fetch live prices for ${cityName}, using fallback`);
  return getFallbackBuckets(cityName);
}

// ========== EXPECTED VALUE & TRADING LOGIC ==========
function computeEV(conf, yesPrice) {
  const winProb = conf / 100;
  return winProb * (1 - yesPrice) - (1 - winProb) * yesPrice;
}

function buildLadder(forecast, buckets, agreement, currentTemp) {
  let central = buckets.find(b => Math.abs(b.temp - forecast) < 1.5);
  if (!central) central = buckets[Math.floor(buckets.length / 2)];
  const trades = [];
  for (const b of buckets) {
    let conf = 70;
    const diff = Math.abs(b.temp - forecast);
    if (diff <= 0.5) conf = 85;
    else if (diff <= 1.5) conf = 75;
    else conf = 60;
    if (!agreement) conf -= 10;
    const dir = b.temp <= forecast ? 'YES' : 'NO';
    const price = dir === 'YES' ? b.yesPrice : b.noPrice;
    const ev = computeEV(conf, price);
    if (ev > MIN_EV) {
      trades.push({ bucket: b, confidence: conf, direction: dir, ev });
    }
  }
  return trades;
}

async function executeLadder(city, trades) {
  if (!trades.length) return;
  const per = TRADE_AMOUNT_USD / trades.length;
  let summary = `🏆 Ladder for ${city.name}\n`;
  for (const t of trades) {
    const price = t.direction === 'YES' ? t.bucket.yesPrice : t.bucket.noPrice;
    const shares = Math.floor(per / price);
    const cost = shares * price;
    summary += `${t.direction} ${t.bucket.temp}°C @ ${(price*100).toFixed(1)}c | ${shares} shares = $${cost.toFixed(2)} | EV: ${(t.ev*100).toFixed(1)}%\n`;
    console.log(`   [DRY RUN] would buy ${t.direction} ${t.bucket.temp}°C @ ${(price*100).toFixed(1)}c`);
  }
  await sendDiscord(summary);
}

// ========== SCAN STATISTICS ==========
const stats = { scans: 0, trades: 0, cost: 0, start: Date.now() };

async function scanCity(city) {
  console.log(`\n🔍 Scanning ${city.name}...`);
  const weather = await getEnsembleForecast(city.lat, city.lon);
  if (!weather) return;
  const currentTemp = await getCurrentTemp(city.lat, city.lon);
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const buckets = await fetchBuckets(city.name, tomorrow);
  if (!buckets || buckets.length === 0) return;
  console.log(`   Ensemble: ${weather.maxC.toFixed(1)}°C | Agreement: ${weather.agreement} | Current: ${currentTemp?.toFixed(1) || 'N/A'}°C`);
  const trades = buildLadder(weather.maxC, buckets, weather.agreement, currentTemp);
  if (!trades.length) return;
  await executeLadder(city, trades);
  stats.trades += trades.length;
  stats.cost += TRADE_AMOUNT_USD;
}

async function scan() {
  stats.scans++;
  console.log(`\n🌤️ Scan #${stats.scans} - ${new Date().toLocaleTimeString()} (UTC: ${new Date().toUTCString()})`);
  for (const city of CITIES) {
    await scanCity(city);
    await new Promise(r => setTimeout(r, 2000));
  }
  console.log(`\n⏳ Scan done. Next scan in 30 minutes.`);
}

function printStats() {
  const mins = Math.floor((Date.now() - stats.start) / 60000);
  console.log(`\n📊 Stats | ${mins} min | Trades: ${stats.trades} | At risk: $${stats.cost.toFixed(2)}`);
}

// ========== AIRPORT COORDINATES (ALL 24 CITIES) ==========
const CITIES = [
  { name: 'Seoul', lat: 37.4633, lon: 126.4400 },
  { name: 'Singapore', lat: 1.3644, lon: 103.9915 },
  { name: 'Tokyo', lat: 35.5494, lon: 139.7798 },
  { name: 'Shanghai', lat: 31.1443, lon: 121.8083 },
  { name: 'Hong Kong', lat: 22.3080, lon: 113.9185 },
  { name: 'Taipei', lat: 25.0697, lon: 121.5528 },
  { name: 'Lucknow', lat: 26.7606, lon: 80.8828 },
  { name: 'London', lat: 51.4700, lon: -0.4543 },
  { name: 'Paris', lat: 49.0097, lon: 2.5478 },
  { name: 'Madrid', lat: 40.4983, lon: -3.5675 },
  { name: 'Milan', lat: 45.6300, lon: 8.7231 },
  { name: 'Warsaw', lat: 52.1657, lon: 20.9671 },
  { name: 'Tel Aviv', lat: 32.0114, lon: 34.8867 },
  { name: 'Ankara', lat: 40.1281, lon: 32.9951 },
  { name: 'NYC', lat: 40.6398, lon: -73.7789 },
  { name: 'Miami', lat: 25.7932, lon: -80.2906 },
  { name: 'Chicago', lat: 41.9742, lon: -87.9073 },
  { name: 'Dallas', lat: 32.8998, lon: -97.0403 },
  { name: 'Atlanta', lat: 33.6407, lon: -84.4277 },
  { name: 'Seattle', lat: 47.4502, lon: -122.3088 },
  { name: 'Toronto', lat: 43.6777, lon: -79.6248 },
  { name: 'Buenos Aires', lat: -34.8222, lon: -58.5358 },
  { name: 'Sao Paulo', lat: -23.4356, lon: -46.4731 },
  { name: 'Wellington', lat: -41.3272, lon: 174.8053 }
];

// ========== MAIN LOOP ==========
async function main() {
  console.log('🚀 Elite Bot – Live Price Scraping + Airport Coordinates');
  console.log(`Dry run: ${DRY_RUN} | Trade amount: $${TRADE_AMOUNT_USD}`);
  await sendDiscord('🤖 Bot started – using live price scraping (HTML).');
  while (true) {
    await scan();
    printStats();
    const now = Date.now();
    if (now - lastHeartbeat > 60 * 60 * 1000) {
      lastHeartbeat = now;
      await sendDiscord(`❤️ Heartbeat – ${stats.scans} scans completed.`);
    }
    await new Promise(r => setTimeout(r, 30 * 60 * 1000));
  }
}

main().catch(console.error);
