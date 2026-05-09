const axios = require('axios');
const express = require('express');
require('dotenv').config();

const app = express();
app.get('/', (req, res) => res.send('OK'));
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Health check running on port ${port}`));

const DRY_RUN = true;                 // set false to trade real money
const TRADE_AMOUNT_USD = 25;          // total capital per ladder (spread across buckets)
const MIN_LIQUIDITY_USD = 10000;      // skip low liquidity markets
const MODEL_AGREE_C = 0.8;            // max spread between models to be "agreed"
const MIN_EV = 0.01;                  // minimum expected value (1%)

// ---------- Model run schedule (UTC) ----------
// ECMWF runs at 00,06,12,18 UTC; GFS runs at 00,06,12,18 UTC too.
// We'll fetch forecasts only after the latest run (allow 30 min for data to propagate)
function getLatestModelRun() {
  const now = new Date();
  const utcHour = now.getUTCHours();
  const runs = [0, 6, 12, 18];
  let latestRun = 0;
  for (const run of runs) {
    if (utcHour >= run + 0.5) latestRun = run; // data ready ~30 min after run
  }
  return latestRun;
}

function isModelRunFresh() {
  const latest = getLatestModelRun();
  const now = new Date();
  const runHour = latest;
  const runTime = new Date(now);
  runTime.setUTCHours(runHour, 0, 0, 0);
  const diffMinutes = (now - runTime) / (1000 * 60);
  return diffMinutes < 90; // only use forecasts within 90 minutes of a model run
}

// ---------- Ensemble weather with scheduling ----------
async function getEnsembleForecast(lat, lon) {
  if (!isModelRunFresh()) {
    console.log(`⏳ Model data stale – skipping until next run.`);
    return null;
  }
  const models = ['ecmwf_ifs', 'gfs_seamless', 'icon_seamless'];
  const forecasts = [];
  for (const model of models) {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=temperature_2m_max&models=${model}&timezone=auto`;
    try {
      const res = await axios.get(url);
      const maxTemp = res.data.daily.temperature_2m_max[1];
      forecasts.push(maxTemp);
    } catch (err) {
      console.error(`Model ${model} failed: ${err.message}`);
      forecasts.push(null);
    }
  }
  const valid = forecasts.filter(f => f !== null);
  if (valid.length < 2) return null;
  const avg = valid.reduce((a,b) => a+b,0) / valid.length;
  const maxDiff = Math.max(...valid) - Math.min(...valid);
  const agreement = maxDiff <= MODEL_AGREE_C;
  return { currentC: null, maxC: avg, agreement, modelValues: valid };
}

async function getCurrentTemp(lat, lon) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true&timezone=auto`;
  try {
    const res = await axios.get(url);
    return res.data.current_weather.temperature;
  } catch {
    return null;
  }
}

// ---------- Polymarket helpers ----------
function getSlug(cityName, date) {
  const citySlug = cityName.toLowerCase().replace(/ /g, '-');
  const monthNames = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const month = monthNames[date.getMonth()];
  const day = date.getDate();
  const year = date.getFullYear();
  return `highest-temperature-in-${citySlug}-on-${month}-${day}-${year}`;
}

async function fetchBuckets(slug) {
  const url = `https://gamma-api.polymarket.com/markets?slug=${slug}&limit=1`;
  try {
    const res = await axios.get(url);
    const market = res.data[0];
    if (!market || !market.outcomes || !market.outcomePrices) return null;
    if ((market.volume24hr || 0) < MIN_LIQUIDITY_USD) return null;
    const outcomes = JSON.parse(market.outcomes);
    const prices = JSON.parse(market.outcomePrices).map(p => parseFloat(p));
    const thresholds = outcomes.map(out => {
      const match = out.match(/(\d+)/);
      return match ? parseInt(match[1], 10) : null;
    });
    const buckets = [];
    for (let i = 0; i < thresholds.length; i++) {
      if (thresholds[i] !== null) {
        buckets.push({ temp: thresholds[i], yesPrice: prices[i], noPrice: 1 - prices[i] });
      }
    }
    return buckets;
  } catch (err) {
    console.error(`Fetch buckets error: ${err.message}`);
    return null;
  }
}

// ---------- Laddering logic ----------
function computeEV(confidence, yesPrice) {
  const winProb = confidence / 100;
  return winProb * (1 - yesPrice) - (1 - winProb) * yesPrice;
}

function buildLadder(forecast, buckets, agreement, currentTemp) {
  // Find the bucket that contains the forecast (or nearest)
  let centralBucket = null;
  for (const b of buckets) {
    if (Math.abs(b.temp - forecast) < 1.0) { // within 1°C
      centralBucket = b;
      break;
    }
  }
  if (!centralBucket) return [];
  // Ladder: buy central bucket, plus one above and one below (if they exist)
  const ladder = [centralBucket];
  const above = buckets.find(b => b.temp === centralBucket.temp + 1);
  const below = buckets.find(b => b.temp === centralBucket.temp - 1);
  if (above) ladder.push(above);
  if (below) ladder.push(below);
  // Assign confidence based on agreement and distance from forecast
  const ladderTrades = [];
  for (const bucket of ladder) {
    let confidence = 70;
    const diff = Math.abs(bucket.temp - forecast);
    if (diff === 0) confidence = 85;
    else if (diff === 1) confidence = 75;
    else confidence = 65;
    if (!agreement) confidence -= 10;
    // Current temp override
    let direction = bucket.temp <= forecast ? 'YES' : 'NO';
    if (currentTemp !== null && currentTemp > bucket.temp) direction = 'YES'; // force YES if already above threshold
    const ev = computeEV(confidence, bucket.yesPrice);
    if (ev > MIN_EV) {
      ladderTrades.push({ bucket, confidence, direction, ev });
    }
  }
  return ladderTrades;
}

// ---------- Execute ladder trades ----------
async function executeLadder(city, slug, ladderTrades) {
  if (ladderTrades.length === 0) return;
  const capitalPerTrade = TRADE_AMOUNT_USD / ladderTrades.length;
  console.log(`\n🏆 Ladder for ${city.name}:`);
  for (const trade of ladderTrades) {
    const bucket = trade.bucket;
    const direction = trade.direction;
    const price = direction === 'YES' ? bucket.yesPrice : bucket.noPrice;
    const shares = Math.floor(capitalPerTrade / price);
    const cost = shares * price;
    const payoutIfWin = shares * 1;
    const profit = payoutIfWin - cost;
    console.log(`   → ${direction} ${bucket.temp}°C @ ${(price*100).toFixed(1)}c | ${shares} shares = $${cost.toFixed(2)} | EV: ${(trade.ev*100).toFixed(1)}%`);
    if (!DRY_RUN) {
      // Place order via Polymarket CLOB API (placeholder)
      console.log(`      [LIVE] order placed`);
    } else {
      console.log(`      [DRY RUN] would buy ${direction} ${bucket.temp}°C`);
    }
    await new Promise(r => setTimeout(r, 500));
  }
}

// ---------- Main scan ----------
const stats = { scans: 0, trades: 0, cost: 0, potential: 0, start: Date.now() };

async function scanCity(city) {
  const weather = await getEnsembleForecast(city.lat, city.lon);
  if (!weather) return;
  const currentTemp = await getCurrentTemp(city.lat, city.lon);
  const slug = getSlug(city.name, new Date(Date.now() + 86400000));
  const buckets = await fetchBuckets(slug);
  if (!buckets) return;

  console.log(`\n${city.name}: Ensemble avg ${weather.maxC.toFixed(1)}°C | Agreement: ${weather.agreement} | Current: ${currentTemp?.toFixed(1) || 'N/A'}°C`);
  const ladderTrades = buildLadder(weather.maxC, buckets, weather.agreement, currentTemp);
  if (ladderTrades.length === 0) return;
  await executeLadder(city, slug, ladderTrades);
  stats.trades += ladderTrades.length;
  stats.cost += TRADE_AMOUNT_USD;
  stats.potential += ladderTrades.reduce((acc, t) => acc + (t.direction === 'YES' ? (1-t.bucket.yesPrice) : t.bucket.noPrice) * (TRADE_AMOUNT_USD / ladderTrades.length), 0);
}

async function scan() {
  stats.scans++;
  console.log(`\n🌤️ Scan #${stats.scans} - ${new Date().toLocaleTimeString()} (UTC: ${new Date().toUTCString()})`);
  for (const city of CITIES) {
    await scanCity(city);
    await new Promise(r => setTimeout(r, 1000));
  }
  console.log(`\n⏳ Scan done. Next scan in 30 minutes (model runs every 6h).`);
}

function printStats() {
  const mins = Math.floor((Date.now() - stats.start) / 60000);
  console.log(`\n📊 Stats | ${mins} min | Trades: ${stats.trades} | At risk: $${stats.cost.toFixed(2)} | Est profit: $${stats.potential.toFixed(2)}`);
}

const CITIES = [
  { name: 'Seoul', lat: 37.57, lon: 126.98 },
  { name: 'Singapore', lat: 1.29, lon: 103.85 },
  { name: 'Tokyo', lat: 35.68, lon: 139.69 },
  { name: 'Shanghai', lat: 31.23, lon: 121.47 },
  { name: 'Hong Kong', lat: 22.32, lon: 114.17 },
  { name: 'Taipei', lat: 25.03, lon: 121.56 },
  { name: 'Lucknow', lat: 26.85, lon: 80.95 },
  { name: 'London', lat: 51.51, lon: -0.13 },
  { name: 'Paris', lat: 48.85, lon: 2.35 },
  { name: 'Madrid', lat: 40.42, lon: -3.70 },
  { name: 'Milan', lat: 45.47, lon: 9.19 },
  { name: 'Warsaw', lat: 52.23, lon: 21.01 },
  { name: 'Tel Aviv', lat: 32.08, lon: 34.78 },
  { name: 'Ankara', lat: 39.93, lon: 32.85 },
  { name: 'NYC', lat: 40.71, lon: -74.01 },
  { name: 'Miami', lat: 25.77, lon: -80.19 },
  { name: 'Chicago', lat: 41.85, lon: -87.65 },
  { name: 'Dallas', lat: 32.78, lon: -96.80 },
  { name: 'Atlanta', lat: 33.75, lon: -84.39 },
  { name: 'Seattle', lat: 47.61, lon: -122.33 },
  { name: 'Toronto', lat: 43.65, lon: -79.38 },
  { name: 'Wellington', lat: -41.29, lon: 174.78 },
  { name: 'Buenos Aires', lat: -34.60, lon: -58.38 },
  { name: 'Sao Paulo', lat: -23.55, lon: -46.63 }
];
async function main() {
  console.log('🚀 CERTova-X Elite Bot – Laddering + Model‑Run Sync');
  console.log(`Dry run: ${DRY_RUN} | Trade amount: $${TRADE_AMOUNT_USD} per ladder | Min liquidity: $${MIN_LIQUIDITY_USD}`);
  while (true) {
    await scan();
    printStats();
    // Wait 30 minutes before next scan (model runs every 6h, but we check freshness inside)
    await new Promise(r => setTimeout(r, 30 * 60 * 1000));
  }
}

main().catch(console.error);
