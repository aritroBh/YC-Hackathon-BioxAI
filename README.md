# Dialectic
Bio x AI Hackathon — YC HQ

## Setup
1. Clone repo
2. Run: chmod +x setup.sh && ./setup.sh
3. Copy backend/.env.example to backend/.env and add your keys
4. Terminal 1: cd backend && .venv/bin/uvicorn main:app --host 127.0.0.1 --port 8000
5. Terminal 2: cd frontend && npm run dev
6. Open http://localhost:5173

## Start Servers
# Backend
cd backend && .venv/bin/uvicorn main:app --host 127.0.0.1 --port 8000

# Frontend
cd frontend && npm run dev
