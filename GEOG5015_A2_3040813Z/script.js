// ====== 1) CONFIG ======
const MAPBOX_TOKEN = "pk.eyJ1Ijoic2lzaHVvemhhbmciLCJhIjoiY21rY25nODl6MDJrNzNoczNpaG81MzZpciJ9.HpRSESzZ5F9wvNtkSO7S3w";
const DATA_URL = "https://raw.githubusercontent.com/3040813z/GEOG5015_A2_geojson/refs/heads/main/glasgow_poi.geojson";

mapboxgl.accessToken = MAPBOX_TOKEN;

// ====== 2) MAP INIT ======
const map = new mapboxgl.Map({
  container: "map",
  style: "mapbox://styles/mapbox/light-v11",
  center: [-4.2514, 55.8609],
  zoom: 13
});
map.addControl(new mapboxgl.NavigationControl(), "top-right");

// Geocoder (search)
map.addControl(new MapboxGeocoder({
  accessToken: mapboxgl.accessToken,
  mapboxgl: mapboxgl,
  marker: false,
  placeholder: "Search place / address"
}), "top-right");

// Geolocate
const geolocate = new mapboxgl.GeolocateControl({
  positionOptions: { enableHighAccuracy: true },
  trackUserLocation: false,
  showUserHeading: true
});
map.addControl(geolocate, "top-right");

// ====== 3) STATE ======
let baseData = null;         
// original with proxy_score
let userLngLat = null;       
// [lng, lat]
let selectedTypes = new Set(["cafe", "restaurant", "bar"]);
let minScore = 0;
let radiusKm = 3.0;

// Add state variables for advanced filters
let reqWheelchair = false;
let reqWebsite = false;
let reqTakeaway = false;
let cuisineFilter = "";

const popup = new mapboxgl.Popup({ closeButton: true, closeOnClick: true });

// ====== 4) HELPERS ======
function computeProxyScore(props) {
  let score = 0;

  if (props.opening_hours && String(props.opening_hours).trim() !== "") score += 1;

  const website = props.website || props["contact:website"];
  if (website && String(website).trim() !== "") score += 1;

  if (props.wheelchair && String(props.wheelchair).toLowerCase() === "yes") score += 1;

  const street = props["addr:street"];
  const houseNo = props["addr:housenumber"];
  if (street && String(street).trim() !== "" && houseNo && String(houseNo).trim() !== "") score += 1;

  const cuisine = props.cuisine;
  const takeaway = props.takeaway;
  if ((cuisine && String(cuisine).trim() !== "") || (takeaway && String(takeaway).trim() !== "")) score += 1;

  return score; // 0..5
}

function distanceKm(lng1, lat1, lng2, lat2) {
  const R = 6371;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function buildLegend() {
  const legend = document.getElementById("legend");
  legend.innerHTML = "";

  const items = [
    { label: "Cafe", url: "https://img.icons8.com/color/48/cafe.png" },
    { label: "Restaurant", url: "https://img.icons8.com/color/48/restaurant.png" },
    { label: "Bar", url: "https://img.icons8.com/color/48/cocktail.png" }
  ];

  items.forEach(it => {
    const row = document.createElement("div");
    row.className = "item";
    row.style.display = "flex";
    row.style.alignItems = "center";
    row.style.marginBottom = "6px"; 

    const img = document.createElement("img");
    img.src = it.url;
    img.style.width = "20px";
    img.style.height = "20px";
    img.style.marginRight = "8px";

    const tx = document.createElement("span");
    tx.textContent = it.label;

    row.appendChild(img);
    row.appendChild(tx);
    legend.appendChild(row);
  });
}

function getAddress(props) {
  const street = props["addr:street"] || "";
  const houseNo = props["addr:housenumber"] || "";
  const postcode = props["addr:postcode"] || "";
  const city = props["addr:city"] || "";
  const line1 = [houseNo, street].filter(Boolean).join(" ");
  const line2 = [city, postcode].filter(Boolean).join(" ");
  return [line1, line2].filter(s => s.trim() !== "").join(", ");
}

function updateUIValues() {
  document.getElementById("scoreVal").textContent = String(minScore);
  document.getElementById("radiusVal").textContent = radiusKm.toFixed(1);
}

function applyFiltersAndUpdate() {
  if (!baseData) return;

  const features = baseData.features
    .map(f => {
      if (userLngLat) {
        const [lng, lat] = f.geometry.coordinates;
        f.properties.distance_km = distanceKm(userLngLat[0], userLngLat[1], lng, lat);
      } else {
        f.properties.distance_km = null;
      }
      return f;
    })
    .filter(f => {
      const p = f.properties;
      
      // 1. Basic Filters (Type, Score, Distance)
      if (!selectedTypes.has(p.amenity)) return false;
      if (p.proxy_score < minScore) return false;
      if (userLngLat && radiusKm != null) {
        if (p.distance_km == null) return false;
        if (p.distance_km > radiusKm) return false;
      }

      // 2. Advanced Feature Filters
      if (reqWheelchair && String(p.wheelchair).toLowerCase() !== "yes") return false;
      
      const website = p.website || p["contact:website"];
      if (reqWebsite && (!website || String(website).trim() === "")) return false;
      
      const takeaway = p.takeaway;
      if (reqTakeaway && (!takeaway || String(takeaway).toLowerCase() === "no")) return false;

      // 3. Cuisine Text Filter (Case-insensitive inclusion)
      if (cuisineFilter !== "") {
        const c = String(p.cuisine || "").toLowerCase();
        if (!c.includes(cuisineFilter)) return false;
      }

      return true;
    });

  const filtered = { type: "FeatureCollection", features };

  const src = map.getSource("poi");
  if (src) src.setData(filtered);

  renderTop10(features);
}

function renderTop10(features) {
  const topList = document.getElementById("topList");
  topList.innerHTML = "";

  // Graceful Empty State Handling
  if (features.length === 0) {
    const li = document.createElement("li");
    li.style.color = "#888";
    li.style.fontStyle = "italic";
    li.textContent = "No matching places found. Try loosening your filters.";
    topList.appendChild(li);
    return;
  }

  const sorted = [...features].sort((a, b) => {
    const s = b.properties.proxy_score - a.properties.proxy_score;
    if (s !== 0) return s;

    const da = a.properties.distance_km;
    const db = b.properties.distance_km;
    if (da != null && db != null) return da - db;

    return String(a.properties.name).localeCompare(String(b.properties.name));
  });

  sorted.slice(0, 10).forEach((f, idx) => {
    const li = document.createElement("li");
    const name = f.properties.name || "Unnamed";
    const type = f.properties.amenity;
    const score = f.properties.proxy_score;
    const dist = f.properties.distance_km;

    li.textContent = `${name} · ${type} · score ${score}` + (dist != null ? ` · ${dist.toFixed(2)} km` : "");
    li.addEventListener("click", () => {
      flyToFeature(f);
    });
    topList.appendChild(li);
  });
}

function flyToFeature(f) {
  const coords = f.geometry.coordinates;
  map.flyTo({ center: coords, zoom: 16 });
  showPopupForFeature(f, coords);
}

function showPopupForFeature(f, lngLatOrCoords) {
  const p = f.properties;
  const name = p.name || "Unnamed";
  const amenity = p.amenity || "unknown";
  const addr = getAddress(p);
  const score = p.proxy_score;

  const website = p.website || p["contact:website"] || "";
  const oh = p.opening_hours || "";
  const wheelchair = p.wheelchair || "";

  const dist = (p.distance_km != null) ? `${p.distance_km.toFixed(2)} km` : "—";

  // 1. Generate visual star rating (★ and ☆)
  const emptyStar = "☆";
  const filledStar = "★";
  const stars = filledStar.repeat(score) + emptyStar.repeat(5 - score);

  // 2. Select default banner image based on amenity type (Using high-quality Unsplash images)
  let bannerUrl = "https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?auto=format&fit=crop&w=400&q=80"; // Default Restaurant
  if (amenity === "cafe") {
    bannerUrl = "https://images.unsplash.com/photo-1509042239860-f550ce710b93?auto=format&fit=crop&w=400&q=80"; // Cafe
  } else if (amenity === "bar") {
    bannerUrl = "https://images.unsplash.com/photo-1514933651103-005eec06c04b?auto=format&fit=crop&w=400&q=80"; // Bar
  }

  // 3. Generate Tag Badges
  let tagsHtml = `<span class="badge badge-type">${amenity}</span>`;
  if (wheelchair.toLowerCase() === "yes") tagsHtml += `<span class="badge badge-feature">♿ Wheelchair</span>`;
  if (p.takeaway && p.takeaway.toLowerCase() !== "no") tagsHtml += `<span class="badge badge-feature">🥡 Takeaway</span>`;

  // 4. Generate Google Maps Directions URL
  const [lng, lat] = f.geometry.coordinates;
  const dirUrl = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;

  // 5. Build HTML Card Structure
  const html = `
    <div class="custom-popup">
      <div class="popup-banner" style="background-image: url('${bannerUrl}')"></div>
      <div class="popup-body">
        <h3 class="popup-title">${name}</h3>
        
        <div class="popup-stars">
          <span class="stars-color">${stars}</span> 
          <span class="score-text">(${score}/5)</span>
        </div>
        
        <div class="popup-tags">${tagsHtml}</div>
        
        <div class="popup-info">
          ${addr ? `<div class="info-row">📍 <span>${addr}</span></div>` : ``}
          ${dist !== "—" ? `<div class="info-row">🚶 <span>${dist} away</span></div>` : ``}
          ${oh ? `<div class="info-row">🕒 <span>${oh}</span></div>` : ``}
        </div>

        <div class="popup-actions">
          <a href="${dirUrl}" target="_blank" class="btn btn-primary">🗺️ Directions</a>
          ${website ? `<a href="${website}" target="_blank" class="btn btn-outline">🌐 Website</a>` : ``}
        </div>
      </div>
    </div>
  `;

  popup.setLngLat(lngLatOrCoords).setHTML(html).addTo(map);
}


// ====== 5) LOAD DATA & LAYERS ======
// Helper function to reload images and layers (crucial for style switching)
async function loadImagesAndLayers() {
  const icons = [
    { id: "cafe-icon", url: "https://img.icons8.com/color/48/cafe.png" },
    { id: "restaurant-icon", url: "https://img.icons8.com/color/48/restaurant.png" },
    { id: "bar-icon", url: "https://img.icons8.com/color/48/cocktail.png" }
  ];

  // Load missing images
  for (const icon of icons) {
    if (!map.hasImage(icon.id)) {
      await new Promise((resolve) => {
        map.loadImage(icon.url, (error, image) => {
          if (!error && !map.hasImage(icon.id)) {
            map.addImage(icon.id, image);
          }
          resolve();
        });
      });
    }
  }

  // Add source if missing
  if (!map.getSource("poi")) {
    map.addSource("poi", { type: "geojson", data: baseData });
  }

  // Add layer if missing
  if (!map.getLayer("poi-layer")) {
    map.addLayer({
      id: "poi-layer",
      type: "symbol",
      source: "poi",
      layout: {
        "icon-image": [
          "match",
          ["get", "amenity"],
          "cafe", "cafe-icon",
          "restaurant", "restaurant-icon",
          "bar", "bar-icon",
          "cafe-icon" 
        ],
        "icon-size": [
          "interpolate",
          ["linear"],
          ["get", "proxy_score"],
          0, 0.4, 
          5, 0.8  
        ],
        "icon-allow-overlap": true
      }
    });
  }
}

map.on("load", async () => {
  buildLegend();
  updateUIValues();

  const res = await fetch(DATA_URL);
  const geo = await res.json();

  // Compute proxy_score
  geo.features.forEach(f => {
    f.properties.proxy_score = computeProxyScore(f.properties);
  });
  baseData = geo;

  await loadImagesAndLayers();

  map.on("mouseenter", "poi-layer", () => { map.getCanvas().style.cursor = "pointer"; });
  map.on("mouseleave", "poi-layer", () => { map.getCanvas().style.cursor = ""; });

  map.on("click", "poi-layer", (e) => {
    const f = e.features && e.features[0];
    if (!f) return;
    showPopupForFeature(f, e.lngLat);
  });

  applyFiltersAndUpdate();
});

// Re-add layers when the map style changes (Dark/Light mode toggle)
map.on('style.load', async () => {
  if (baseData) {
    await loadImagesAndLayers();
    applyFiltersAndUpdate();
  }
});

// ====== 6) UI EVENTS ======
document.querySelectorAll(".typeChk").forEach(chk => {
  chk.addEventListener("change", () => {
    selectedTypes = new Set(
      Array.from(document.querySelectorAll(".typeChk"))
        .filter(x => x.checked)
        .map(x => x.value)
    );
    applyFiltersAndUpdate();
  });
});

document.getElementById("scoreSlider").addEventListener("input", (e) => {
  minScore = Number(e.target.value);
  updateUIValues();
  applyFiltersAndUpdate();
});

document.getElementById("radiusSlider").addEventListener("input", (e) => {
  radiusKm = Number(e.target.value);
  updateUIValues();
  applyFiltersAndUpdate();
});

document.getElementById("resetBtn").addEventListener("click", () => {
  userLngLat = null;
  selectedTypes = new Set(["cafe", "restaurant", "bar"]);
  minScore = 0;
  radiusKm = 3.0;

  document.querySelectorAll(".typeChk").forEach(x => x.checked = true);
  document.getElementById("scoreSlider").value = "0";
  document.getElementById("radiusSlider").value = "3";
  updateUIValues();

  map.flyTo({ center: [-4.2514, 55.8609], zoom: 13 });
  applyFiltersAndUpdate();
});

geolocate.on("geolocate", (pos) => {
  userLngLat = [pos.coords.longitude, pos.coords.latitude];
  applyFiltersAndUpdate();
});

// ==========================================
// Dark Mode Toggle Logic
// ==========================================
let isDarkMode = false;
document.getElementById('darkModeBtn').addEventListener('click', (e) => {
  isDarkMode = !isDarkMode; 
  
  document.body.classList.toggle('dark-mode');
  e.target.textContent = isDarkMode ? '☀️' : '🌙'; 

  const styleUrl = isDarkMode ? 'mapbox://styles/mapbox/dark-v11' : 'mapbox://styles/mapbox/light-v11';
  map.setStyle(styleUrl);
});

// ==========================================
// Info Modal Logic
// ==========================================
const infoModal = document.getElementById('infoModal');

document.getElementById('infoBtn').addEventListener('click', () => {
  infoModal.style.display = 'flex';
});

document.getElementById('closeModalBtn').addEventListener('click', () => {
  infoModal.style.display = 'none';
});

window.addEventListener('click', (e) => {
  if (e.target === infoModal) {
    infoModal.style.display = 'none';
  }
});

// ==========================================
// Advanced Filters Events
// ==========================================
document.getElementById("chkWheelchair").addEventListener("change", (e) => {
  reqWheelchair = e.target.checked;
  applyFiltersAndUpdate();
});

document.getElementById("chkWebsite").addEventListener("change", (e) => {
  reqWebsite = e.target.checked;
  applyFiltersAndUpdate();
});

document.getElementById("chkTakeaway").addEventListener("change", (e) => {
  reqTakeaway = e.target.checked;
  applyFiltersAndUpdate();
});

document.getElementById("cuisineInput").addEventListener("input", (e) => {
  cuisineFilter = e.target.value.toLowerCase().trim();
  applyFiltersAndUpdate();
});

// IMPORTANT: Overwrite the previous resetBtn listener to clear advanced filters too
document.getElementById("resetBtn").addEventListener("click", () => {
  // Reset all states
  userLngLat = null;
  selectedTypes = new Set(["cafe", "restaurant", "bar"]);
  minScore = 0;
  radiusKm = 3.0;
  reqWheelchair = false;
  reqWebsite = false;
  reqTakeaway = false;
  cuisineFilter = "";

  // Reset UI elements
  document.querySelectorAll(".typeChk").forEach(x => x.checked = true);
  document.getElementById("scoreSlider").value = "0";
  document.getElementById("radiusSlider").value = "3";
  document.getElementById("chkWheelchair").checked = false;
  document.getElementById("chkWebsite").checked = false;
  document.getElementById("chkTakeaway").checked = false;
  document.getElementById("cuisineInput").value = "";
  
  updateUIValues();
  map.flyTo({ center: [-4.2514, 55.8609], zoom: 13 });
  applyFiltersAndUpdate();
});