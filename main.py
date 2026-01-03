#!/usr/bin/env python3
from fastapi import FastAPI
import uvicorn

app = FastAPI(title="ShieldNet P2P", version="1.0.0")

@app.get("/")
def root():
    return {"projet": "ShieldNet", "etudiante": "Rania", "status": "running"}

@app.get("/health")
def health():
    return {"status": "healthy"}

if __name__ == "__main__":
    print("ShieldNet demarre sur http://localhost:8000")
    uvicorn.run(app, host="0.0.0.0", port=8000)