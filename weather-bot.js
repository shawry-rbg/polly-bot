const axios = require('axios');
const express = require('express');
require('dotenv').config();

const app = express();
app.get('/', (req, res) => res.send('OK'));
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Health check running on port ${port}`));

const MIN_AI_CONFIDENCE = 70;
const DRY_RUN = true;

const SMART_WALLETS = [
  '0xd66a74a449AbcE9dCf7Ad7B5766D4FeBa026f89c', // huskyvs
];
async function getMarketData(cityName) {
  // Try tomorrow first, then today
  const dates = [1, 0]; // 1 = tomorrow, 0 = today
  for (const offset of dates) {
    const date = new Date();
    date.setDate(date.getDate() + offset);
    const targetDate = date.toISOString().slice(0, 10); // YYYY-MM-DD
    const url = `https://data-api.polymarket.com/markets?title=${encodeURIComponent(cityName)}&limit=10`;
    try {
      const response = await axios.get(url);
      const markets = response.data;
      // Find a market that contains the city name AND the target date in endDate
      let market = markets.find(m =>
        m.title?.toLowerCase().includes(cityName.toLowerCase()) &&
        m.endDate?.startsWith(targetDate)
      );
      if (!market) {
        // If no exact date match, take any market with the city name
        market = markets.find(m => m.title?.toLowerCase().includes(cityName.toLowerCase()));
      }
      if (market && market.conditionId) {
        console.log(`✅ Found market: ${market.title}`);
        return { conditionId: market.conditionId, slug: market.slug };
      }
    } catch (error) {
      console.error(`Error searching for ${cityName}: ${error.message}`);
    }
  }
  console.log(`❌ No market found for ${cityName} after trying today and tomorrow`);
  return null;
}
// ---------- FULL CITIES LIST ----------
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
  { name: 'Sao Paulo', lat: -23.55, lon: -46.63 },
  { name: 'Jeddah', lat: 21.54, lon: 39.17 },
  { name: 'Jakarta', lat: -6.21, lon: 106.84 },
  { name: 'San Francisco', lat: 37.77, lon: -122.41 },
  { name: 'Houston', lat: 29.76, lon: -95.38 },
  { name: 'Mexico City', lat: 19.43, lon: -99.13 },
];

async function getWeather(lat, lon) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=temperature_2m_max&current_weather=true&timezone=auto`;
  try {
    const res = await axios.get(url);
    const current = res.data.current_weather.temperature;
    const max = res.data.daily.temperature_2m_max[1];
    return { currentC: current, maxC: max };
  } catch (err) {
    console.error(`Weather error: ${err.message}`);
    return null;
  }
}

function predict(city, weather, market) {
  const forecast = weather.maxC;
  const threshold = market.temp;
  const diff = forecast - threshold;
  const confidence = Math.min(95, Math.max(60, 70 + diff * 5));
  const direction = diff > 0 ? 'YES' : 'NO';
  return { confidence, direction, reasoning: `Forecast ${forecast}°C vs ${threshold}°C` };
}

const stats = { scans: 0, trades: 0, cost: 0, potential: 0, start: Date.now() };

async function scanCity(city) {
  const weather = await getWeather(city.lat, city.lon);
  if (!weather) return;
  console.log(`\n${city.name}: Current ${weather.currentC.toFixed(1)}°C | Forecast max: ${weather.maxC.toFixed(1)}°C`);
  const baseTemp = Math.round(weather.maxC);
  const markets = [
    { temp: baseTemp - 1, yes: 0.35, no: 0.65 },
    { temp: baseTemp,     yes: 0.45, no: 0.55 },
    { temp: baseTemp + 1, yes: 0.20, no: 0.80 },
  ];
  for (const market of markets) {
    const pred = predict(city, weather, market);
    if (pred.confidence < MIN_AI_CONFIDENCE) continue;

    const marketData = await getMarketData(city.name);
    if (!marketData) continue;
    const conditionId = marketData.conditionId;
    const slug = marketData.slug;

    const smartOk = await checkSmartMoneySignal(conditionId);
    if (!smartOk) {
      console.log(`⚠️ Smart money disagrees – skip ${city.name}`);
      continue;
    }
    console.log(`✅ Smart money agrees – trade ${city.name}`);

    const tp = pred.direction === 'YES' ? market.yes : market.no;
    const shares = Math.min(Math.floor(25 / tp), 1000);
    const cost = shares * tp;
    const profit = shares - cost;

    stats.trades++;
    stats.cost += cost;
    stats.potential += profit;

    console.log(`SIGNAL ${city.name} | ${market.temp}°C | ${pred.direction} ${pred.confidence}%`);
    console.log(`${shares}x @ ${(tp*100).toFixed(0)}c = $${cost.toFixed(2)} -> +$${profit.toFixed(2)}`);
    console.log(pred.reasoning);
    console.log(`[DRY RUN] polymarket.com/event/${slug}`);
    await new Promise(r => setTimeout(r, 1000));
  }
}

async function scan() {
  stats.scans++;
  console.log(`\nWeather Scan #${stats.scans} - ${new Date().toLocaleTimeString()}`);
  console.log(`Checking ${CITIES.length} Polymarket cities...`);
  for (const city of CITIES) {
    await scanCity(city);
    await new Promise(r => setTimeout(r, 500));
  }
  console.log(`\nScan done. Next scan in 5 minutes.`);
}

function printStats() {
  const mins = Math.floor((Date.now() - stats.start) / 60000);
  console.log(`\n${'='.repeat(45)}`);
  console.log(`CERTova Weather | ${mins} min | Signals: ${stats.trades}`);
  console.log(`Total at risk: $${stats.cost.toFixed(2)} | Potential: +$${stats.potential.toFixed(2)}`);
  console.log(`${'='.repeat(45)}`);
}

async function main() {
  console.log('CERTova-X Weather Bot - Deterministic predictor + Smart Wallet track');
  console.log(`Cities: ${CITIES.length} | Smart wallets: ${SMART_WALLETS.length} | AEGIS ON`);
  while (true) {
    await scan();
    printStats();
    await new Promise(r => setTimeout(r, 5 * 60 * 1000));
  }
}

main().catch(console.error);
