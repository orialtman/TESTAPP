# 🅿️🚗 Where's My Car?

A tiny app that remembers where you parked. No server, no app store — it's a
single web page that runs entirely on your phone. Your account and parking
spots are stored only on your device (browser `localStorage`).

## What it does

- **Sign up** with a username plus optional email and phone — **no
  verification of any kind**; the account works the moment you create it.
  Log in later with your username, email, *or* phone number.
- **PARK** — the big green circle. Press it when you leave your car and it
  saves your current GPS location as your **current park** (with a street
  address when online).
- **SHOW ME WHERE MY CAR IS** — opens a map with a 🚗 marker on your car, a
  🧍 marker following you live, the distance between you, and a one-tap
  **Navigate with Google Maps** button.
- **Current park / Last park** — both are always visible on the home screen.
- **History** — every time you press PARK, the previous spot moves into the
  history screen (newest first). Entries can be deleted one by one or all at
  once; each one links to Google Maps.

## Running it

Location access in browsers requires **HTTPS** (or `localhost`), so the
easiest way to use it on your phone is GitHub Pages:

1. On GitHub: **Settings → Pages → Source: Deploy from a branch → `main` /
   `/ (root)`** → Save.
2. Open `https://<your-username>.github.io/wheres-my-car/` on your phone and
   allow location access.
3. Optional: use your browser's **Add to Home Screen** so it feels like a
   native app.

For local development: `python3 -m http.server` and open
`http://localhost:8000`.

## Behavioral contract (spec)

- **FR-1 Signup.** WHEN a visitor submits a username (2–32 chars) and a
  password (≥4 chars), with optional email/phone, THE APP SHALL create the
  account instantly and log them in — no email link, no SMS code, no captcha.
- **FR-2 Login.** WHEN a user submits username OR email OR phone plus their
  password, THE APP SHALL log them in; the session persists across restarts
  until logout.
- **FR-3 Park.** WHEN PARK is pressed and location permission is granted,
  THE APP SHALL save the device's coordinates (+timestamp, +accuracy) as the
  current park and confirm on screen. IF permission is denied or the fix
  fails, THE APP SHALL show why and save nothing.
- **FR-4 Rotation.** WHEN PARK is pressed while a current park exists, THE
  APP SHALL move that spot to the top of history before saving the new one —
  so "last park" is always the previous press.
- **FR-5 Show my car.** WHEN "SHOW ME WHERE MY CAR IS" is pressed with a
  saved spot, THE APP SHALL show the spot on a map with live distance and a
  Google Maps walking-navigation link. Without a saved spot it SHALL say so.
- **FR-6 History.** THE APP SHALL list all past parks newest-first with time
  and place; items are individually deletable, and Clear empties history
  while keeping the current park.
- **FR-7 Isolation.** Each username's parks are stored separately; logging
  in as another user on the same device never shows someone else's spots.

## Honest limitations

- Accounts are **per device** (that's the price of "no server, no
  verification"). Clearing browser data erases them.
- The password gate is a convenience lock, not real security — anyone with
  your unlocked phone can read `localStorage`.
- The map tiles (OpenStreetMap) and address lookup (Nominatim) need
  internet; parking and coordinates work offline once the page is loaded.
