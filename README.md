# Zoning Envelopes Starter Web App

Starter public-facing app for NYC lot lookup + zoning envelope exploration.

## Stack
- Frontend: static HTML/CSS/JS + Mapbox GL JS
- Backend: FastAPI (Python)
- Data source: NYC Open Data PLUTO (BBL lookup)

## Quick Start (Windows PowerShell)

1. Create and activate venv

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
```

2. Install dependencies

```powershell
pip install -r requirements.txt
```

3. Set Mapbox token in local config

- Copy `web/config.example.js` to `web/config.js`
- Put your token in `window.APP_CONFIG.mapboxToken`

4. Start backend server

```powershell
uvicorn backend.main:app --reload
```

5. Open app

- http://127.0.0.1:8000

## Endpoints
- `GET /api/health`
- `GET /api/lot/{borough}/{block}/{lot}`
- `POST /api/envelope`

## Notes
- This is a starter scaffold. Envelope math is intentionally simplified and should be replaced with your full Rhino zoning logic port.
- Keep `web/config.js` untracked so the token is not committed.
