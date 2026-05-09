# Verkeerslicht

Een kleine app die op basis van publieke data van slimme verkeerslichten
(iVRI's) toont wanneer een licht groen of rood wordt. De app abonneert zich
op de SPaT/MAP-feed van **Talking Traffic / UDAP** (de MQTT-koppeling van het
NDW-ecosysteem) en publiceert per kruising en signaalgroep de huidige fase
plus een aftelling tot de volgende fasewissel.

Zonder credentials draait de app in **demomodus** met een gesimuleerd
verkeerslicht, zodat je de UI direct kunt zien werken.

## Wat zit erin

- `app/mqtt_client.py` - MQTT-subscriber die SPaT- en MAP-berichten leest.
- `app/decoder.py` - tolerante JSON-parser voor SPaT/MAP (zie limitaties).
- `app/state.py` - in-memory store van laatst bekende fases per signaalgroep.
- `app/demo.py` - simulator van een 40s-cyclus voor offline gebruik.
- `app/api.py` - FastAPI met REST-endpoints en statische UI.
- `static/index.html` - eenvoudige web-UI met aftelling per signaalgroep.

## Snelle start (demomodus)

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env       # laat UDAP_* leeg voor demomodus
python -m app.main
```

Open <http://localhost:8000>. Je ziet een gesimuleerd verkeerslicht met
aftelling. De API is bereikbaar onder `/api`:

- `GET /api/health` - status van de service
- `GET /api/intersections` - lijst bekende kruisingen
- `GET /api/intersections/{id}` - kruising + alle signaalgroepen
- `GET /api/signals/{id}/{signal_group}` - huidige status van één signaal

## Live data via NDW / Talking Traffic

Slimme verkeerslichten in Nederland publiceren SPaT (Signal Phase and
Timing) en MAP (topologie) berichten op de UDAP MQTT-broker, beheerd door
Monotch namens NDW. Dit is publieke data, maar de toegang vereist wel een
account.

1. Vraag toegang aan bij Monotch (de beheerder van UDAP). Relevante
   ingangen:
   - **UDAP-beheerportaal**: <https://udap-home.tlex.eu/> - hier vraag je
     TLC-ID's aan en beheer je je objecten.
   - **Kaartviewer met live iVRI-status**: <https://map.udap.nl/app/> -
     handig om te zien welke kruisingen aangesloten zijn.
   - **Monotch support / FAQ**: <https://monotch.freshdesk.com/>.
   - **Achtergrond + contact**: <https://monotch.com/nl/implementation/udap/>.
   Voor commerciële applicaties of grootschalige datatoegang loopt het
   verzoek via Monotch zelf (e-mail of het supportportaal). Voor
   wegbeheerders en service providers van iVRI's is er een aparte
   onboarding-procedure beschreven op Freshdesk.
2. Na goedkeuring krijg je MQTT-credentials en een hostnaam. Vul ze in
   `.env`:

   ```env
   UDAP_HOST=<broker-host>
   UDAP_PORT=8883
   UDAP_USERNAME=<gebruiker>
   UDAP_PASSWORD=<wachtwoord>
   UDAP_USE_TLS=true
   UDAP_SPAT_TOPIC=topicroot/+/+/SPATEM/#
   UDAP_MAP_TOPIC=topicroot/+/+/MAPEM/#
   ```

3. Start opnieuw met `python -m app.main`. Zodra MAP-berichten binnenkomen
   verschijnen kruisingen onder `/api/intersections`; SPaT-berichten vullen
   per signaalgroep de fase en aftelling.

> **Topicpatroon:** elke leverancier heeft een eigen `topicroot`. Het
> standaardpatroon (`topicroot/+/+/SPATEM/#`) abonneert breed; pas hem aan
> als je je tot één regio of kruising wilt beperken.

## Beperkingen

- De UDAP-feed publiceert standaard **UPER-encoded ASN.1** (SAE J2735 /
  ISO TS 19091). Deze app verwacht de **JSON-interpretatie** die UDAP
  optioneel aanbiedt op aparte topics. Wil je de binaire feed lezen, voeg
  dan een ASN.1-decoder toe (bijv. `asn1tools` met de J2735-grammatica) en
  roep die aan in `app/decoder.py` voordat de JSON-parser wordt geprobeerd.
- De aftelling gebruikt het `likelyTime`-veld van J2735; iVRI's mogen dit
  bijstellen op basis van detectoren, dus de waarde is een *prognose*, geen
  garantie. Voor remgedrag of automatische besluitvorming is altijd een
  veiligheidsmarge nodig.
- Tijdvelden in J2735 zijn tienden van seconden binnen het huidige uur. We
  zetten deze om naar epoch met de aanname dat de klok gelijk loopt met
  de bron; bij grote klokafwijking kan de aftelling tot ~1 uur verspringen.

## Deploy naar GitHub Pages

GitHub Pages serveert alleen statische bestanden, dus alleen de **demomodus**
(JS-simulator in de browser) draait daar - geen MQTT, geen live UDAP-data.
Voor live data heb je een server nodig (Fly.io, Render, eigen VPS, etc.).

Setup:

1. Push deze repo naar GitHub.
2. Open in GitHub: **Settings → Pages**, en zet **Source** op
   *GitHub Actions*.
3. De workflow `.github/workflows/pages.yml` bouwt en publiceert
   `static/` bij elke push naar `main` of de feature-branch. Je kunt hem
   ook handmatig draaien via **Actions → Deploy verkeerslicht-demo →
   Run workflow**.
4. Na ~1 min staat de demo op
   `https://<gebruiker>.github.io/<repo>/`.

De pagina detecteert vanzelf of er een backend is: bestaat `/api/health`,
dan praat hij met de FastAPI; zo niet, dan draait er een browser-side
40-seconden cyclus (groen 15s, geel 3s, rood 22s) zodat je de UI kunt
zien.

## Volledig en gratis live laten draaien

Voor live UDAP-data heb je twee dingen nodig:

### 1. UDAP-credentials (de echte hobbel)

Toegang tot de MQTT-feed van Talking Traffic loopt via **Monotch** en
**NDW**. Er is geen self-service "developer signup". Wat je kunt
proberen:

- **Studenten / onderzoek**: e-mail Monotch (zie
  <https://monotch.com/contact/>) of NDW (<https://www.ndw.nu/contact>)
  met een korte projectomschrijving en vraag om dev-toegang.
- **Wegbeheerder of leverancier**: vraag een TLC-ID/account aan via
  <https://udap-home.tlex.eu/> en de procedure op
  <https://monotch.freshdesk.com/>.
- **Geen toegang? Demomodus**: alles werkt verder hetzelfde, alleen met
  gesimuleerde data.

Zonder credentials valt de app automatisch terug op demomodus, dus je
kunt alvast deployen en de creds later toevoegen.

### 2. Een server die altijd aan staat

GitHub Pages serveert geen Python en Render-/Railway-/Vercel-serverless
slaapt na inactiviteit (de MQTT-subscription valt dan weg). Je hebt iets
nodig dat 24/7 één proces draait. Drie écht gratis opties:

| Optie                      | Gratis?      | Setup           | Opmerking |
|----------------------------|--------------|-----------------|-----------|
| **Oracle Cloud Free Tier** | Ja, voor altijd (Always Free) | VM, Docker | 1 ARM Ampere VM (4 cores / 24GB) of 2 AMD micro-VMs. Creditcard nodig voor verificatie, niet voor afrekenen. Meest robuust. |
| **Fly.io**                 | Met `$5` trial-credit; daarna ~`$2/mnd` voor 1 shared-cpu/256MB | `fly deploy` | Eenvoudigste DX. Zie `fly.toml`. |
| **Eigen Pi/PC**            | Stroom + thuisinternet | Docker + Cloudflare Tunnel of Tailscale Funnel | `docker build -t verkeerslicht . && docker run -p 8000:8000 ...`. Cloudflare Tunnel geeft je gratis publieke HTTPS-URL. |

**Slaapwekkers (Render free, Vercel, Cloud Run idle scale-to-zero)
zijn ongeschikt** — een MQTT-subscription overleeft een sleep niet.

### 3. Aan elkaar knopen

1. Deploy de backend met Docker (zie `Dockerfile`). Voorbeeld Fly.io:
   ```bash
   fly launch --no-deploy --copy-config       # eerste keer; pas app-naam aan
   fly secrets set UDAP_HOST=... UDAP_PORT=8883 \
                   UDAP_USERNAME=... UDAP_PASSWORD=... \
                   UDAP_USE_TLS=true \
                   CORS_ORIGINS="https://<gebruiker>.github.io"
   fly deploy
   ```
2. Op je Pages-pagina: vul bij **API-URL** je backend-URL in (bv.
   `https://verkeerslicht.fly.dev`) en klik **Opslaan**. De badge
   springt op "Live".
3. Werkt het niet? Check `fly logs` (of `docker logs`). Meest voorkomende
   fouten: verkeerd MQTT-topic, of CORS niet ingesteld op de Pages-URL.

### 4. Helemaal zonder server (alleen demo)

Heb je geen UDAP-creds en geen zin in een VM? Skip alles hierboven en
laat de Pages-deploy staan. Je krijgt dan een werkend UI met een
gesimuleerd verkeerslicht — perfect voor demo's of als presentatie van
het idee.

## Andere bronnen

- **NDW Open Data Portal** (<https://opendata.ndw.nu>) - historische en
  geaggregeerde datasets (bv. doorstroming, meetpunten). Geen live SPaT.
- **Open Traffic Lights** (vroegere proef in Vlaanderen/NL) - publiceerde
  Linked Data over verkeerslichten; status verschilt per gemeente.

## Licentie

MIT.
