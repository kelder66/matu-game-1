# ✈️ Matu lennumäng

Mitmikmängija 3D lennumäng brauseris. Lendad päris 3D-linna kohal (Google
Photorealistic 3D Tiles), kuni **5 pilooti** korraga, sisselogimine ainult nimega.
Lisaks jahib sind **2 robotlennukit**. Kuulipildujaga tulistad teisi — **10 tabamust
ja lennuk plahvatab**.

## Linnad

Avaekraanil valid linna; keegi saab seda ka keset mängu muuta, siis kolib **kogu
maailm** korraga (kõik mängijad ja robotid teisaldatakse uue linna ringile).

Iga linna nupul on märge: roheline **3D** = päris hooned ja puud, kollane **2D** =
ainult reljeef ja satelliidipilt.

| Linn | Märge |
|---|---|
| Helsingi, Pärnu, München, San Francisco, New York | **3D** |
| Tallinn | **2D** |

Google'i 3D-plaadid katavad reljeefi kogu maailmas, aga **hooneid ja puid ainult
avaldatud aladel**. Eestis on need ainult Pärnu ja Haapsalu kandis. Tallinn on
nimekirjas sees, sest see on kodulinn, aga nupul on hoiatus `lame` — ükski
renderdaja seadistus seda ei muuda.
[Kattuvuse kaart](https://developers.google.com/maps/documentation/javascript/3d/coverage)

Uue linna lisamine on üks rida `CITIES`-massiivis failis `src/shared/protocol.ts`.
Oluline: `groundAlt` on **ellipsoidi meetrites** (maapind merepinnast + geoidi vahe,
Läänemerel +19 m, Baieris +48 m, USA rannikul −32 m). Sellest arvutatakse nii
stardikõrgus kui robotite põrand — München on 565 m kõrgusel ja vale number saadaks
robotid maa alla.

Töötab arvutis (Chrome, Safari) ja **telefonis** (puutejuhtimine, landscape).

## Juhtimine

| Klahv | Tegevus |
|---|---|
| ↑ ↓ (või W S) | nina üles / alla |
| ← → (või A D) | kaldu — lennuk pöörab kalde suunas |
| Shift / Ctrl | kiiremini / aeglasemalt |
| Tühik | tulista |
| F | vaheta robotite raskust (ka keset lendu) |

### Telefonis

Keera telefon **külili** (portree-asendis palub mäng seda ise).

| Juhtnupp | Tegevus |
|---|---|
| Vasak pöialnupp | lohista: üles/alla = nina, vasakule/paremale = kalle |
| **TULI** (paremal all) | tulista |
| **+ / −** | kiiremini / aeglasemalt |

Pöialnupp on **analoog** — pool väljalööki annab poole kaldest, nii et saab teha ka
loivi kurvi, mitte ainult järsku pööret. Mõlemat pöialt saab korraga kasutada
(pöörad ja tulistad ühtaegu).

Puutejuhtimise kaks reeglit, mis said kalli õppetunni hinnaga selgeks:

1. **Sõrme tõstmist kuulatakse `window` peal, mitte nupu peal.** Kui kuulata ainult
   elemendi peal ja sõrm libiseb nupult ära, ei jõua `pointerup` kohale, juhtnupp
   jääb igavesti "alla vajutatuks" ja lennuk lendab kinnijäänud kaldega. Kinni jäänud
   gaasinupp ei tundu katkise nupuna — see tundub nii, nagu lennuk oleks aeglane.
2. **`touch-action` ei päri.** `body` peal ei aita see canvas'it kuidagi; kui sõrm
   tulistamisnupust mööda läheb, suumib brauser mängu nurka. Iga kiht, kuhu sõrm
   maanduda saab, peab žestidest ise keelduma.

Lisa URL-i lõppu `?touch`, et puutejuhtimist ka arvutis proovida.

Maapind ei tapa — kui lendad liiga madalale, lennuk lihtsalt ei lähe allapoole.
Ainult kuulid tapavad.

**Kiirusnäidik näitab tegelikku kiirust üle maa** — see mõõdab päris läbitud
vahemaad sekundis, mitte lennuki nominaalset õhkkiirust. Nii ei saa see valetada ja
langeb ka õigesti tõusul/sukeldumisel, kus ainult horisontaalne osa on kiirus üle
maa.

Simulatsioon jaguneb **alamsammudeks** (`MAX_STEP` failis `main.ts`). Varem lõikas
üksainus 0,1 s klamber madala kaadrisageduse juures aega maha ja lennuk lendas
päriselt aeglasemalt kui näidik lubas — telefonis, kus plaadid koormavad GPU-d, oli
see selgelt näha. Mõõdetud 3 fps juures: enne 101 km/h, nüüd 384 km/h (nominaalne
720). `MAX_FRAME` 0,5 s hoiab endiselt ära selle, et taustal olnud vahekaart
lennukit üle planeedi teleporteeriks.

Madalaim lubatud kõrgus on **40 m maapinnast**, ehk katuseid saab riivata. See on
võimalik ainult tänu sellele, et maapinna tuvastus vaatab **1,6 s ette** (mitte
ainult otse alla) ja tõuseb kiiresti, aga laskub aeglaselt — vastasel juhul lendaks
130 m/s juures katusest läbi enne, kui jõuab tõusta.

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
(sina saad 40 m peale) ega **üle 3000 m**, ja nende max kiirus on alati väiksem kui sinu 220 m/s. Nad ka
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

Lisa `?debug` URL-i lõppu, et saada konsoolis `window.game` (stseen, olek, võrk),
ja `?touch`, et sundida puutejuhtimine arvutis nähtavale.

Telefonis on kaart meelega jämedam (`errorTarget` 22 vs 12), pikslitihedus piiratud
1,5-ga, antialias väljas ja tile-cache 250 MB — muidu telefon ei jaksa ega jõua
laadida.

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
