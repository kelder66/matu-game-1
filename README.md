# ✈️ Matu lennumäng

Mitmikmängija 3D lennumäng brauseris. Lendad **Helsingi kohal** päris 3D-linnas
(Google Photorealistic 3D Tiles), kuni **5 pilooti** korraga, sisselogimine ainult
nimega. Lisaks jahib sind **2 robotlennukit**. Kuulipildujaga tulistad teisi —
**10 tabamust ja lennuk plahvatab**.

> **Miks Helsingi, mitte Tallinn?** Google'i fotorealistlikud 3D-plaadid katavad
> reljeefi kogu maailmas, aga **hooneid ja puid ainult avaldatud aladel**. Eestis on
> need ainult Pärnu ja Haapsalu kandis — Tallinn ja Tartu tulevad lameda satelliidipildina
> reljeefi peal, ükskõik mida renderdajaga teha.
> [Kattuvuse kaart](https://developers.google.com/maps/documentation/javascript/3d/coverage)

Töötab desktop Chrome'is ja Safaris. Mobiiliversiooni ei ole.

## Juhtimine

| Klahv | Tegevus |
|---|---|
| ↑ ↓ (või W S) | nina üles / alla |
| ← → (või A D) | kaldu — lennuk pöörab kalde suunas |
| Shift / Ctrl | kiiremini / aeglasemalt (250–790 km/h) |
| Tühik | tulista |
| F | vaheta robotite raskust (ka keset lendu) |

Maapind ei tapa — kui lendad liiga madalale, lennuk lihtsalt ei lähe allapoole.
Ainult kuulid tapavad.

## Robotid

Kaks halli robotlennukit jahivad mängijaid. Nad ei tulista teineteist ja neid saab
alla lasta nagu iga teist lennukit (tulevad 5 s pärast tagasi).

**Raskus ei muuda ainult roboteid — see muudab ka sinu enda sihikut.** Mida raskem,
seda täpsemalt pead ise nina peale saama, et pihta anda. See kehtib ka mängija-vastu-
mängija lahingus.

| Raskus | Sinu sihiku laius | Robotid |
|---|---|---|
| **KERGE** | 65 m — andestab lohaka sihtimise | Aeglased, kalduvad laisalt, sihivad 11° kõrvale, ei hoia ette. Testis ei suutnud 2 minutiga alla tulistada. |
| **KESKMINE** | 40 m | Aus võitlus — pöörab umbes sama järsult kui sina. Testis ~16 s surmani. |
| **RASKE** | 25 m — pead päriselt sihtima | Pöörab sinust 2× järsemalt, sihib täpselt, tulistab 3× tihedamini. Testis ~13 s. |

**Robot on alati kehvem laskur kui inimene.** Sihikule saanud inimene tabab iga
lasuga; robot peab ka siis veel õnne veeretama. Parimal juhul: inimene 10 tabamust
sekundis, robot 0,75 (kerge) / 1,9 (keskmine) / 4,2 (raske) — ehk 13× kuni 2,4×
kehvem, ja praktikas veel palju rohkem, sest robot hoiab sihikut vaid murdosa ajast.
`npm run test:npc` kontrollib seda igal raskusastmel.

Robotite *sihiku nurka* ei saa kitsamaks keerata: nende juhtimine on 20 Hz
bang-bang, nii et nina ei püsi paigal täpsemalt kui ~3,4°. Mõõtsin — kitsama
nurgaga ei muutu nad raskemaks, vaid täiesti kahjutuks (0 tabamust 90 sekundiga).
Seepärast on robotite oskus `aimError`-is ja tabamustõenäosuses, mitte nurgas.

Kaks garanteeritud pääseteed, mille Matu ise avastab: robotid **ei lenda alla 240 m**
ega **üle 3000 m**, ja nende max kiirus on alati väiksem kui sinu 220 m/s. Nad ka
loobuvad, kui viid nad 12 km kaugusele keskusest.

Raskust saab muuta **igaüks igal ajal** (avaekraanil või klahviga `F`) ja see kehtib
kõigile korraga.

## Minikaart

Paremas alanurgas on nina-üles radar 4 km raadiusega. **Punane ring on relva ulatus**
(1500 m) — selle sees saad tulistada. Ringike = inimene tema värvis, hall ruut =
robot, ▲/▼ = kõrgemal/madalamal, servale surutud kolmnurk = kaugemal kui 4 km.

## Kuidas mängida

1. Ava mängu URL (Railway aadress).
2. Kirjuta nimi, vajuta **LENDA**.
3. Kõik alustavad ringis Helsingi kesklinna kohal, et üksteist üles leida.
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
arendada ja testida ilma internetita.

```bash
npm run typecheck   # klient + jagatud kood
npm run build       # vite build -> dist/public, tsc -> dist/server
npm start           # käivitab dist/server/index.js
npm test            # serveri reeglite test  -- NPC_COUNT=0 PORT=3100 npm start
npm run test:npc    # robotite käitumise test -- PORT=3100 npm start
```

Lisa `?debug` URL-i lõppu, et saada konsoolis `window.game` (stseen, olek, võrk).

## Google Maps API võti

Photorealistic 3D Tiles on tasuline (~6 $ / 1000 **root-päringut**, s.o umbes üks
tasu ühe ~3 h mängusessiooni kohta — **mitte** iga tile'i eest) ja vajab arveldusega
Google Cloud kontot. Seetõttu ei maksa kaardi detailsuse tõstmine (`errorTarget`
failis `src/client/scene.ts`) mitte midagi — kulub ainult ribalaius ja mälu.

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
  toakoodideta. Robotid elavad samuti serveris (`src/server/bots.ts`) ja lendavad
  **sama `integrate()`-iga** kui mängijad (`src/shared/flight.ts`), nii et nad ei saa
  teha midagi, mida mängija ei saaks.
- **Autoriteet on jagatud:** positsiooni omab klient (null latentsi juhtimisel),
  **tervist omab server** (tabamusi ei saa võltsida). Server valideerib iga
  tabamuse: mõlemad elus, olek värske, tulekiirus token bucket'iga piiratud,
  kaugus ≤ 2 km.
- **Võrgus** liigub 20 Hz snapshot. Kaugete lennukite asukoht interpoleeritakse
  ECEF-is 120 ms puhvriga — lat/lon interpoleerimine katkeks 180. meridiaanil.
- Kogu lennumudel on **dt-põhine** (meetrit sekundis), nii et 120 Hz ekraanil ei
  lenda lennuk kaks korda kiiremini.
