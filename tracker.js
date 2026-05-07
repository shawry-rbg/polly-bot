const axios=require('axios');const fs=require('fs');require('dotenv').config();
const KEY=process.env.GROQ_API_KEY;
const MODEL='llama-3.1-8b-instant';
const DB='predictions.json';

// ============================================================
// PREDICTION DATABASE
// ============================================================
function loadDB(){
try{return JSON.parse(fs.readFileSync(DB,'utf8'));}
catch(e){return{predictions:[],stats:{total:0,correct:0,wrong:0,pending:0,winRate:0}};}
}

function saveDB(db){fs.writeFileSync(DB,JSON.stringify(db,null,2));}

function savePrediction(city,threshold,direction,confidence,forecast,marketYes,marketNo){
const db=loadDB();
const pred={
id:Date.now(),
date:new Date().toISOString().split('T')[0],
time:new Date().toLocaleTimeString(),
city,threshold,direction,confidence,
forecast:parseFloat(forecast.toFixed(1)),
marketYes,marketNo,
status:'pending',
actualTemp:null,
correct:null
};
db.predictions.push(pred);
db.stats.total++;
db.stats.pending++;
saveDB(db);
return pred.id;}

function updateResult(id,actualTemp,threshold,direction){
const db=loadDB();
const pred=db.predictions.find(p=>p.id===id);
if(!pred||pred.status!=='pending')return;
pred.actualTemp=actualTemp;
pred.status='resolved';
// Check if prediction was correct
const reached=actualTemp>=threshold;
pred.correct=(direction==='YES'&&reached)||(direction==='NO'&&!reached);
if(pred.correct)db.stats.correct++;
else db.stats.wrong++;
db.stats.pending--;
db.stats.winRate=db.stats.total>0?
Math.round((db.stats.correct/(db.stats.correct+db.stats.wrong))*100):0;
saveDB(db);
return pred;}

function printStats(){
const db=loadDB();
const s=db.stats;
console.log('\n'+'='.repeat(50));
console.log('ACCURACY TRACKER REPORT');
console.log('='.repeat(50));
console.log('Total predictions: '+s.total);
console.log('Correct: '+s.correct+' | Wrong: '+s.wrong+' | Pending: '+s.pending);
console.log('Win Rate: '+s.winRate+'%');
console.log('\nRecent predictions:');
const recent=db.predictions.slice(-10).reverse();
recent.forEach(p=>{
const status=p.status==='pending'?'⏳ PENDING':p.correct?'✅ CORRECT':'❌ WRONG';
console.log(status+' | '+p.date+' | '+p.city+' '+p.threshold+'C | '+p.direction+' '+p.confidence+'% | Forecast:'+p.forecast+'C'+(p.actualTemp?' | Actual:'+p.actualTemp+'C':''));
});
console.log('='.repeat(50));
return db.stats;}

// ============================================================
// CITIES
// ============================================================
const CITIES=[
{name:'Seoul',lat:37.57,lon:126.98},
{name:'Singapore',lat:1.29,lon:103.85},
{name:'Tokyo',lat:35.68,lon:139.69},
{name:'Shanghai',lat:31.23,lon:121.47},
{name:'Hong Kong',lat:22.32,lon:114.17},
{name:'London',lat:51.51,lon:-0.13},
{name:'Paris',lat:48.85,lon:2.35},
{name:'NYC',lat:40.71,lon:-74.01},
{name:'Miami',lat:25.77,lon:-80.19},
{name:'Chicago',lat:41.85,lon:-87.65},
{name:'Dubai',lat:25.20,lon:55.27},
{name:'Sydney',lat:-33.87,lon:151.21},
];

// ============================================================
// WEATHER
// ============================================================
async function getWeather(lat,lon){
try{
const url='https://api.open-meteo.com/v1/forecast?latitude='+lat+'&longitude='+lon+'&current=temperature_2m&daily=temperature_2m_max&temperature_unit=celsius&forecast_days=2';
const r=await axios.get(url,{timeout:8000});
return{
currentC:r.data.current.temperature_2m,
maxTodayC:r.data.daily.temperature_2m_max[0],
maxTomorrowC:r.data.daily.temperature_2m_max[1]
};}
catch(e){return null;}}

// ============================================================
// GROQ AI
// ============================================================
async function predict(city,weather,threshold){
const diff=weather.maxTomorrowC-threshold;
const prompt='Return ONLY valid JSON:\n{"direction":"YES","confidence":85,"reasoning":"brief"}\nWill highest temp in '+city.name+' reach '+threshold+'C tomorrow?\nForecast max: '+weather.maxTomorrowC.toFixed(1)+'C\nDifference: '+diff.toFixed(1)+'C\nYES if reaches '+threshold+'C, NO if stays below.';
try{
const r=await axios.post('https://api.groq.com/openai/v1/chat/completions',
{model:MODEL,messages:[{role:'system',content:'Weather AI. JSON only.'},{role:'user',content:prompt}],max_tokens:60,temperature:0.1},
{headers:{'Authorization':'Bearer '+KEY,'Content-Type':'application/json'},timeout:10000});
const t=r.data.choices[0].message.content.replace(/```json|```/g,'').trim();
const m=t.match(/\{[^{}]*\}/);if(!m)return null;return JSON.parse(m[0]);}
catch(e){return null;}}

// ============================================================
// CHECK YESTERDAY'S PREDICTIONS
// ============================================================
async function checkYesterdayResults(){
const db=loadDB();
const yesterday=new Date();
yesterday.setDate(yesterday.getDate()-1);
const yDate=yesterday.toISOString().split('T')[0];
const pending=db.predictions.filter(p=>p.status==='pending'&&p.date===yDate);
if(pending.length===0)return;
console.log('\nChecking '+pending.length+' predictions from yesterday...');
for(const pred of pending){
const city=CITIES.find(c=>c.name===pred.city);
if(!city)continue;
const weather=await getWeather(city.lat,city.lon);
if(!weather)continue;
// Use today's max as yesterday's actual result
const actual=weather.maxTodayC;
const result=updateResult(pred.id,actual,pred.threshold,pred.direction);
if(result){
console.log((result.correct?'✅':'❌')+' '+pred.city+' '+pred.threshold+'C | Predicted: '+pred.direction+' | Actual: '+actual.toFixed(1)+'C | '+(result.correct?'CORRECT':'WRONG'));
}
await new Promise(r=>setTimeout(r,500));}}

// ============================================================
// MAIN SCAN
// ============================================================
const trackedIds=[];

async function scan(){
console.log('\nScan - '+new Date().toLocaleTimeString()+' | Tracking accuracy...\n');

// First check yesterday's results
await checkYesterdayResults();

for(const city of CITIES){
const weather=await getWeather(city.lat,city.lon);
if(!weather){console.log(city.name+': no data');continue;}

const baseTemp=Math.round(weather.maxTomorrowC);
console.log(city.name+': Forecast max tomorrow: '+weather.maxTomorrowC.toFixed(1)+'C');

// Test 3 thresholds around forecast
for(const threshold of[baseTemp-1,baseTemp,baseTemp+1]){
const pred=await predict(city,weather,threshold);
if(!pred||pred.confidence<78)continue;

// Save to tracker
const id=savePrediction(
city.name,threshold,pred.direction,
pred.confidence,weather.maxTomorrowC,0.45,0.55);

console.log('TRACKED #'+id+' | '+city.name+' '+threshold+'C | '+pred.direction+' '+pred.confidence+'%');
console.log('Forecast: '+weather.maxTomorrowC.toFixed(1)+'C vs threshold: '+threshold+'C (diff: '+(weather.maxTomorrowC-threshold).toFixed(1)+'C)');
console.log(pred.reasoning);
console.log('Will verify tomorrow automatically!\n');
}
await new Promise(r=>setTimeout(r,1500));}

// Print current stats
printStats();}

async function main(){
console.log('CERTova-X Accuracy Tracker');
console.log('Every prediction saved & verified automatically\n');
if(!KEY){console.log('Missing GROQ_API_KEY');process.exit(1);}
await new Promise(r=>setTimeout(r,2000));
await scan();
// Scan every 6 hours
setInterval(scan,21600000);
// Print stats every hour
setInterval(printStats,3600000);}

main().catch(console.error);
