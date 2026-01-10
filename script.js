// DOM Elements
const datetimeEl = document.getElementById('datetime');
const statusMsg = document.getElementById('nearby-status');
const nearbyList = document.getElementById('nearby-list');
const dbStatus = document.getElementById('db-status');
const updateBtn = document.getElementById('update-btn');

// State
let db = null;
let currentTab = 'nearby';
let cachedStops = []; // Memory cache for fast GPS lookup
let userLocation = null;
let isDBLoading = true; // Fix race condition

// Clock
function updateClock() {
    const now = new Date();
    const dateStr = now.getFullYear() + '/' +
        String(now.getMonth() + 1).padStart(2, '0') + '/' +
        String(now.getDate()).padStart(2, '0');
    const timeStr = String(now.getHours()).padStart(2, '0') + ':' +
        String(now.getMinutes()).padStart(2, '0') + ':' +
        String(now.getSeconds()).padStart(2, '0');
    datetimeEl.innerHTML = `${dateStr}<br>${timeStr}`;
}
setInterval(updateClock, 1000);
updateClock();

// --- IndexedDB ---
const DB_NAME = 'HKBusDB';
const DB_VERSION = 1;

function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onerror = (event) => {
            console.error("DB Error", event);
            dbStatus.textContent = "DB: Error";
            reject(event);
        };

        request.onsuccess = (event) => {
            db = event.target.result;
            dbStatus.textContent = "DB: Ready";
            checkDBData();
            resolve(db);
        };

        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains('stops')) {
                const stopStore = db.createObjectStore('stops', { keyPath: 'uniqueId' });
                stopStore.createIndex('lat', 'lat', { unique: false });
                stopStore.createIndex('long', 'long', { unique: false });
            }
            if (!db.objectStoreNames.contains('routes')) {
                const routeStore = db.createObjectStore('routes', { keyPath: 'uniqueId' }); // composite key
                routeStore.createIndex('route', 'route', { unique: false });
            }
        };
    });
}

async function checkDBData() {
    const stopCount = await getCount('stops');
    const routeCount = await getCount('routes');
    if (stopCount > 0) {
        dbStatus.textContent = `DB: Ready (${stopCount} stops, ${routeCount} routes)`;
        // Load stops into memory for fast GPS calc
        loadStopsToMemory();
    } else {
        dbStatus.textContent = "DB: Empty (Please Update)";
        isDBLoading = false; // No data to load
    }
}

function getCount(storeName) {
    return new Promise((resolve) => {
        const tx = db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const req = store.count();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(0);
    });
}

function loadStopsToMemory() {
    const tx = db.transaction('stops', 'readonly');
    const store = tx.objectStore('stops');
    const req = store.getAll();
    req.onsuccess = () => {
        cachedStops = req.result;
        isDBLoading = false; // Loaded!
        console.log(`Loaded ${cachedStops.length} stops to memory`);
        // If we were waiting for GPS, trigger update
        if (currentTab === 'nearby' && userLocation) {
            updateNearbyList(userLocation);
        }
    };
}

// --- API Helper with Proxy Fallback ---
async function fetchWithFallback(url, label) {
    // 1. URLs
    const pythonProxy = '/api/proxy?url=' + encodeURIComponent(url);
    const phpProxy = 'proxy.php?url=' + encodeURIComponent(url);
    const publicProxy = 'https://api.allorigins.win/raw?url=' + encodeURIComponent(url);

    // Helper to try a specific fetch
    const tryFetch = async (target, name) => {
        const res = await fetch(target);
        if (!res.ok) throw new Error(`${name} Status ${res.status}`);
        return await res.json();
    };

    // 2. Execution Chain logic

    // A. Check for constant LOCAL override (Python Server)
    const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    if (isLocalhost) {
        try { return await tryFetch(pythonProxy, "Python Proxy"); } catch (e) { }
    }

    // B. Check for PHP Proxy (Standard Web Host)
    try { return await tryFetch(phpProxy, "PHP Proxy"); } catch (e) { }

    // C. Direct (Mobile App / Permissive CORS)
    try { return await tryFetch(url, "Direct"); } catch (e) { }

    // D. Public Proxy (Last Resort)
    console.warn(`[${label}] All local methods failed. Retrying Public Proxy...`);
    dbStatus.textContent = `${label}: Adapting connection...`;

    try {
        return await tryFetch(publicProxy, "Public Proxy");
    } catch (e4) {
        console.error(`[${label}] All fetch methods failed.`);
        throw new Error(`Connection Failed: ${e4.message}`);
    }
}

// --- API & Data Update ---

async function updateDatabase() {
    updateBtn.disabled = true;
    updateBtn.textContent = "Connecting...";
    dbStatus.textContent = "Connecting to server...";

    let stats = { kmbStops: 0, kmbRoutes: 0, ctb: 0, nlb: 0 };
    let errors = [];

    try {
        // 1. KMB Stops
        dbStatus.textContent = "Downloading KMB Stops... (1/4)";
        try {
            const data = await fetchWithFallback('https://data.etabus.gov.hk/v1/transport/kmb/stop', 'KMB Stops');
            const stops = data.data.map(s => ({
                uniqueId: `KMB-${s.stop}`,
                id: s.stop,
                code: s.stop,
                name_en: s.name_en,
                name_tc: s.name_tc,
                lat: parseFloat(s.lat),
                long: parseFloat(s.long),
                company: 'KMB'
            }));
            await clearStore('stops');
            await bulkAdd('stops', stops);
            stats.kmbStops = stops.length;
        } catch (e) {
            errors.push("KMB Stops: " + e.message);
        }

        // 2. KMB Routes
        dbStatus.textContent = "Downloading KMB Routes... (2/4)";
        let kmbRoutesData = [];
        try {
            const data = await fetchWithFallback('https://data.etabus.gov.hk/v1/transport/kmb/route', 'KMB Routes');
            kmbRoutesData = data.data.map(r => ({
                uniqueId: `KMB-${r.route}-${r.service_type}`,
                route: r.route,
                dest_en: r.dest_en,
                dest_tc: r.dest_tc,
                orig_en: r.orig_en,
                orig_tc: r.orig_tc,
                company: 'KMB'
            }));
            stats.kmbRoutes = kmbRoutesData.length;
        } catch (e) {
            errors.push("KMB Routes: " + e.message);
        }

        // 3. CTB Routes
        dbStatus.textContent = "Downloading CTB Routes... (3/4)";
        let ctbRoutesData = [];
        try {
            const data = await fetchWithFallback('https://rt.data.gov.hk/v2/transport/citybus/route/CTB', 'CTB Routes');
            if (data.data) {
                ctbRoutesData = data.data.map(r => ({
                    uniqueId: `CTB-${r.route}`,
                    route: r.route,
                    dest_en: r.dest_en,
                    dest_tc: r.dest_tc,
                    orig_en: r.orig_en,
                    orig_tc: r.orig_tc,
                    company: 'CTB'
                }));
            }
            stats.ctb = ctbRoutesData.length;
        } catch (e) {
            errors.push("CTB Routes: " + e.message);
        }

        // 4. NLB Routes
        dbStatus.textContent = "Downloading NLB Routes... (4/4)";
        let nlbRoutesData = [];
        try {
            // NLB V2 uses route.php?action=list
            const data = await fetchWithFallback('https://rt.data.gov.hk/v2/transport/nlb/route.php?action=list', 'NLB Routes');
            if (data.routes) {
                nlbRoutesData = data.routes.map(r => ({
                    uniqueId: `NLB-${r.routeId}`,
                    route: r.routeNo,
                    dest_en: r.destName_e,
                    dest_tc: r.destName_c,
                    orig_en: r.originName_e,
                    orig_tc: r.originName_c,
                    nlbId: r.routeId,
                    company: 'NLB'
                }));
            }
            stats.nlb = nlbRoutesData.length;
        } catch (e) {
            errors.push("NLB Routes: " + e.message);
        }

        // Commit Routes to DB
        dbStatus.textContent = "Saving to Database...";
        await clearStore('routes');
        const allRoutes = [...kmbRoutesData, ...ctbRoutesData, ...nlbRoutesData];
        if (allRoutes.length > 0) {
            await bulkAdd('routes', allRoutes);
        }

        // Final Report
        loadStopsToMemory();

        let msg = `Updated with Proxy Fallback!\nStops: ${stats.kmbStops}, Routes: ${stats.kmbRoutes + stats.ctb + stats.nlb}.`;
        if (errors.length > 0) {
            msg += "\n\nWarning: Some sources failed even with Proxy.\n" + errors.join("\n");
            dbStatus.textContent = "DB: Updated (Partial)";
        } else {
            dbStatus.textContent = "DB: Ready (All Updated)";
        }
        alert(msg);

    } catch (e) {
        console.error("Critical Update Failure", e);
        dbStatus.textContent = "Update Error!";
        alert("Critical Error: " + e.message);
    } finally {
        updateBtn.disabled = false;
        updateBtn.textContent = "🔄 Update Database";
    }
}

function clearStore(storeName) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).clear().onsuccess = resolve;
    });
}

function bulkAdd(storeName, items) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        items.forEach(item => store.put(item));
        tx.oncomplete = resolve;
        tx.onerror = reject;
    });
}

// --- UI Logic ---

function switchTab(tabId) {
    document.querySelectorAll('.tab-content').forEach(el => el.style.display = 'none');
    document.querySelectorAll('.nav-btn').forEach(el => el.classList.remove('active'));

    document.getElementById(tabId).style.display = 'block';

    const btns = document.querySelectorAll('.nav-btn');
    if (tabId === 'nearby') btns[0].classList.add('active');
    if (tabId === 'search') btns[1].classList.add('active');
    if (tabId === 'favorites') btns[2].classList.add('active');

    currentTab = tabId;

    if (tabId === 'nearby') {
        startGPS();
    }
}

// --- Features: GPS Nearby ---

function startGPS() {
    if (!navigator.geolocation) {
        statusMsg.textContent = "GPS not supported";
        return;
    }
    statusMsg.textContent = "Locating...";
    navigator.geolocation.getCurrentPosition(
        (pos) => {
            userLocation = pos.coords;
            statusMsg.textContent = `Found Loc: ${pos.coords.latitude.toFixed(4)}, ${pos.coords.longitude.toFixed(4)}`;
            updateNearbyList(pos.coords);
        },
        (err) => {
            statusMsg.textContent = "GPS Error: " + err.message;
        },
        { enableHighAccuracy: true, timeout: 5000, maximumAge: 0 }
    );
}

function updateNearbyList(coords) {
    if (isDBLoading) {
        nearbyList.innerHTML = '<div class="status-message">Loading database...</div>';
        return;
    }

    if (cachedStops.length === 0) {
        nearbyList.innerHTML = '<div class="empty-msg">Database empty. Please update database first.</div>';
        return;
    }

    const range = 0.005; // ~500m
    const nearby = cachedStops.filter(s => {
        return Math.abs(s.lat - coords.latitude) < range && Math.abs(s.long - coords.longitude) < range;
    }).map(s => {
        s.distance = getDistanceFromLatLonInKm(coords.latitude, coords.longitude, s.lat, s.long);
        return s;
    }).filter(s => s.distance < 0.5)
        .sort((a, b) => a.distance - b.distance)
        .slice(0, 15);

    renderStops(nearby);
}

function renderStops(stops) {
    nearbyList.innerHTML = '';
    if (stops.length === 0) {
        nearbyList.innerHTML = '<div class="empty-msg">No KMB stops found nearby (500m).</div>';
        return;
    }

    stops.forEach(stop => {
        const el = document.createElement('div');
        el.className = 'bus-card';
        el.onclick = () => showStopETA(stop);
        el.innerHTML = `
            <div class="bus-header">
                <span class="dest-name">🚏 ${stop.name_tc} (${stop.name_en})</span>
                <span style="font-size:0.8rem">${(stop.distance * 1000).toFixed(0)}m</span>
            </div>
            <div style="font-size:0.8rem; color:#aaa;">${stop.code} • ${stop.company}</div>
        `;
        nearbyList.appendChild(el);
    });
}

function getDistanceFromLatLonInKm(lat1, lon1, lat2, lon2) {
    var R = 6371;
    var dLat = deg2rad(lat2 - lat1);
    var dLon = deg2rad(lon2 - lon1);
    var a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2)
        ;
    var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    var d = R * c;
    return d;
}

function deg2rad(deg) {
    return deg * (Math.PI / 180)
}

// --- Search Feature ---

async function searchRoute() {
    const input = document.getElementById('route-input').value.toUpperCase().trim();
    const resultsEl = document.getElementById('search-results');
    resultsEl.innerHTML = 'Searching DB...';

    if (!input) return;

    const tx = db.transaction('routes', 'readonly');
    const store = tx.objectStore('routes');

    // Scan all routes (efficient enough for ~1000 items)
    const matches = [];
    const limit = 50;

    const cursorReq = store.openCursor();
    cursorReq.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
            if (cursor.value.route.includes(input)) {
                matches.push(cursor.value);
            }
            if (matches.length >= limit) {
                renderSearchResults(matches); // Early exit display
                return;
            }
            cursor.continue();
        } else {
            renderSearchResults(matches);
        }
    };
}

function renderSearchResults(routes) {
    const resultsEl = document.getElementById('search-results');
    resultsEl.innerHTML = '';

    if (routes.length === 0) {
        resultsEl.innerHTML = '<div class="empty-msg">No routes found. Update DB if missing.</div>';
        return;
    }

    // Sort: Exact match first
    const input = document.getElementById('route-input').value.toUpperCase().trim();
    routes.sort((a, b) => {
        if (a.route === input && b.route !== input) return -1;
        if (b.route === input && a.route !== input) return 1;
        return a.route.localeCompare(b.route);
    });

    routes.forEach(route => {
        const el = document.createElement('div');
        el.className = 'bus-card';
        el.onclick = () => showRouteStops(route);
        el.innerHTML = `
            <div class="bus-header">
                <span class="route-num">${route.route}</span>
                <span class="dest-name">${route.dest_tc}</span>
            </div>
            <div style="font-size:0.8rem; color:#ccc;">${route.company} • To ${route.dest_en}</div>
        `;
        resultsEl.appendChild(el);
    });
}

// --- Route Stops Logic ---

async function showRouteStops(route) {
    const modal = document.getElementById('eta-modal');
    const title = document.getElementById('modal-title');
    const body = document.getElementById('modal-body');
    title.textContent = `${route.route} Stops`;
    body.innerHTML = 'Loading Stops...';
    modal.style.display = 'flex';

    try {
        let stopList = [];

        if (route.company === 'KMB') {
            // Updated to use Fallback for route stops too as it might fail
            // KMB API: /route-stop/{route}/{direction}/{service_type}
            let res = await fetchWithFallback(`https://data.etabus.gov.hk/v1/transport/kmb/route-stop/${route.route}/outbound/1`, 'KMB Stops Outbound');
            if (!res.data || res.data.length === 0) {
                res = await fetchWithFallback(`https://data.etabus.gov.hk/v1/transport/kmb/route-stop/${route.route}/inbound/1`, 'KMB Stops Inbound');
            }
            stopList = await hydrateStops(res.data.map(s => s.stop));

        } else if (route.company === 'CTB') {
            const res = await fetchWithFallback(`https://rt.data.gov.hk/v2/transport/citybus/route-stop/CTB/${route.route}/outbound`, 'CTB Stops');
            if (res.data) {
                stopList = res.data.map(s => ({
                    id: s.stop,
                    name_tc: `Stop ${s.stop}`,
                    name_en: `Stop ${s.stop}`,
                    company: 'CTB',
                    code: s.stop
                }));
            }
        } else if (route.company === 'NLB') {
            const res = await fetchWithFallback(`https://rt.data.gov.hk/v2/transport/nlb/route/${route.nlbId}/stop`, 'NLB Stops');
            stopList = res.stops.map(s => ({
                id: s.stopId,
                name_tc: s.stopName_c,
                name_en: s.stopName_e,
                company: 'NLB',
                code: s.stopId
            }));
        }

        let html = `<div style="max-height: 400px; overflow-y: auto;">`;
        if (stopList.length === 0) html += 'No stops found (or Service Type issue).';
        stopList.forEach(stop => {
            html += `
                <div onclick="showStopETA({code:'${stop.code}', company:'${route.company}', name_tc:'${stop.name_tc || stop.id}', name_en:'${stop.name_en || stop.id}'})" 
                     style="padding: 15px; border-bottom:1px solid rgba(255,255,255,0.1); cursor:pointer;">
                    <div style="font-weight:bold;">${stop.name_tc || stop.id}</div>
                    <div style="font-size:0.8rem; color:#aaa;">${stop.name_en || ''}</div>
                </div>
            `;
        });
        html += '</div>';
        body.innerHTML = html;

    } catch (e) {
        body.textContent = "Error loading stops: " + e.message;
    }
}

async function hydrateStops(stopIds) {
    const tx = db.transaction('stops', 'readonly');
    const store = tx.objectStore('stops');
    const promises = stopIds.map(id => new Promise(resolve => {
        store.get(`KMB-${id}`).onsuccess = (e) => resolve(e.target.result);
    }));
    const results = await Promise.all(promises);
    return results.filter(s => s);
}

// --- ETA Logic ---

async function showStopETA(stop) {
    const modal = document.getElementById('eta-modal');
    const title = document.getElementById('modal-title');
    const body = document.getElementById('modal-body');

    title.innerHTML = `${stop.name_tc || ''} <small>${stop.name_en || ''}</small>`;
    body.innerHTML = 'Loading ETA...';
    modal.style.display = 'flex';

    try {
        let etas = [];

        if (stop.company === 'KMB' || (stop.uniqueId && stop.uniqueId.startsWith('KMB'))) {
            // ETA usually fits in CORS more easily, but use fallback just in case
            const res = await fetchWithFallback(`https://data.etabus.gov.hk/v1/transport/kmb/stop-eta/${stop.code || stop.id}`, 'KMB ETA');
            etas = res.data.map(e => ({
                route: e.route,
                dest: e.dest_tc,
                eta: e.eta,
                co: 'KMB'
            }));
        } else if (stop.company === 'CTB') {
            const res = await fetchWithFallback(`https://rt.data.gov.hk/v1/transport/batch/stop-eta/CTB/${stop.code}`, 'CTB ETA');
            etas = res.data.map(e => ({
                route: e.route,
                dest: e.dest || e.dest_tc,
                eta: e.eta,
                co: 'CTB'
            }));
        } else if (stop.company === 'NLB') {
            const res = await fetchWithFallback(`https://rt.data.gov.hk/v1/transport/batch/stop-eta/NLB/${stop.code}`, 'NLB ETA');
            etas = res.data.map(e => ({
                route: e.route,
                dest: e.dest || e.dest_tc,
                eta: e.eta,
                co: 'NLB'
            }));
        }

        etas = etas.sort((a, b) => new Date(a.eta) - new Date(b.eta));

        const routes = {};
        etas.forEach(e => {
            if (!routes[e.route]) routes[e.route] = [];
            // Only add ETAs that have both eta time AND destination info
            if (e.eta && e.dest) routes[e.route].push(e);
        });

        let html = `<div style="max-height:400px; overflow-y:auto;">`;
        if (Object.keys(routes).length === 0) {
            html += '<div style="padding:20px; text-align:center;">No scheduled buses.</div>';
        } else {
            for (const route in routes) {
                // Skip routes with no valid ETAs
                if (!routes[route] || routes[route].length === 0) continue;

                const nextBus = routes[route][0];
                const dest = nextBus.dest || 'Unknown Destination';
                const timeDiff = Math.abs(Math.round((new Date(nextBus.eta) - new Date()) / 60000));
                // Bug fix: if negative, means departed or wrong timezone. API usually gives future.
                const rawDiff = (new Date(nextBus.eta) - new Date()) / 60000;
                let timeDisplay = rawDiff < 1 ? "Now" : `${Math.ceil(rawDiff)} min`;

                html += `
                    <div style="margin-bottom: 15px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 10px;">
                        <div style="display:flex; justify-content:space-between; font-size:1.2rem; font-weight:bold;">
                            <span style="color:#00d2ff">${route}</span>
                            <span style="color:#ffeb3b">${timeDisplay}</span>
                        </div>
                        <div style="font-size:0.9rem; margin-bottom: 5px;">To: ${dest}</div>
                        <div style="font-size:0.8rem; color:#ccc;">
                            Next: ${routes[route].slice(1, 3).map(b => {
                    const diff = (new Date(b.eta) - new Date()) / 60000;
                    return diff < 1 ? "Now" : `${Math.ceil(diff)}m`;
                }).join(', ')}
                        </div>
                    </div>
                `;
            }
        }
        html += '</div>';
        body.innerHTML = html;

    } catch (e) {
        body.textContent = "Error loading ETA: " + e.message;
    }
}

function closeModal() {
    document.getElementById('eta-modal').style.display = 'none';
}

// --- Favorites Feature ---

function toggleFavorite(type, item) {
    let favs = JSON.parse(localStorage.getItem('hkbus_favs') || '[]');
    // Check if exists
    const idx = favs.findIndex(f => (f.uniqueId && f.uniqueId === item.uniqueId) || (f.id === item.id && f.company === item.company && f.route === item.route));

    if (idx >= 0) {
        favs.splice(idx, 1);
        alert("Removed from Favorites");
    } else {
        // Add minimal data
        favs.push(item);
        alert("Added to Favorites");
    }
    localStorage.setItem('hkbus_favs', JSON.stringify(favs));

    // Refresh if in favorites tab
    if (currentTab === 'favorites') loadFavorites();
}

function loadFavorites() {
    const list = document.getElementById('favorites-list');
    const favs = JSON.parse(localStorage.getItem('hkbus_favs') || '[]');
    list.innerHTML = '';

    if (favs.length === 0) {
        list.innerHTML = '<div class="empty-msg">No favorites saved. Search routes or stops to add.</div>';
        return;
    }

    favs.forEach(item => {
        const el = document.createElement('div');
        el.className = 'bus-card';
        el.style.position = 'relative'; // Ensure absolute positioning works for child

        // 1. Create content container (with padding for X button)
        const contentDiv = document.createElement('div');
        contentDiv.style.paddingRight = '40px'; // Make space for X button

        // 2. Determine Content
        if (item.route && !item.lat) { // Route
            el.onclick = () => showRouteStops(item);
            contentDiv.innerHTML = `
                <div class="bus-header">
                    <span class="route-num">★ ${item.route}</span>
                    <span class="dest-name">${item.dest_tc || item.company}</span>
                </div>
                <div style="font-size:0.8rem; color:#ccc;">${item.company} • Route</div>
            `;
        } else { // Stop
            el.onclick = () => showStopETA(item);
            contentDiv.innerHTML = `
                <div class="bus-header">
                    <span class="dest-name">★ ${item.name_tc || item.id}</span>
                    <span style="font-size:0.8rem">${item.code || ''}</span>
                </div>
                <div style="font-size:0.8rem; color:#aaa;">${item.name_en || ''}</div>
            `;
        }

        // 3. Create Remove Button
        const removeBtn = document.createElement('div');
        removeBtn.innerHTML = '&#10005;'; // X sym
        removeBtn.style.cssText = `
            position: absolute;
            top: 50%;
            right: 15px;
            transform: translateY(-50%);
            width: 30px;
            height: 30px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 1.2rem;
            color: rgba(255, 255, 255, 0.5);
            cursor: pointer;
            z-index: 10;
            border-radius: 50%;
            transition: all 0.2s;
        `;
        // Hover effect
        removeBtn.onmouseenter = () => { removeBtn.style.color = '#ff4444'; removeBtn.style.background = 'rgba(255,255,255,0.1)'; };
        removeBtn.onmouseleave = () => { removeBtn.style.color = 'rgba(255, 255, 255, 0.5)'; removeBtn.style.background = 'transparent'; };

        removeBtn.onclick = (e) => {
            e.stopPropagation(); // Stop card click
            if (confirm('Remove this favorite?')) {
                toggleFavorite('delete', item);
            }
        };

        el.appendChild(contentDiv);
        el.appendChild(removeBtn);
        list.appendChild(el);
    });
}

// Ensure loadFavorites is called when switching tab
const originalSwitchTab = switchTab;
switchTab = function (tabId) {
    // Call original logic via DOM actions basically effectively
    document.querySelectorAll('.tab-content').forEach(el => el.style.display = 'none');
    document.querySelectorAll('.nav-btn').forEach(el => el.classList.remove('active'));
    document.getElementById(tabId).style.display = 'block';

    const btns = document.querySelectorAll('.nav-btn');
    if (tabId === 'nearby') { btns[0].classList.add('active'); startGPS(); }
    if (tabId === 'search') btns[1].classList.add('active');
    if (tabId === 'favorites') { btns[2].classList.add('active'); loadFavorites(); }

    currentTab = tabId;
}

// Patch UI functions
const originalShowStopETA = showStopETA;
showStopETA = async function (stop) {
    await originalShowStopETA(stop);
    const title = document.getElementById('modal-title');
    // Add Fav Button
    const favBtn = document.createElement('span');
    favBtn.innerHTML = ' ❤️';
    favBtn.style.cursor = 'pointer';
    favBtn.title = "Toggle Favorite";
    favBtn.onclick = (e) => {
        e.stopPropagation();
        toggleFavorite('stop', stop);
    };
    title.appendChild(favBtn);
};

const originalShowRouteStops = showRouteStops;
showRouteStops = async function (route) {
    await originalShowRouteStops(route);
    const title = document.getElementById('modal-title');
    const favBtn = document.createElement('span');
    favBtn.innerHTML = ' ❤️';
    favBtn.style.cursor = 'pointer';
    favBtn.title = "Toggle Favorite";
    favBtn.onclick = (e) => {
        e.stopPropagation();
        toggleFavorite('route', route);
    };
    title.appendChild(favBtn);
};

// Init
initDB();
