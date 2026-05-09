const axios = require('axios');
const express = require('express');
require('dotenv').config();

const app = express();
app.get('/', (req, res) => res.send('OK'));
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Health check running on port ${port}`));

const KEY = process.env.GROQ_API_KEY;
const MODEL = 'llama-3.1-8b-instant';
const MIN_AI_CONFIDENCE = 70;
const DRY_RUN = true;   // set false when ready to trade real money

// ---------- CITIES (update lat/lon as needed) ----------
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
];

// ---------- Helper: build slug for a city and date (tomorrow) ----------
function getSlug(cityName, date) {
  const citySlug = cityName.toLowerCase().replace(/ /g, '-');
  const monthNames = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const month = monthNames[date.getMonth()];
  const day = date.getDate();
  const year = date.getFullYear();
  return `highest-temperature-in-${citySlug}-on-${month}-${day}-${year}`;
}

// ---------- Weather from Open-Meteo (tomorrow's forecast) ----------
async function getWeather(lat, lon) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=temperature_2m_max&current_weather=true&timezone=auto`;
  try {
    const res = await axios.get(url);
    const current = res.data.current_weather.temperature;
    const max = res.data.daily.temperature_2m_max[1]; // tomorrow's max
    return { currentC: current, maxC: max };
  } catch (err) {
    console.error(`Weather error: ${err.message}`);
    return null;
  }
}

// ---------- Fetch live market prices (YES prices for all buckets) ----------
async function fetchLiveMarkets(slug, baseTemp) {
  const url = `https://gamma-api.polymarket.com/markets?slug=${slug}&limit=1`;
  try {
    const res = await axios.get(url);
    const market = res.data[0];
    if (!market || !market.outcomes || !market.outcomePrices) return null;
    const outcomes = JSON.parse(market.outcomes);   // e.g. ["12°C or below", "13°C", ..., "22°C or higher"]
    const prices = JSON.parse(market.outcomePrices); // YES prices for each outcome (as strings)
    // Extract numeric threshold from each outcome
    const thresholds = outcomes.map(outcome => {
      const match = outcome.match(/(\d+)/);
      return match ? parseInt(match[1], 10) : null;
    });
    // We want to return three markets around baseTemp: baseTemp-1, baseTemp, baseTemp+1
    // but using the actual threshold that is closest to each desired value.
    const desired = [baseTemp - 1, baseTemp, baseTemp + 1];
    const result = [];
    for (const d of desired) {
      let bestIdx = -1;
      let bestDiff = Infinity;
      for (let i = 0; i < thresholds.length; i++) {
        if (thresholds[i] === null) continue;
        const diff = Math.abs(thresholds[i] - d);
        if (diff < bestDiff) {
          bestDiff = diff;
          bestIdx = i;
        }
      }
      if (bestIdx !== -1) {
        const yesPrice = parseFloat(prices[bestIdx]);
        const noPrice = 1 - yesPrice;
        result.push({ temp: thresholds[bestIdx], yes: yesPrice, no: noPrice });
      } else {
        // fallback to dummy (should not happen)
        result.push({ temp: d, yes: 0.45, no: 0.55 });
      }
    }
    return result;
  } catch (error) {
    console.error(`Live markets error for ${slug}: ${error.message}`);
    return null;
  }
}

// ---------- AI prediction (Groq) ----------
async function predict(city, weather, market) {
  const prompt = `City: ${city.name}. Current temp: ${weather.currentC.toFixed(1)}°C, forecast max tomorrow: ${weather.maxC.toFixed(1)}°C. Market: will max temp be ${market.temp}°C? Return ONLY JSON: {"direction":"YES","confidence":85,"reasoning":"brief"}`;
  try {
    const response = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
      model: MODEL,
      messages: [
        { role: 'system', content: 'Weather prediction AI. Return only valid JSON.' },
        { role: 'user', content: prompt }
      ],
      max_tokens: 1024,
      temperature: 0.3
    }, {
      headers: { 'Authorization': `Bearer ${KEY}`, 'Content-Type': 'application/json' }
    });
    const content = response.data.choices[0].message.content;
    const match = content.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      return { confidence: parsed.confidence, direction: parsed.direction, reasoning: parsed.reasoning };
    }
  } catch (err) {
    console.error(`Groq error for ${city.name}: ${err.message}`);
  }
  return null;
}

const stats = { scans: 0, trades: 0, cost: 0, potential: 0, start: Date.now() };

async function scanCity(city) {
  // Get weather
  const weather = await getWeather(city.lat, city.lon);
  if (!weather) return;
  console.log(`\n${city.name}: Current ${weather.currentC.toFixed(1)}°C | Forecast max: ${weather.maxC.toFixed(1)}°C`);

  const baseTemp = Math.round(weather.maxC);
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const slug = getSlug(city.name, tomorrow);

  // Fetch live markets
  let markets = await fetchLiveMarkets(slug, baseTemp);
  if (!markets) {
    console.log(`⚠️ Could not fetch live markets for ${city.name}, using fallback hardcoded prices`);
    markets = [
      { temp: baseTemp - 1, yes: 0.35, no: 0.65 },
      { temp: baseTemp,     yes: 0.45, no: 0.55 },
      { temp: baseTemp + 1, yes: 0.20, no: 0.80 },
    ];
  } else {
    console.log(`✅ Fetched live prices for ${city.name}`);
  }

  for (const market of markets) {
    const pred = await predict(city, weather, market);
    if (!pred) continue;
    if (pred.confidence < MIN_AI_CONFIDENCE) continue;

    // Trade execution (dry‑run or real)
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
  console.log('CERTova-X Weather Bot - REAL Polymarket Markets');
  console.log(`Cities: ${CITIES.length} | AI: Groq FREE | AEGIS ON`);
  if (!KEY) {
    console.log('Missing GROQ_API_KEY');
    process.exit(1);
  }
  while (true) {
    await scan();
    printStats();
    await new Promise(r => setTimeout(r, 5 * 60 * 1000));
  }
}

main().catch(console.error);
