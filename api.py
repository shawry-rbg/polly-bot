from fastapi import FastAPI, Query
import uvicorn
import asyncio
from backend.data.weather import fetch_ensemble_forecast
from backend.core.signals import calculate_kelly_size

app = FastAPI()

@app.get("/ensemble")
async def ensemble(lat: float = Query(...), lon: float = Query(...)):
    forecast = await fetch_ensemble_forecast(lat, lon)
    if not forecast:
        return {"error": "No forecast"}
    return {
        "mean": forecast.mean,
        "confidence": forecast.confidence,
        "members": forecast.members
    }

@app.get("/kelly")
async def kelly(win_prob: float = Query(...), yes_price: float = Query(...), bankroll: float = Query(1000)):
    size = calculate_kelly_size(win_prob, yes_price, bankroll)
    return {"size": size, "fraction": size / bankroll if bankroll else 0}

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8001)
