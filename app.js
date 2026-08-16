/* Where's My Car? — all data lives in this browser's localStorage.
 * Accounts are unverified by design: signing up creates the account instantly. */

(function () {
  "use strict";

  var USERS_KEY = "wmc_users";
  var SESSION_KEY = "wmc_session";

  var $ = function (sel) { return document.querySelector(sel); };

  var screens = {
    auth: $("#screen-auth"),
    home: $("#screen-home"),
    map: $("#screen-map"),
    history: $("#screen-history")
  };

  var map = null;
  var carMarker = null;
  var youMarker = null;
  var watchId = null;

  /* ---------------- storage ---------------- */

  function loadUsers() {
    try { return JSON.parse(localStorage.getItem(USERS_KEY)) || {}; }
    catch (e) { return {}; }
  }
  function saveUsers(users) { localStorage.setItem(USERS_KEY, JSON.stringify(users)); }

  function currentUser() { return localStorage.getItem(SESSION_KEY); }

  function dataKey(username) { return "wmc_data_" + username.toLowerCase(); }

  function loadData(username) {
    try {
      var d = JSON.parse(localStorage.getItem(dataKey(username)));
      if (d && typeof d === "object") return { current: d.current || null, history: d.history || [] };
    } catch (e) { /* fall through */ }
    return { current: null, history: [] };
  }
  function saveData(username, data) {
    localStorage.setItem(dataKey(username), JSON.stringify(data));
  }

  /* Password hashing: SHA-256 where available (https / localhost),
   * otherwise a simple fallback hash. Local-only convenience, not real security. */
  function hashPassword(password) {
    if (window.crypto && crypto.subtle && window.TextEncoder) {
      return crypto.subtle.digest("SHA-256", new TextEncoder().encode(password)).then(function (buf) {
        return Array.prototype.map.call(new Uint8Array(buf), function (b) {
          return b.toString(16).padStart(2, "0");
        }).join("");
      });
    }
    var h = 5381;
    for (var i = 0; i < password.length; i++) h = ((h << 5) + h + password.charCodeAt(i)) >>> 0;
    return Promise.resolve("djb2:" + h.toString(16));
  }

  /* ---------------- screens ---------------- */

  function show(name) {
    Object.keys(screens).forEach(function (k) {
      screens[k].classList.toggle("hidden", k !== name);
    });
    if (name !== "map") stopWatching();
  }

  /* ---------------- auth ---------------- */

  function normalizePhone(p) { return (p || "").replace(/[^\d+]/g, ""); }

  function setTab(which) {
    $("#tab-signup").classList.toggle("active", which === "signup");
    $("#tab-login").classList.toggle("active", which === "login");
    $("#form-signup").classList.toggle("hidden", which !== "signup");
    $("#form-login").classList.toggle("hidden", which !== "login");
    $("#signup-error").textContent = "";
    $("#login-error").textContent = "";
  }

  $("#tab-signup").addEventListener("click", function () { setTab("signup"); });
  $("#tab-login").addEventListener("click", function () { setTab("login"); });

  $("#form-signup").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var errEl = $("#signup-error");
    errEl.textContent = "";

    var f = ev.target;
    var username = f.username.value.trim();
    var email = f.email.value.trim();
    var phone = f.phone.value.trim();
    var password = f.password.value;

    if (!username) { errEl.textContent = "Pick a username."; return; }
    if (!/^[\w.@+-]{2,32}$/.test(username)) { errEl.textContent = "Username: 2–32 letters, numbers or . _ @ + -"; return; }
    if (password.length < 4) { errEl.textContent = "Password needs at least 4 characters."; return; }

    var users = loadUsers();
    var key = username.toLowerCase();
    if (users[key]) { errEl.textContent = "That username is taken on this device."; return; }

    var taken = Object.keys(users).some(function (k) {
      var u = users[k];
      return (email && u.email && u.email.toLowerCase() === email.toLowerCase()) ||
             (phone && u.phone && normalizePhone(u.phone) === normalizePhone(phone));
    });
    if (taken) { errEl.textContent = "That email or phone is already registered on this device."; return; }

    hashPassword(password).then(function (hash) {
      users[key] = {
        username: username,
        email: email || null,
        phone: phone || null,
        passwordHash: hash,
        createdAt: Date.now()
      };
      saveUsers(users);
      localStorage.setItem(SESSION_KEY, username);
      f.reset();
      enterHome();
    });
  });

  $("#form-login").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var errEl = $("#login-error");
    errEl.textContent = "";

    var f = ev.target;
    var id = f.identifier.value.trim();
    var password = f.password.value;
    if (!id || !password) { errEl.textContent = "Fill in both fields."; return; }

    var users = loadUsers();
    var match = null;
    Object.keys(users).forEach(function (k) {
      var u = users[k];
      if (match) return;
      if (k === id.toLowerCase()) match = u;
      else if (u.email && u.email.toLowerCase() === id.toLowerCase()) match = u;
      else if (u.phone && normalizePhone(u.phone) === normalizePhone(id) && normalizePhone(id)) match = u;
    });

    if (!match) { errEl.textContent = "No account found for that username, email or phone."; return; }

    hashPassword(password).then(function (hash) {
      if (hash !== match.passwordHash) { errEl.textContent = "Wrong password."; return; }
      localStorage.setItem(SESSION_KEY, match.username);
      f.reset();
      enterHome();
    });
  });

  $("#btn-logout").addEventListener("click", function () {
    localStorage.removeItem(SESSION_KEY);
    setTab("login");
    show("auth");
  });

  /* ---------------- formatting ---------------- */

  function fmtCoords(spot) {
    return spot.lat.toFixed(5) + ", " + spot.lng.toFixed(5);
  }

  function fmtWhen(ts) {
    var diff = Date.now() - ts;
    var mins = Math.round(diff / 60000);
    var rel;
    if (mins < 1) rel = "just now";
    else if (mins < 60) rel = mins + " min ago";
    else if (mins < 60 * 24) rel = Math.round(mins / 60) + " h ago";
    else rel = Math.round(mins / (60 * 24)) + " d ago";
    return rel + " · " + new Date(ts).toLocaleString([], { dateStyle: "short", timeStyle: "short" });
  }

  function gmapsLink(spot) {
    return "https://www.google.com/maps/dir/?api=1&destination=" + spot.lat + "," + spot.lng + "&travelmode=walking";
  }

  function spotHtml(spot) {
    var addr = spot.address ? escapeHtml(spot.address) : fmtCoords(spot);
    return '<p class="spot-address">📍 ' + addr + "</p>" +
           '<p class="spot-meta">' + fmtWhen(spot.ts) +
           (spot.accuracy ? " · ±" + Math.round(spot.accuracy) + " m" : "") + "</p>";
  }

  function escapeHtml(s) {
    var div = document.createElement("div");
    div.textContent = s;
    return div.innerHTML;
  }

  /* ---------------- home ---------------- */

  function enterHome() {
    var user = currentUser();
    $("#home-greeting").textContent = "Hi, " + user + " 👋";
    renderHome();
    show("home");
  }

  function renderHome() {
    var data = loadData(currentUser());

    var cur = $("#current-park-body");
    if (data.current) cur.innerHTML = spotHtml(data.current);
    else cur.innerHTML = '<p class="empty">No car parked yet — press PARK when you leave your car.</p>';

    var last = $("#last-park-body");
    if (data.history.length) last.innerHTML = spotHtml(data.history[0]);
    else last.innerHTML = '<p class="empty">Your previous spot will show up here.</p>';

    $("#btn-show-car").setAttribute("aria-disabled", data.current ? "false" : "true");
  }

  /* ---------------- parking ---------------- */

  function getPosition() {
    return new Promise(function (resolve, reject) {
      if (!navigator.geolocation) { reject(new Error("This browser has no location support.")); return; }
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true,
        timeout: 15000,
        maximumAge: 0
      });
    });
  }

  function geoErrorMessage(err) {
    if (err && err.code === 1) return "Location permission denied — allow location access for this site and try again.";
    if (err && err.code === 2) return "Couldn't determine your location. Are you indoors or offline?";
    if (err && err.code === 3) return "Location timed out — try again with a clearer view of the sky.";
    return (err && err.message) || "Couldn't get your location.";
  }

  $("#btn-park").addEventListener("click", function () {
    var btn = $("#btn-park");
    var status = $("#park-status");
    btn.classList.add("busy");
    status.className = "park-status";
    status.textContent = "Getting your location…";

    getPosition().then(function (pos) {
      var user = currentUser();
      var data = loadData(user);

      if (data.current) data.history.unshift(data.current);

      var spot = {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        ts: Date.now(),
        address: null
      };
      data.current = spot;
      saveData(user, data);

      btn.classList.remove("busy");
      status.className = "park-status ok";
      status.textContent = "✅ Parked! Spot saved at " + fmtCoords(spot);
      renderHome();
      lookupAddress(user, spot);
    }).catch(function (err) {
      btn.classList.remove("busy");
      status.className = "park-status err";
      status.textContent = "⚠️ " + geoErrorMessage(err);
    });
  });

  /* Reverse-geocode via OpenStreetMap Nominatim; purely cosmetic, fails silently. */
  function lookupAddress(user, spot) {
    if (!navigator.onLine) return;
    var url = "https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=17" +
              "&lat=" + spot.lat + "&lon=" + spot.lng;
    fetch(url, { headers: { "Accept": "application/json" } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j || !j.display_name) return;
        var data = loadData(user);
        [data.current].concat(data.history).forEach(function (s) {
          if (s && s.ts === spot.ts) s.address = j.display_name.split(",").slice(0, 3).join(",");
        });
        saveData(user, data);
        if (!screens.home.classList.contains("hidden")) renderHome();
      })
      .catch(function () { /* offline or blocked — coords are enough */ });
  }

  /* ---------------- map ---------------- */

  $("#btn-show-car").addEventListener("click", function () {
    var data = loadData(currentUser());
    if (!data.current) {
      var status = $("#park-status");
      status.className = "park-status err";
      status.textContent = "No saved spot yet — press PARK first.";
      return;
    }
    openMap(data.current);
  });

  function openMap(spot) {
    show("map");
    $("#btn-navigate").href = gmapsLink(spot);
    $("#map-info").textContent = "Car at " + (spot.address || fmtCoords(spot)) + " · parked " + fmtWhen(spot.ts);

    if (typeof L === "undefined") {
      $("#map").innerHTML = '<p class="empty" style="padding:20px;text-align:center">Map library couldn\'t load (offline?). Use the Google Maps button below.</p>';
      return;
    }

    if (!map) {
      map = L.map("map");
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
      }).addTo(map);
    }

    if (carMarker) map.removeLayer(carMarker);
    carMarker = L.marker([spot.lat, spot.lng], {
      icon: L.divIcon({ className: "", html: '<div style="font-size:30px;line-height:1">🚗</div>', iconSize: [30, 30], iconAnchor: [15, 15] })
    }).addTo(map).bindPopup("Your car is here");
    map.setView([spot.lat, spot.lng], 17);
    setTimeout(function () { map.invalidateSize(); }, 50);

    startWatching(spot);
  }

  function startWatching(spot) {
    stopWatching();
    if (!navigator.geolocation) return;
    watchId = navigator.geolocation.watchPosition(function (pos) {
      var you = [pos.coords.latitude, pos.coords.longitude];
      if (!map) return;
      if (youMarker) youMarker.setLatLng(you);
      else {
        youMarker = L.marker(you, {
          icon: L.divIcon({ className: "", html: '<div style="font-size:24px;line-height:1">🧍</div>', iconSize: [24, 24], iconAnchor: [12, 12] })
        }).addTo(map).bindPopup("You are here");
      }
      var d = distanceMeters(you[0], you[1], spot.lat, spot.lng);
      $("#map-info").textContent =
        "🚗 " + (spot.address || fmtCoords(spot)) +
        " · " + (d >= 1000 ? (d / 1000).toFixed(1) + " km" : Math.round(d) + " m") + " away";
    }, function () { /* keep showing the car without live position */ }, { enableHighAccuracy: true });
  }

  function stopWatching() {
    if (watchId !== null && navigator.geolocation) {
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
    }
    if (youMarker && map) { map.removeLayer(youMarker); youMarker = null; }
  }

  function distanceMeters(lat1, lon1, lat2, lon2) {
    var R = 6371000;
    var toRad = function (x) { return x * Math.PI / 180; };
    var dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  /* ---------------- history ---------------- */

  $("#btn-history").addEventListener("click", function () {
    renderHistory();
    show("history");
  });

  function renderHistory() {
    var data = loadData(currentUser());
    var list = $("#history-list");
    list.innerHTML = "";
    $("#history-empty").classList.toggle("hidden", data.history.length > 0);

    data.history.forEach(function (spot, i) {
      var li = document.createElement("li");
      li.className = "history-item";
      li.innerHTML =
        '<div class="info">' + spotHtml(spot) +
        '<a class="mini" target="_blank" rel="noopener" href="' + gmapsLink(spot) + '">Open in Google Maps →</a>' +
        "</div>" +
        '<button class="del" data-i="' + i + '" aria-label="Delete this entry" type="button">🗑</button>';
      list.appendChild(li);
    });
  }

  $("#history-list").addEventListener("click", function (ev) {
    var del = ev.target.closest(".del");
    if (!del) return;
    var user = currentUser();
    var data = loadData(user);
    data.history.splice(Number(del.dataset.i), 1);
    saveData(user, data);
    renderHistory();
    renderHome();
  });

  $("#btn-clear-history").addEventListener("click", function () {
    if (!confirm("Delete all parking history? Your current park is kept.")) return;
    var user = currentUser();
    var data = loadData(user);
    data.history = [];
    saveData(user, data);
    renderHistory();
    renderHome();
  });

  /* ---------------- back buttons & boot ---------------- */

  document.querySelectorAll("[data-back]").forEach(function (btn) {
    btn.addEventListener("click", function () { enterHome(); });
  });

  if (currentUser()) enterHome();
  else show("auth");
})();
