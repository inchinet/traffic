# HK Bus Predictor (Liquid Glass UI)

A mobile-friendly, "Liquid Glass" styled web application for checking real-time bus arrival times in Hong Kong. Supports KMB, Citybus, and NLB.

![Bus Predictor](https://github.com/inchinet/traffic/blob/main/traffic.png)


## Features

- **Real-time Clock**: Displays current date and time.
- **GPS Location**: Automatically finds nearby bus stops based on your location.
- **Search**: Search for routes by number (e.g., 68X).
- **Favorites**: Save frequently used stops or routes for quick access.
- **ETA Information**: View the next 3 scheduled arrivals for a selected route.
- **Offline Capable Database**: Caches Stop/Route data for performance (requires initial update).

## How to Run

### Option 1: GitHub Pages (Static Hosting)
1. Navigate to the deployed GitHub Pages URL (e.g., `https://<username>.github.io/<repo>/`).
2. The app will attempt to fetch data directly. If CORS issues occur, it falls back to a public proxy (`allorigins.win`).

### Option 2: Local Development (Python Proxy)
To avoid CORS issues during local testing, a simple Python proxy server is included.

1. Double-click `start_server.bat` (Windows) or run `python server.py`.
2. Open `http://localhost:8000` in your browser.

### Option 3: Own Server (PHP Proxy)
If hosting on a PHP-enabled server:
1. Upload all files including `proxy.php`.
2. The app will automatically detect and use `proxy.php` for API requests.

## Data Sources
- [Data.gov.hk](https://data.gov.hk)
- KMB / LWB data
- Citybus data
- New Lantao Bus (NLB) data

## Project Structure
- `index.html`: Main application interface.
- `style.css`: Styling and "Liquid Glass" effects.
- `script.js`: Application logic, IndexedDB management, and API handling.
- `server.py`: Local Python proxy server.
- `proxy.php`: PHP proxy for web hosting.
