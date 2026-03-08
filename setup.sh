#!/bin/bash
echo "=== Dialectic Setup ==="
cd backend && pip install -r requirements.txt
cd ../frontend && npm install
echo ""
echo "DONE. Now create backend/.env with your API keys."
echo "Copy backend/.env.example to backend/.env and fill in keys."
