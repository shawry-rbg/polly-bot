const axios = require('axios');
const express = require('express');
require('dotenv').config();

const app = express();
app.get('/', (req, res) => res.send('OK'));
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Health check running on port ${port}`));

const KEY = process.env.GROQ_API_KEY;
const MODEL = 'llama-3.1-8b-instant';
const MIN_AI_CONFIDENCE = 78;
const DRY_RUN = true;

// ---------- SMART WALLETS ----------
const SMART_WALLETS = [
  '0xd66a74a449AbcE9dCf7Ad7B5766D4FeBa026f89c', // huskyvs
];

async function getConditionId(slug) {
  const url = `https://data-api.polymarket.com/markets?slug=${slug}`;
  try {
    const res = await axios.get(url);
    return res.data[0]?.conditionId || null;
  } catch (err) {
    console.error(`Error fetching conditionId: ${err.message}`);
    return null;
  }
}

async function checkSmartMoneySignal(conditionId) {
  if (!conditionId) return false;
  const url = `https://data-api.polymarket.com/positions?condition_id=${conditionId}&limit=10&sort_by=position_size&sort_direction=desc`;
  try {
    const res = await axios.get(url);
    const topHolders = res.data.map(p => p.user_address.toLowerCase());
    for (const wallet of SMART_WALLETS) {
      if (topHolders.includes(wallet.toLowerCase())) {
        console.log(`✅ Smart wallet ${wallet.slice(0,6)} in top holders`);
        return true;
      }
    }
    console.log(`❌ No smart wallet in top holders`);
    return false;
  } catch (err) {
    console.error(`Smart money error: ${err.message}`);
    return false;
  }
}

// ---------- YOUR ORIGINAL CITIES (add full list) ----------
const CITIES = [
  { name: 'Seoul', lat: 37.57, lon: 126.98, slug: 'highest-temperature-in-seoul-on-may-8-2026' },
  { name: 'Singapore', lat: 1.29, lon: 103.85, slug: 'highest-temperature-in-singapore-on-may-8-2026' },
  // ... add all your cities
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

async function predict(city, weather, market) {
  const prompt = `City: ${city.name}. Current temp: ${weather.currentC}°C, forecast max tomorrow: ${weather.maxC}°C. Market: will max temp be ${market.temp}°C? Return ONLY JSON: {"direction":"YES","confidence":85,"reasoning":"brief"}`;
  try {
    const res = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
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
    const content = res.data.choices[0].message.content;
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
  const weather = await getWeather(city.lat, city.lon);
  if (!weather) {
    console.log(`${city.name}: no weather data`);
    return;
  }
  console.log(`\n${city.name}: Current ${weather.currentC.toFixed(1)}°C | Forecast max: ${weather.maxC.toFixed(1)}°C`);
  const baseTemp = Math.round(weather.maxC);
  const markets = [
    { temp: baseTemp - 1, yes: 0.35, no: 0.65 },
    { temp: baseTemp,     yes: 0.45, no: 0.55 },
    { temp: baseTemp + 1, yes: 0.20, no: 0.80 },
  ];
  for (const market of markets) {
    await new Promise(r => setTimeout(r, 2000));
    const pred = await predict(city, weather, market);
    if (!pred) continue;
    if (pred.confidence < MIN_AI_CONFIDENCE) continue;

    // ----- SMART MONEY CHECK -----
    const conditionId = await getConditionId(city.slug);
    if (!conditionId) {
      console.log(`⚠️ No conditionId for ${city.name}, skipping`);
      continue;
    }
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
    console.log(`[DRY RUN] polymarket.com/event/${city.slug}`);
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
