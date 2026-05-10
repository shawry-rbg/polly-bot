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
const MODEL_TIMEOUT_MS = 15000;

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
async function sendDiscord(msg) {
  if (!DISCORD_WEBHOOK_URL) return;
  try { await axios.post(DISCORD_WEBHOOK_URL, { content: msg }); } catch(e) {}
}

let notifiedFirstBucket = false;
let lastHeartbeat = 0;

// ---------- Multi-model ensemble (ECMWF, GFS, ICON) ----------
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

function getSlug(cityName, date) {
  const citySlug = cityName.toLowerCase().replace(/ /g, '-');
  const monthNames = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  const month = monthNames[date.getMonth()];
  const day = date.getDate();
  const year = date.getFullYear();
  return `highest-temperature-in-${citySlug}-on-${month}-${day}-${year}`;
}

// ---------- FALLBACK BUCKETS (All Cities) ----------
function getFallbackBuckets(cityName) {
  const cityLower = cityName.toLowerCase();
  const priceMap = {
    'seoul': [
      { temp: 18, yesPrice: 0.23, noPrice: 0.77 },
      { temp: 19, yesPrice: 0.34, noPrice: 0.66 },
      { temp: 20, yesPrice: 0.25, noPrice: 0.75 },
      { temp: 21, yesPrice: 0.15, noPrice: 0.85 },
      { temp: 22, yesPrice: 0.08, noPrice: 0.92 },
      { temp: 23, yesPrice: 0.04, noPrice: 0.96 }
    ],
    'tokyo': [
      { temp: 21, yesPrice: 0.35, noPrice: 0.65 },
      { temp: 22, yesPrice: 0.25, noPrice: 0.75 },
      { temp: 23, yesPrice: 0.20, noPrice: 0.80 },
      { temp: 24, yesPrice: 0.10, noPrice: 0.90 }
    ],
    'shanghai': [
      { temp: 28, yesPrice: 0.15, noPrice: 0.85 },
      { temp: 29, yesPrice: 0.13, noPrice: 0.87 },
      { temp: 30, yesPrice: 0.08, noPrice: 0.92 },
      { temp: 31, yesPrice: 0.04, noPrice: 0.96 }
    ],
    'singapore': [
      { temp: 29, yesPrice: 0.20, noPrice: 0.80 },
      { temp: 30, yesPrice: 0.15, noPrice: 0.85 },
      { temp: 31, yesPrice: 0.08, noPrice: 0.92 },
      { temp: 32, yesPrice: 0.04, noPrice: 0.96 }
    ],
    'hong kong': [
      { temp: 27, yesPrice: 0.20, noPrice: 0.80 },
      { temp: 28, yesPrice: 0.15, noPrice: 0.85 },
      { temp: 29, yesPrice: 0.10, noPrice: 0.90 }
    ],
    'taipei': [
      { temp: 25, yesPrice: 0.20, noPrice: 0.80 },
      { temp: 26, yesPrice: 0.15, noPrice: 0.85 },
      { temp: 27, yesPrice: 0.10, noPrice: 0.90 }
    ],
    'lucknow': [
      { temp: 38, yesPrice: 0.15, noPrice: 0.85 },
      { temp: 39, yesPrice: 0.10, noPrice: 0.90 },
      { temp: 40, yesPrice: 0.05, noPrice: 0.95 }
    ],
    'london': [
      { temp: 12, yesPrice: 0.10, noPrice: 0.90 },
      { temp: 13, yesPrice: 0.15, noPrice: 0.85 },
      { temp: 14, yesPrice: 0.20, noPrice: 0.80 }
    ],
    'paris': [
      { temp: 16, yesPrice: 0.15, noPrice: 0.85 },
      { temp: 17, yesPrice: 0.20, noPrice: 0.80 },
      { temp: 18, yesPrice: 0.25, noPrice: 0.75 }
    ],
    'madrid': [
      { temp: 22, yesPrice: 0.15, noPrice: 0.85 },
      { temp: 23, yesPrice: 0.20, noPrice: 0.80 },
      { temp: 24, yesPrice: 0.25, noPrice: 0.75 }
    ],
    'milan': [
      { temp: 20, yesPrice: 0.15, noPrice: 0.85 },
      { temp: 21, yesPrice: 0.20, noPrice: 0.80 },
      { temp: 22, yesPrice: 0.25, noPrice: 0.75 }
    ],
    'warsaw': [
      { temp: 19, yesPrice: 0.20, noPrice: 0.80 },
      { temp: 20, yesPrice: 0.25, noPrice: 0.75 },
      { temp: 21, yesPrice: 0.30, noPrice: 0.70 }
    ],
    'tel aviv': [
      { temp: 28, yesPrice: 0.20, noPrice: 0.80 },
      { temp: 29, yesPrice: 0.15, noPrice: 0.85 },
      { temp: 30, yesPrice: 0.10, noPrice: 0.90 }
    ],
    'ankara': [
      { temp: 20, yesPrice: 0.20, noPrice: 0.80 },
      { temp: 21, yesPrice: 0.25, noPrice: 0.75 },
      { temp: 22, yesPrice: 0.30, noPrice: 0.70 }
    ],
    'nyc': [
      { temp: 17, yesPrice: 0.15, noPrice: 0.85 },
      { temp: 18, yesPrice: 0.20, noPrice: 0.80 },
      { temp: 19, yesPrice: 0.25, noPrice: 0.75 }
    ],
    'miami': [
      { temp: 29, yesPrice: 0.20, noPrice: 0.80 },
      { temp: 30, yesPrice: 0.25, noPrice: 0.75 },
      { temp: 31, yesPrice: 0.30, noPrice: 0.70 }
    ],
    'chicago': [
      { temp: 10, yesPrice: 0.15, noPrice: 0.85 },
      { temp: 11, yesPrice: 0.20, noPrice: 0.80 },
      { temp: 12, yesPrice: 0.25, noPrice: 0.75 }
    ],
    'dallas': [
      { temp: 24, yesPrice: 0.20, noPrice: 0.80 },
      { temp: 25, yesPrice: 0.25, noPrice: 0.75 },
      { temp: 26, yesPrice: 0.30, noPrice: 0.70 }
    ],
    'atlanta': [
      { temp: 23, yesPrice: 0.20, noPrice: 0.80 },
      { temp: 24, yesPrice: 0.25, noPrice: 0.75 },
      { temp: 25, yesPrice: 0.30, noPrice: 0.70 }
    ],
    'seattle': [
      { temp: 16, yesPrice: 0.15, noPrice: 0.85 },
      { temp: 17, yesPrice: 0.20, noPrice: 0.80 },
      { temp: 18, yesPrice: 0.25, noPrice: 0.75 }
    ],
    'toronto': [
      { temp: 14, yesPrice: 0.15, noPrice: 0.85 },
      { temp: 15, yesPrice: 0.20, noPrice: 0.80 },
      { temp: 16, yesPrice: 0.25, noPrice: 0.75 }
    ],
    'wellington': [
      { temp: 12, yesPrice: 0.15, noPrice: 0.85 },
      { temp: 13, yesPrice: 0.20, noPrice: 0.80 },
      { temp: 14, yesPrice: 0.25, noPrice: 0.75 }
    ],
    'buenos aires': [
      { temp: 16, yesPrice: 0.15, noPrice: 0.85 },
      { temp: 17, yesPrice: 0.20, noPrice: 0.80 },
      { temp: 18, yesPrice: 0.25, noPrice: 0.75 }
    ],
    'sao paulo': [
      { temp: 22, yesPrice: 0.15, noPrice: 0.85 },
      { temp: 23, yesPrice: 0.20, noPrice: 0.80 },
      { temp: 24, yesPrice: 0.25, noPrice: 0.75 }
    ]
  };
  return priceMap[cityLower] || [
    { temp: 22, yesPrice: 0.20, noPrice: 0.80 },
    { temp: 23, yesPrice: 0.15, noPrice: 0.85 }
  ];
}

// ---------- FETCH BUCKETS – Try API first, then fallback ----------
async function fetchBuckets(cityName, targetDate) {
  // Try to get live prices from Polymarket
  try {
    const searchUrl = `https://gamma-api.polymarket.com/markets?limit=200`;
    const response = await axios.get(searchUrl, { timeout: 8000 });
    const market = response.data.find(m => 
      m.question?.toLowerCase().includes(cityName.toLowerCase()) && 
      m.question?.toLowerCase().includes('temperature')
    );
    
    if (market && market.clobTokenIds) {
      const tokenIds = JSON.parse(market.clobTokenIds);
      const outcomes = JSON.parse(market.outcomes);
      const buckets = [];
      
      for (let i = 0; i < tokenIds.length; i++) {
        try {
          const priceUrl = `https://clob.polymarket.com/last-trade-price?id=${tokenIds[i]}`;
          const priceRes = await axios.get(priceUrl, { timeout: 5000 });
          const tempMatch = outcomes[i].match(/(\d+)/);
          
          if (tempMatch && priceRes.data.price) {
            buckets.push({
              temp: parseInt(tempMatch[1]),
              yesPrice: parseFloat(priceRes.data.price),
              noPrice: 1 - parseFloat(priceRes.data.price)
            });
          }
        } catch (err) {}
      }
      
      if (buckets.length > 0) {
        console.log(`   ✅ Live prices from CLOB API`);
        return buckets;
      }
    }
  } catch (err) {
    console.log(`   API error: ${err.message}`);
  }
  
  // Fallback to hardcoded prices
  console.log(`   Using fallback prices for ${cityName}`);
  return getFallbackBuckets(cityName);
}

// ---------- EV, ladder, execution ----------
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

const stats = { scans: 0, trades: 0, cost: 0, potential: 0, start: Date.now() };

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

const CITIES = [
  { name: 'Seoul', lat: 37.46, lon: 126.44 },
  { name: 'Singapore', lat: 1.29, lon: 103.85 },
  { name: 'Tokyo', lat: 35.68, lon: 139.69 },
  { name: 'Shanghai', lat: 31.14, lon: 121.80 },
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
  console.log('🚀 Elite Bot – CLOB API + Fallback');
  console.log(`Dry run: ${DRY_RUN} | Trade amount: $${TRADE_AMOUNT_USD}`);
  await sendDiscord('🤖 Bot started – Scanning for mispriced weather markets.');
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
