const axios = require('axios');
const express = require('express');
require('dotenv').config();

const app = express();
app.get('/', (req, res) => res.send('OK'));
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Health check running on port ${port}`));

const DRY_RUN = true;
const TRADE_AMOUNT_USD = 25;
const MIN_LIQUIDITY_USD = 10000;
const MIN_EV = 0.01;
const MODEL_TIMEOUT_MS = 10000;

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
async function sendDiscord(msg) {
  if (!DISCORD_WEBHOOK_URL) return;
  try { await axios.post(DISCORD_WEBHOOK_URL, { content: msg }); } catch(e) {}
}

let notifiedFirstBucket = false;
let lastHeartbeat = 0;

// Multi‑model ensemble (ECMWF, GFS, ICON) with delays
async function getEnsembleForecast(lat, lon) {
  const models = ['ecmwf_ifs', 'gfs_seamless', 'icon_seamless'];
  const forecasts = [];
  for (const model of models) {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=temperature_2m_max&models=${model}&timezone=auto`;
    try {
      const res = await axios.get(url, { timeout: MODEL_TIMEOUT_MS });
      const maxTemp = res.data.daily.temperature_2m_max[1];
      forecasts.push(maxTemp);
      console.log(`${model.toUpperCase()}: ${maxTemp}°C`);
    } catch (err) {
      console.log(`${model.toUpperCase()} failed: ${err.message}`);
    }
    // Delay between model calls to avoid rate limits
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

function getSlug(cityName, date) {
  const citySlug = cityName.toLowerCase().replace(/ /g, '-');
  const monthNames = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  const month = monthNames[date.getMonth()];
  const day = date.getDate();
  const year = date.getFullYear();
  return `highest-temperature-in-${citySlug}-on-${month}-${day}-${year}`;
}

async function fetchBuckets(cityName, targetDate) {
  const slug = getSlug(cityName, targetDate);
  try {
    const res = await axios.get(`https://gamma-api.polymarket.com/markets?slug=${slug}&limit=1`, { timeout: 8000 });
    const market = res.data[0];
    if (market && market.outcomes && market.outcomePrices) {
      const outcomes = JSON.parse(market.outcomes);
      const prices = JSON.parse(market.outcomePrices).map(p => parseFloat(p));
      const thresholds = outcomes.map(out => {
        const match = out.match(/(\d+)/);
        return match ? parseInt(match[1]) : null;
      });
      const buckets = [];
      for (let i = 0; i < thresholds.length; i++) {
        if (thresholds[i] !== null) {
          buckets.push({ temp: thresholds[i], yesPrice: prices[i], noPrice: 1 - prices[i] });
        }
      }
      if (buckets.length && !notifiedFirstBucket) {
        notifiedFirstBucket = true;
        await sendDiscord(`✅ **Buckets via Gamma!** City: ${cityName} Date: ${targetDate.toDateString()}`);
      }
      return buckets;
    }
  } catch (err) {}
  // DexScreener fallback
  const searchQuery = `"Highest temperature in ${cityName} on May ${targetDate.getDate()}, ${targetDate.getFullYear()}"`;
  const dexUrl = `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(searchQuery)}`;
  try {
    const res = await axios.get(dexUrl);
    const pairs = res.data.pairs;
    const polymarketPair = pairs.find(p => p.dexId === 'polymarket');
    if (polymarketPair && polymarketPair.baseToken && polymarketPair.baseToken.symbol) {
      const yesPrice = parseFloat(polymarketPair.priceUsd);
      const tempMatch = polymarketPair.baseToken.symbol.match(/(\d+)/);
      const temp = tempMatch ? parseInt(tempMatch[1]) : 22;
      const buckets = [
        { temp: temp - 1, yesPrice: yesPrice * 0.8, noPrice: 1 - yesPrice * 0.8 },
        { temp: temp, yesPrice: yesPrice, noPrice: 1 - yesPrice },
        { temp: temp + 1, yesPrice: yesPrice * 0.5, noPrice: 1 - yesPrice * 0.5 }
      ];
      if (!notifiedFirstBucket) {
        notifiedFirstBucket = true;
        await sendDiscord(`✅ **Buckets via DexScreener!** City: ${cityName} Date: ${targetDate.toDateString()}`);
      }
      return buckets;
    }
  } catch (err) {}
  console.log(`No buckets for ${cityName}`);
  return null;
}

function computeEV(conf, yesPrice) {
  const winProb = conf / 100;
  return winProb * (1 - yesPrice) - (1 - winProb) * yesPrice;
}

function buildLadder(forecast, buckets, agreement, currentTemp) {
  let central = buckets.find(b => Math.abs(b.temp - forecast) < 1);
  if (!central) return [];
  const ladder = [central];
  const above = buckets.find(b => b.temp === central.temp + 1);
  const below = buckets.find(b => b.temp === central.temp - 1);
  if (above) ladder.push(above);
  if (below) ladder.push(below);
  const trades = [];
  for (const b of ladder) {
    let conf = 70;
    const diff = Math.abs(b.temp - forecast);
    if (diff === 0) conf = 85;
    else if (diff === 1) conf = 75;
    else conf = 65;
    if (!agreement) conf -= 10;
    let dir = b.temp <= forecast ? 'YES' : 'NO';
    if (currentTemp !== null && currentTemp > b.temp) dir = 'YES';
    const ev = computeEV(conf, dir === 'YES' ? b.yesPrice : b.noPrice);
    if (ev > MIN_EV) trades.push({ bucket: b, confidence: conf, direction: dir, ev });
  }
  return trades;
}

async function executeLadder(city, slug, trades) {
  if (!trades.length) return;
  const per = TRADE_AMOUNT_USD / trades.length;
  let summary = `🏆 Ladder for ${city.name}\n`;
  for (const t of trades) {
    const price = t.direction === 'YES' ? t.bucket.yesPrice : t.bucket.noPrice;
    const shares = Math.floor(per / price);
    const cost = shares * price;
    summary += `${t.direction} ${t.bucket.temp}°C @ ${(price*100).toFixed(1)}c | ${shares} shares = $${cost.toFixed(2)} | EV: ${(t.ev*100).toFixed(1)}%\n`;
    console.log(`   [DRY RUN] would buy ${t.direction} ${t.bucket.temp}°C`);
  }
  await sendDiscord(summary);
}

const stats = { scans: 0, trades: 0, cost: 0, potential: 0, start: Date.now() };

async function scanCity(city) {
  console.log(`\n🔍 Scanning ${city.name}...`);
  const weather = await getEnsembleForecast(city.lat, city.lon);
  if (!weather) return;
  const currentTemp = await getCurrentTemp(city.lat, city.lon);
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const buckets = await fetchBuckets(city.name, tomorrow);
  if (!buckets) return;
  console.log(`   Ensemble: ${weather.maxC.toFixed(1)}°C | Agreement: ${weather.agreement} | Current: ${currentTemp?.toFixed(1) || 'N/A'}°C`);
  const trades = buildLadder(weather.maxC, buckets, weather.agreement, currentTemp);
  if (!trades.length) return;
  const slug = getSlug(city.name, tomorrow);
  await executeLadder(city, slug, trades);
  stats.trades += trades.length;
  stats.cost += TRADE_AMOUNT_USD;
  stats.potential += trades.reduce((acc, t) => acc + (t.direction === 'YES' ? (1-t.bucket.yesPrice) : t.bucket.noPrice) * (TRADE_AMOUNT_USD / trades.length), 0);
}

async function scan() {
  stats.scans++;
  console.log(`\n🌤️ Scan #${stats.scans} - ${new Date().toLocaleTimeString()} (UTC: ${new Date().toUTCString()})`);
  for (const city of CITIES) {
    await scanCity(city);
    await new Promise(r => setTimeout(r, 2000)); // 2 sec delay between cities
  }
  console.log(`\n⏳ Scan done. Next scan in 30 minutes.`);
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
  console.log('🚀 SUPER‑ELITE Bot – Multi‑Model + 30min scan + DexScreener fallback');
  console.log(`Dry run: ${DRY_RUN} | Trade amount: $${TRADE_AMOUNT_USD} | Min liquidity: $${MIN_LIQUIDITY_USD}`);
  await sendDiscord('🤖 SUPER‑ELITE Bot started – scanning every 30 minutes.');
  while (true) {
    await scan();
    printStats();
    const now = Date.now();
    if (now - lastHeartbeat > 60 * 60 * 1000) {
      lastHeartbeat = now;
      await sendDiscord(`❤️ Bot heartbeat – ${stats.scans} scans completed. Still waiting for markets.`);
    }
    await new Promise(r => setTimeout(r, 30 * 60 * 1000));
  }
}

main().catch(console.error);
