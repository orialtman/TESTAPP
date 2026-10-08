/* Where's My Car?
 *
 * Two storage modes, picked automatically at load:
 *  - Device mode (FIREBASE_CONFIG null): accounts and parks live in this
 *    browser's localStorage only. No verification, no server.
 *  - Cloud mode (FIREBASE_CONFIG set in config.js): accounts live in
 *    Firebase Auth (email/password under the hood, still no verification)
 *    and parks sync live across devices via Firestore. localStorage is
 *    kept as an offline cache.
 */

(function () {
  "use strict";

  var USERS_KEY = "wmc_users";
  var SESSION_KEY = "wmc_session";
  var SYNTH_DOMAIN = "users.wheresmycar.app"; // synthetic auth email domain for username-only accounts

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

  /* In-memory parking data for the logged-in user. */
  var state = { current: null, history: [] };
  var unsubCloudData = null;

  /* ---------------- cloud setup ---------------- */

  var CLOUD = !!(window.FIREBASE_CONFIG && window.firebase);
  var auth = null, db = null;

  if (CLOUD) {
    firebase.initializeApp(window.FIREBASE_CONFIG);
    auth = firebase.auth();
    db = firebase.firestore();
    if (window.WMC_EMULATOR) {
      auth.useEmulator("http://127.0.0.1:9099", { disableWarnings: true });
      db.useEmulator("127.0.0.1", 8080);
    } else {
      db.enablePersistence({ synchronizeTabs: true }).catch(function () { /* unsupported browser — online-only */ });
    }
  }

  function cloudErrorMessage(err) {
    var code = (err && err.code) || "";
    if (code.indexOf("email-already-in-use") >= 0) return "That email is already registered.";
    if (code.indexOf("weak-password") >= 0) return "Password too weak — use at least 6 characters.";
    if (code.indexOf("wrong-password") >= 0 || code.indexOf("invalid-credential") >= 0 || code.indexOf("user-not-found") >= 0) return "Wrong password.";
    if (code.indexOf("too-many-requests") >= 0) return "Too many attempts — wait a minute and try again.";
    if (code.indexOf("network-request-failed") >= 0) return "No connection — check your internet and try again.";
    return (err && err.message) || "Something went wrong — try again.";
  }

  /* ---------------- session ---------------- */

  function session() {
    try {
      var raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      if (raw[0] === "{") return JSON.parse(raw);
      return { username: raw, uid: null }; // pre-cloud sessions stored a bare username
    } catch (e) { return null; }
  }
  function setSession(username, uid) {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ username: username, uid: uid || null }));
  }
  function clearSession() { localStorage.removeItem(SESSION_KEY); }
  function currentUser() { var s = session(); return s && s.username; }

  /* ---------------- local storage ---------------- */

  function loadUsers() {
    try { return JSON.parse(localStorage.getItem(USERS_KEY)) || {}; }
    catch (e) { return {}; }
  }
  function saveUsers(users) { localStorage.setItem(USERS_KEY, JSON.stringify(users)); }

  function dataKey(username) { return "wmc_data_" + username.toLowerCase(); }

  function loadLocalData(username) {
    try {
      var d = JSON.parse(localStorage.getItem(dataKey(username)));
      if (d && typeof d === "object") return { current: d.current || null, history: d.history || [] };
    } catch (e) { /* fall through */ }
    return { current: null, history: [] };
  }
  function mirrorLocal() {
    var u = currentUser();
    if (u) localStorage.setItem(dataKey(u), JSON.stringify(state));
  }

  /* Persist the in-memory state: localStorage always, Firestore in cloud mode.
   * Firestore writes are queued offline and sync when back online. */
  function saveState() {
    mirrorLocal();
    var s = session();
    if (CLOUD && s && s.uid) {
      db.doc("users/" + s.uid + "/data/main").set(sanitize(state)).catch(function () { /* queued by persistence or lost offline — local copy remains */ });
    }
  }

  /* Firestore rejects undefined values; make sure every field is concrete. */
  function sanitize(d) {
    var spot = function (x) {
      return x ? { lat: x.lat, lng: x.lng, accuracy: x.accuracy || null, ts: x.ts, address: x.address || null } : null;
    };
    return { current: spot(d.current), history: (d.history || []).map(spot) };
  }

  function subscribeCloudData(uid) {
    if (unsubCloudData) unsubCloudData();
    unsubCloudData = db.doc("users/" + uid + "/data/main").onSnapshot(function (snap) {
      if (snap.metadata.hasPendingWrites) return; // our own write echoing back
      var d = snap.data();
      if (!d) return;
      state = { current: d.current || null, history: d.history || [] };
      mirrorLocal();
      if (!screens.home.classList.contains("hidden")) renderHome();
      if (!screens.history.classList.contains("hidden")) renderHistory();
    }, function () { /* permissions/offline hiccup — keep local state */ });
  }

  /* ---------------- password hashing (device mode only) ---------------- */

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

  /* ---------------- auth UI ---------------- */

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

  function setBusy(form, busy) {
    var btn = form.querySelector("button[type=submit]");
    btn.disabled = busy;
    btn.style.opacity = busy ? "0.6" : "";
  }

  /* ---------------- signup ---------------- */

  $("#form-signup").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var errEl = $("#signup-error");
    errEl.textContent = "";

    var f = ev.target;
    var username = f.username.value.trim();
    var email = f.email.value.trim();
    var phone = f.phone.value.trim();
    var password = f.password.value;
    var minLen = CLOUD ? 6 : 4; // Firebase Auth requires 6+

    if (!username) { errEl.textContent = "Pick a username."; return; }
    if (!/^[\w.+-]{2,32}$/.test(username)) { errEl.textContent = "Username: 2–32 letters, numbers or . _ + -"; return; }
    if (password.length < minLen) { errEl.textContent = "Password needs at least " + minLen + " characters."; return; }

    if (CLOUD) cloudSignup(f, username, email, phone, password, errEl);
    else localSignup(f, username, email, phone, password, errEl);
  });

  function localSignup(f, username, email, phone, password, errEl) {
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
      users[key] = { username: username, email: email || null, phone: phone || null, passwordHash: hash, createdAt: Date.now() };
      saveUsers(users);
      setSession(username, null);
      state = loadLocalData(username);
      f.reset();
      enterHome();
    });
  }

  function cloudSignup(f, username, email, phone, password, errEl) {
    setBusy(f, true);
    var key = username.toLowerCase();
    var phoneNorm = phone ? normalizePhone(phone) : null;
    var authEmail = email || (key + "@" + SYNTH_DOMAIN);

    db.collection("profiles").doc(key).get().then(function (doc) {
      if (doc.exists) throw { code: "wmc/username-taken" };
      if (!phoneNorm) return null;
      return db.collection("profiles").where("phoneNorm", "==", phoneNorm).limit(1).get().then(function (q) {
        if (!q.empty) throw { code: "wmc/phone-taken" };
      });
    }).then(function () {
      return auth.createUserWithEmailAndPassword(authEmail, password);
    }).then(function (cred) {
      var uid = cred.user.uid;
      var profile = {
        username: username, uid: uid, authEmail: authEmail,
        email: email || null, emailLower: email ? email.toLowerCase() : null,
        phone: phone || null, phoneNorm: phoneNorm,
        createdAt: Date.now()
      };
      var seed = loadLocalData(username); // adopt any parks saved on this device before cloud mode
      return cred.user.updateProfile({ displayName: username }).then(function () {
        return db.collection("profiles").doc(key).set(profile);
      }).then(function () {
        return db.doc("users/" + uid + "/data/main").set(sanitize(seed));
      }).then(function () {
        state = seed;
        setSession(username, uid);
        subscribeCloudData(uid);
        f.reset();
        setBusy(f, false);
        enterHome();
      });
    }).catch(function (err) {
      setBusy(f, false);
      if (err && err.code === "wmc/username-taken") errEl.textContent = "That username is taken.";
      else if (err && err.code === "wmc/phone-taken") errEl.textContent = "That phone number is already registered.";
      else errEl.textContent = cloudErrorMessage(err);
    });
  }

  /* ---------------- login ---------------- */

  $("#form-login").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var errEl = $("#login-error");
    errEl.textContent = "";

    var f = ev.target;
    var id = f.identifier.value.trim();
    var password = f.password.value;
    if (!id || !password) { errEl.textContent = "Fill in both fields."; return; }

    if (CLOUD) cloudLogin(f, id, password, errEl);
    else localLogin(f, id, password, errEl);
  });

  function localLogin(f, id, password, errEl) {
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
      setSession(match.username, null);
      state = loadLocalData(match.username);
      f.reset();
      enterHome();
    });
  }

  function resolveProfile(id) {
    var lower = id.toLowerCase();
    if (id.indexOf("@") >= 0) {
      return db.collection("profiles").where("emailLower", "==", lower).limit(1).get().then(function (q) {
        return q.empty ? null : q.docs[0].data();
      });
    }
    return db.collection("profiles").doc(lower).get().then(function (doc) {
      if (doc.exists) return doc.data();
      var pn = normalizePhone(id);
      if (pn.length < 6) return null;
      return db.collection("profiles").where("phoneNorm", "==", pn).limit(1).get().then(function (q) {
        return q.empty ? null : q.docs[0].data();
      });
    });
  }

  function cloudLogin(f, id, password, errEl) {
    setBusy(f, true);
    resolveProfile(id).then(function (profile) {
      if (!profile) throw { code: "wmc/no-account" };
      return auth.signInWithEmailAndPassword(profile.authEmail, password).then(function (cred) {
        return { profile: profile, uid: cred.user.uid };
      });
    }).then(function (r) {
      return db.doc("users/" + r.uid + "/data/main").get().then(function (doc) {
        var d = doc.exists ? doc.data() : null;
        state = d ? { current: d.current || null, history: d.history || [] } : { current: null, history: [] };
        setSession(r.profile.username, r.uid);
        mirrorLocal();
        subscribeCloudData(r.uid);
        f.reset();
        setBusy(f, false);
        enterHome();
      });
    }).catch(function (err) {
      setBusy(f, false);
      if (err && err.code === "wmc/no-account") errEl.textContent = "No account found for that username, email or phone.";
      else errEl.textContent = cloudErrorMessage(err);
    });
  }

  /* ---------------- logout ---------------- */

  $("#btn-logout").addEventListener("click", function () {
    if (unsubCloudData) { unsubCloudData(); unsubCloudData = null; }
    clearSession();
    state = { current: null, history: [] };
    if (CLOUD) auth.signOut().catch(function () {});
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
    $("#home-greeting").textContent = "Hi, " + currentUser() + " 👋";
    renderHome();
    show("home");
  }

  function renderHome() {
    var cur = $("#current-park-body");
    if (state.current) cur.innerHTML = spotHtml(state.current);
    else cur.innerHTML = '<p class="empty">No car parked yet — press PARK when you leave your car.</p>';

    var last = $("#last-park-body");
    if (state.history.length) last.innerHTML = spotHtml(state.history[0]);
    else last.innerHTML = '<p class="empty">Your previous spot will show up here.</p>';

    $("#btn-show-car").setAttribute("aria-disabled", state.current ? "false" : "true");
    $("#btn-park").classList.toggle("parked", !!state.current);
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

  /* Confetti burst from the PARK button on a successful park. */
  function fireConfetti(anchor) {
    if (window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (!anchor.getBoundingClientRect || !document.body.animate && !Element.prototype.animate) return;
    var r = anchor.getBoundingClientRect();
    var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    var colors = ["#ff4d6d", "#ffd54a", "#2af0b8", "#4f8df9", "#ff9f1c", "#ffffff"];
    for (var i = 0; i < 46; i++) {
      var el = document.createElement("div");
      var size = 6 + Math.random() * 7;
      el.style.cssText = "position:fixed;left:" + cx + "px;top:" + cy + "px;width:" + size +
        "px;height:" + (size * 0.6) + "px;background:" + colors[i % colors.length] +
        ";border-radius:2px;pointer-events:none;z-index:9999;";
      document.body.appendChild(el);
      var ang = Math.random() * Math.PI * 2;
      var dist = 90 + Math.random() * 190;
      var dx = Math.cos(ang) * dist, dy = Math.sin(ang) * dist - 70;
      var anim = el.animate([
        { transform: "translate(-50%,-50%) rotate(0deg)", opacity: 1 },
        { transform: "translate(" + dx + "px," + (dy + 150) + "px) rotate(" + (360 + Math.random() * 400) + "deg)", opacity: 0 }
      ], { duration: 950 + Math.random() * 750, easing: "cubic-bezier(0.17,0.67,0.3,1)" });
      anim.onfinish = (function (e) { return function () { e.remove(); }; })(el);
    }
  }

  $("#btn-park").addEventListener("click", function () {
    var btn = $("#btn-park");
    var status = $("#park-status");
    btn.classList.add("busy");
    status.className = "park-status";
    status.textContent = "Getting your location…";

    getPosition().then(function (pos) {
      if (state.current) state.history.unshift(state.current);

      var spot = {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        ts: Date.now(),
        address: null
      };
      state.current = spot;
      saveState();

      btn.classList.remove("busy");
      status.className = "park-status ok";
      status.textContent = "Parked! Spot saved at " + fmtCoords(spot);
      renderHome();
      fireConfetti(btn);
      lookupAddress(spot);
    }).catch(function (err) {
      btn.classList.remove("busy");
      status.className = "park-status err";
      status.textContent = "⚠️ " + geoErrorMessage(err);
    });
  });

  /* Reverse-geocode via OpenStreetMap Nominatim; purely cosmetic, fails silently. */
  function lookupAddress(spot) {
    if (!navigator.onLine) return;
    var url = "https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=17" +
              "&lat=" + spot.lat + "&lon=" + spot.lng;
    fetch(url, { headers: { "Accept": "application/json" } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j || !j.display_name) return;
        var addr = j.display_name.split(",").slice(0, 3).join(",");
        [state.current].concat(state.history).forEach(function (s) {
          if (s && s.ts === spot.ts) s.address = addr;
        });
        saveState();
        if (!screens.home.classList.contains("hidden")) renderHome();
      })
      .catch(function () { /* offline or blocked — coords are enough */ });
  }

  /* ---------------- map ---------------- */

  $("#btn-show-car").addEventListener("click", function () {
    if (!state.current) {
      var status = $("#park-status");
      status.className = "park-status err";
      status.textContent = "No saved spot yet — press PARK first.";
      return;
    }
    openMap(state.current);
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
    var list = $("#history-list");
    list.innerHTML = "";
    $("#history-empty").classList.toggle("hidden", state.history.length > 0);

    state.history.forEach(function (spot, i) {
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
    state.history.splice(Number(del.dataset.i), 1);
    saveState();
    renderHistory();
    renderHome();
  });

  $("#btn-clear-history").addEventListener("click", function () {
    if (!confirm("Delete all parking history? Your current park is kept.")) return;
    state.history = [];
    saveState();
    renderHistory();
    renderHome();
  });

  /* ---------------- back buttons & boot ---------------- */

  document.querySelectorAll("[data-back]").forEach(function (btn) {
    btn.addEventListener("click", function () { enterHome(); });
  });

  function boot() {
    var s = session();
    if (!CLOUD) {
      if (s) { state = loadLocalData(s.username); enterHome(); }
      else show("auth");
      return;
    }
    // Cloud: wait for Firebase to restore the auth session (first event only).
    var first = true;
    auth.onAuthStateChanged(function (user) {
      if (!first) return;
      first = false;
      if (user && s && s.uid === user.uid) {
        state = loadLocalData(s.username); // instant paint from cache; snapshot refreshes it
        subscribeCloudData(user.uid);
        enterHome();
      } else {
        clearSession();
        show("auth");
      }
    });
  }

  boot();
})();
