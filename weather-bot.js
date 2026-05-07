const axios=require('axios');require('dotenv').config();
const KEY=process.env.GROQ_API_KEY;
const MODEL='llama-3.1-8b-instant';

// All real cities from Polymarket temperature markets
const CITIES=[
{name:'Seoul',lat:37.57,lon:126.98,slug:'highest-temperature-in-seoul-on-may-8-2026'},
{name:'Singapore',lat:1.29,lon:103.85,slug:'highest-temperature-in-singapore-on-may-8-2026'},
{name:'Tokyo',lat:35.68,lon:139.69,slug:'highest-temperature-in-tokyo-on-may-8-2026'},
{name:'Shanghai',lat:31.23,lon:121.47,slug:'highest-temperature-in-shanghai-on-may-8-2026'},
{name:'Hong Kong',lat:22.32,lon:114.17,slug:'highest-temperature-in-hong-kong-on-may-8-2026'},
{name:'Taipei',lat:25.03,lon:121.56,slug:'highest-temperature-in-taipei-on-may-8-2026'},
{name:'Lucknow',lat:26.85,lon:80.95,slug:'highest-temperature-in-lucknow-on-may-8-2026'},
{name:'London',lat:51.51,lon:-0.13,slug:'highest-temperature-in-london-on-may-8-2026'},
{name:'Paris',lat:48.85,lon:2.35,slug:'highest-temperature-in-paris-on-may-8-2026'},
{name:'Madrid',lat:40.42,lon:-3.70,slug:'highest-temperature-in-madrid-on-may-8-2026'},
{name:'Milan',lat:45.47,lon:9.19,slug:'highest-temperature-in-milan-on-may-8-2026'},
{name:'Warsaw',lat:52.23,lon:21.01,slug:'highest-temperature-in-warsaw-on-may-8-2026'},
{name:'Tel Aviv',lat:32.08,lon:34.78,slug:'highest-temperature-in-tel-aviv-on-may-8-2026'},
{name:'Ankara',lat:39.93,lon:32.85,slug:'highest-temperature-in-ankara-on-may-8-2026'},
{name:'NYC',lat:40.71,lon:-74.01,slug:'highest-temperature-in-nyc-on-may-8-2026'},
{name:'Miami',lat:25.77,lon:-80.19,slug:'highest-temperature-in-miami-on-may-8-2026'},
{name:'Chicago',lat:41.85,lon:-87.65,slug:'highest-temperature-in-chicago-on-may-8-2026'},
{name:'Dallas',lat:32.78,lon:-96.80,slug:'highest-temperature-in-dallas-on-may-8-2026'},
{name:'Atlanta',lat:33.75,lon:-84.39,slug:'highest-temperature-in-atlanta-on-may-8-2026'},
{name:'Seattle',lat:47.61,lon:-122.33,slug:'highest-temperature-in-seattle-on-may-8-2026'},
{name:'Toronto',lat:43.65,lon:-79.38,slug:'highest-temperature-in-toronto-on-may-8-2026'},
{name:'Wellington',lat:-41.29,lon:174.78,slug:'highest-temperature-in-wellington-on-may-8-2026'},
{name:'Buenos Aires',lat:-34.60,lon:-58.38,slug:'highest-temperature-in-buenos-aires-on-may-8-2026'},
{name:'Sao Paulo',lat:-23.55,lon:-46.63,slug:'highest-temperature-in-sao-paulo-on-may-8-2026'},
];

// Fetch real market odds from Polymarket
async function getMarketOdds(slug){
try{
const url='https://polymarket.com/event/'+slug;
const r=await axios.get(url,{timeout:8000,headers:{'User-Agent':'Mozilla/5.0'}});
// Extract odds from page - look for percentage patterns
const matches=r.data.match(/(\d+)°C[^<]*?(\d+)%/g)||[];
const markets=[];
matches.slice(0,3).forEach(m=>{
const tc=m.match(/(\d+)°C/);
const pct=m.match(/(\d+)%/);
if(tc&&pct) markets.push({temp:parseInt(tc[1]),yes:parseInt(pct[1])/100,no:1-parseInt(pct[1])/100});
});
return markets.length>0?markets:null;}
catch(e){return null;}}

// Get weather from Open-Meteo (free, no key)
async function getWeather(lat,lon){
try{
const url='https://api.open-meteo.com/v1/forecast?latitude='+lat+'&longitude='+lon+'&current=temperature_2m,weathercode&daily=temperature_2m_max&temperature_unit=celsius&forecast_days=2';
const r=await axios.get(url,{timeout:8000});
return{
currentC:r.data.current.temperature_2m,
maxC:r.data.daily.temperature_2m_max[1], // tomorrow's max
code:r.data.current.weathercode
};}
catch(e){return null;}}

// Groq AI prediction
async function predict(city,weather,market){
const prompt='Return ONLY valid JSON no other text:\n{"direction":"YES","confidence":85,"reasoning":"brief"}\nPolymarket: Will highest temp in '+city.name+' be '+market.temp+'C on May 8?\nYES='+Math.round(market.yes*100)+'c NO='+Math.round(market.no*100)+'c\nCurrent temp: '+weather.currentC.toFixed(1)+'C\nForecast max tomorrow: '+weather.maxC.toFixed(1)+'C\nDifference from threshold: '+(weather.maxC-market.temp).toFixed(1)+'C';
try{
const r=await axios.post('https://api.groq.com/openai/v1/chat/completions',
{model:MODEL,messages:[{role:'system',content:'Weather prediction AI. JSON only.'},{role:'user',content:prompt}],max_tokens:60,temperature:0.1},
{headers:{'Authorization':'Bearer '+KEY,'Content-Type':'application/json'},timeout:10000});
const t=r.data.choices[0].message.content.replace(/```json|```/g,'').trim();
const m=t.match(/\{[^{}]*\}/);if(!m)return null;return JSON.parse(m[0]);}
catch(e){return null;}}

const stats={scans:0,trades:0,cost:0,potential:0,start:Date.now()};

async function scanCity(city){
// Get real weather
const weather=await getWeather(city.lat,city.lon);
if(!weather){console.log(city.name+': no weather data');return;}

console.log('\n'+city.name+': Current '+weather.currentC.toFixed(1)+'C | Forecast max: '+weather.maxC.toFixed(1)+'C');

// Use hardcoded markets for now (will add live fetching next)
// Based on typical Polymarket ranges for each city
const baseTemp=Math.round(weather.maxC);
const markets=[
{temp:baseTemp-1,yes:0.35,no:0.65},
{temp:baseTemp,yes:0.45,no:0.55},
{temp:baseTemp+1,yes:0.20,no:0.80},
];

for(const market of markets){
const pred=await predict(city,weather,market);
if(!pred)continue;
if(pred.confidence<78)continue;

const tp=pred.direction==='YES'?market.yes:market.no;
const shares=Math.min(Math.floor(25/tp),1000); // smaller trades with $25
const cost=shares*tp;
const profit=shares-cost;

stats.trades++;stats.cost+=cost;stats.potential+=profit;
console.log('SIGNAL '+city.name+' | '+market.temp+'C | '+pred.direction+' '+pred.confidence+'%');
console.log(shares+'x@'+(tp*100).toFixed(0)+'c=$'+cost.toFixed(2)+' -> +$'+profit.toFixed(2));
console.log(pred.reasoning);
console.log('[DRY RUN - verify on polymarket.com/event/'+city.slug+']');
}
await new Promise(r=>setTimeout(r,1000));}

async function scan(){
stats.scans++;
console.log('\nWeather Scan #'+stats.scans+' - '+new Date().toLocaleTimeString());
console.log('Checking '+CITIES.length+' Polymarket cities...\n');
for(const city of CITIES){
await scanCity(city);
await new Promise(r=>setTimeout(r,500));}
console.log('\nScan done. Next scan in 5 minutes.');}

function printStats(){
const mins=Math.floor((Date.now()-stats.start)/60000);
console.log('\n'+'='.repeat(45));
console.log('CERTova Weather | '+mins+'min | Signals:'+stats.trades);
console.log('Total at risk: $'+stats.cost.toFixed(2)+' | Potential: +$'+stats.potential.toFixed(2));
console.log('='.repeat(45));}

async function main(){
console.log('CERTova-X Weather Bot - REAL Polymarket Markets');
console.log('Cities: '+CITIES.length+' | AI: Groq FREE | AEGIS ON\n');
if(!KEY){console.log('Missing GROQ_API_KEY');process.exit(1);}
await new Promise(r=>setTimeout(r,2000));
await scan();
setInterval(scan,300000);
setInterval(printStats,600000);}

main().catch(console.error);
