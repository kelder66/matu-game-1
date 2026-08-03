# ✈️ Matu lennumäng

Mitmikmängija 3D lennumäng brauseris. Lendad lennukiga päris maailma kohal (Google
Photorealistic 3D Tiles), kuni **5 pilooti** korraga, sisselogimine ainult nimega.
Kuulipildujaga tulistad teisi — **10 tabamust ja lennuk plahvatab**.

Töötab desktop Chrome'is ja Safaris. Mobiiliversiooni ei ole.

## Juhtimine

| Klahv | Tegevus |
|---|---|
| ↑ ↓ (või W S) | nina üles / alla |
| ← → (või A D) | kaldu — lennuk pöörab kalde suunas |
| Shift / Ctrl | kiiremini / aeglasemalt (250–790 km/h) |
| Tühik | tulista |

Maapind ei tapa — kui lendad liiga madalale, lennuk lihtsalt ei lähe allapoole.
Ainult kuulid tapavad.

## Kuidas mängida

1. Ava mängu URL (Railway aadress).
2. Kirjuta nimi, vajuta **LENDA**.
3. Kõik alustavad ringis Tallinna vanalinna kohal, et üksteist üles leida.
   HUD-i kollane nool näitab lähima vastase suunda.
4. Kui plahvatad, vajuta **LENDA UUESTI** — lehte ei pea uuesti laadima.

## Arendus

```bash
npm install
npm run dev
```

Avab Vite'i `http://localhost:5173` (HMR-iga) ja Fastify serveri pordil 3000.
Vite proksib `/api` ja `/ws` serverile.

**Ilma Google API võtmeta töötab mäng samuti** — siis on kaardi asemel lihtne
roheline maakera koos ruudustikuga ja HUD-is on silt "OFFLINE KAART". Nii saab
arendada ja testida ilma kvooti põletamata.

```bash
npm run typecheck   # klient + jagatud kood
npm run build       # vite build -> dist/public, tsc -> dist/server
npm start           # käivitab dist/server/index.js
npm test            # serveri reeglite test (server peab käima pordil 3100)
```

Lisa `?debug` URL-i lõppu, et saada konsoolis `window.game` (stseen, olek, võrk).

## Google Maps API võti

Photorealistic 3D Tiles on tasuline (~6 $ / 1000 lehe laadimist) ja vajab
arveldusega Google Cloud kontot.

1. [Cloud Console](https://console.cloud.google.com) → loo projekt → **lülita
   arveldus sisse**.
2. APIs & Services → Library → luba **Map Tiles API**
   (mitte "Maps JavaScript API" — see on vale).
3. Credentials → Create credentials → **API key**.
4. **Piira võti kahtpidi** (see on brauseri võti, mis on lehel nähtav):
   - *Application restrictions* → **Websites (HTTP referrers)**:
     `http://localhost:5173/*`, `http://localhost:3000/*`,
     `https://<sinu-app>.up.railway.app/*`
   - *API restrictions* → **Restrict key** → ainult **Map Tiles API**
5. Billing → **Budgets & alerts** → tee eelarve ja e-posti hoiatus. See on ainus
   kaitse selle vastu, et unustatud lahtine tab öö läbi tile'e laeb.

Kui kaart jääb lokaalselt mustaks ja konsoolis on 403 — 90% juhtudest on põhjus
see, et localhost pole referrer'ite nimekirjas.

## Deploy (Railway)

Railway seadistus on sama, mis eelmisel mängul — `railway.json` ja `nixpacks.toml`
ei muutunud:

- build: `npm install && npm run build`
- start: `npm start`
- healthcheck: `/health`

Ainus asi, mis on vaja lisada: Railway → projekt → **Variables** →
`GOOGLE_MAPS_API_KEY = <võti>` → redeploy.

Kontrolli pärast deploy'd:
- `https://<app>/health` → `{"status":"ok"}`
- `https://<app>/api/config` → `googleMapsApiKey` ei ole `null`
- DevTools → Network → WS → `101 Switching Protocols`

## Kuidas see töötab

- **Klient** (`src/client`) — three.js + `3d-tiles-renderer`. Maailmaruum on ECEF
  (Maa-keskne, Z üles), täpselt see, mida ellipsoidi matemaatika toodab. Lennuki
  ja kaamera asukoht tuleb `WGS84_ELLIPSOID.getObjectFrame(lat, lon, alt, hdg,
  pit, rol, ...)`-ist.
- **Server** (`src/server`) — Fastify + `ws`. Üks globaalne maailm, ilma
  toakoodideta.
- **Autoriteet on jagatud:** positsiooni omab klient (null latentsi juhtimisel),
  **tervist omab server** (tabamusi ei saa võltsida). Server valideerib iga
  tabamuse: mõlemad elus, olek värske, tulekiirus token bucket'iga piiratud,
  kaugus ≤ 2 km.
- **Võrgus** liigub 20 Hz snapshot. Kaugete lennukite asukoht interpoleeritakse
  ECEF-is 120 ms puhvriga — lat/lon interpoleerimine katkeks 180. meridiaanil.
- Kogu lennumudel on **dt-põhine** (meetrit sekundis), nii et 120 Hz ekraanil ei
  lenda lennuk kaks korda kiiremini.
