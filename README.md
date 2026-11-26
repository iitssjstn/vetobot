# vetobot

Een crypto trading bot voor **Bitvavo**. Een regelgebaseerde strategie geeft de signalen, een AI naar keuze mag koopsignalen **afwijzen** (veto), en harde limieten in code bewaken het risico. Standaard draait hij in **paper trading**: er worden geen echte orders geplaatst.

Puur Node.js, zonder NumPy of native code, dus hij draait ook op oudere CPU's.

## Hoe het werkt

Elke check (standaard elke 15 minuten, instelbaar in het dashboard) loopt de bot alle pairs langs:

1. **Open positie?** Dan eerst stop-loss en take-profit checken, daarna het verkoopsignaal. Verkopen gaat **nooit** langs de AI, zodat een AI-fout een stop-loss niet kan blokkeren.
2. **Koopsignaal** (EMA fast kruist boven EMA slow, RSI onder `RSI_MAX_ENTRY`)? Dan eerst de harde regels: maximaal aantal open trades, dagelijkse verlieslimiet en saldo.
3. Komt het signaal daardoor, dan krijgt de **AI** de indicatoren en de laatste candles, en antwoordt met `approve` of `reject` plus een reden.
4. Alles wordt gelogd en is te zien in het dashboard.

De AI denkt als een winstgerichte trader: hij keurt een koopsignaal goed als de verwachte winst na fees het risico tot de stop-loss waard is, en wijst af als de beweging te klein is, de coin al op een top staat of de markt tegenzit. Hij krijgt daarvoor je fees, stop-loss, take-profit en trailing stop mee. De AI bepaalt nooit bedragen of stop-losses. Wel kan hij optioneel een positie die in de winst staat eerder laten verkopen (zie **Sneller winst nemen** hieronder). Reageert de AI niet, geeft hij onzin terug of is er geen AI-key, dan wordt de trade afgewezen (`AI_FAIL_MODE=reject`).

De strategie kijkt alleen naar **gesloten** candles, en elke candle wordt maar één keer beoordeeld.

## API-keys en account

API-keys komen **nooit** in env-variabelen of `.env`-bestanden. Je vult ze in via het dashboard:

- Ze worden versleuteld (AES-256-GCM) opgeslagen in `data/users/<id>/secrets.enc`, per gebruiker met een eigen sleutel.
- De sleutel daarvoor wordt bij de eerste start willekeurig gemaakt in `data/master.key`.
- Na het opslaan zie je alleen nog of een key is ingesteld en de laatste 4 tekens.

Dit beschermt tegen uitlekken via git, losse backups of het dashboard. Iemand met root op de server kan bij beide bestanden; dat geldt voor elke manier van opslaan op disk. Maak je een backup, neem dan de hele `data/`-map mee (`master.key` en de mappen in `users/`), anders zijn de keys niet meer te ontsleutelen.

### First-run setup

Bij de eerste start bestaat er nog geen account. De bot print dan een eenmalige **setup-code** in de logs:

```bash
docker compose logs vetobot
```

Open het dashboard, vul de setup-code in en kies een gebruikersnaam en wachtwoord (minimaal 10 tekens) voor het admin-account. Daarna verdwijnt de setup en kun je alleen nog inloggen. De code zorgt ervoor dat alleen iemand met toegang tot je server het account kan aanmaken.

Wachtwoorden worden alleen als scrypt-hash opgeslagen in `data/users.json`. Na 5 mislukte inlogpogingen wordt dat IP 5 minuten geblokkeerd. Hoofdletters in de gebruikersnaam maken bij het inloggen niet uit. Gebruikersnaam en wachtwoord wijzig je bij Instellingen → Account.

Admin-wachtwoord vergeten? Stop de container, hernoem `data/users.json` en start opnieuw voor een nieuwe setup. Let op: daarmee verdwijnen ook de andere accounts uit de lijst (hun mappen in `data/users/` blijven staan).

Kwam je van een versie met één account? Dan worden `data/auth.json`, je instellingen, trades en keys bij de eerste start automatisch overgezet naar het admin-account.

## AI-providers

| `AI_PROVIDER` | Wat | Standaardmodel |
|---|---|---|
| `none` | Geen AI, elk signaal gaat door. Handig als nulmeting. | – |
| `gemini` | Google Gemini, gratis key via [aistudio.google.com](https://aistudio.google.com) | `gemini-3.8-flash` |
| `openai` | Elke OpenAI-compatibele API: Groq (standaard), OpenRouter, Ollama, ... | `llama-3.3-70b-versatile` |

De AI-key vul je in via het dashboard. Met **Ophalen** naast het modelveld zie je welke modellen je key mag gebruiken. Met de knop **AI testen** stuur je een testvraag met actuele data van je eerste coin. Je ziet dan het antwoord, het model en de reactietijd, of de echte foutmelding als het misgaat (bijvoorbeeld een ongeldige key, een onbekend model of een rate limit). Er wordt daarbij geen trade geplaatst. Voor een andere OpenAI-compatibele provider zet je `AI_BASE_URL`, bijvoorbeeld `https://openrouter.ai/api/v1`.

Tip: draai een tijd met `none` en daarna met een AI, en vergelijk de resultaten in het dashboard. Zo zie je of de veto echt helpt.

### AI-volgorde (back-upmodellen)

Bij AI-veto zet je maximaal 5 modellen op volgorde, elk met een eigen provider, model en key. Faalt een model (fout, time-out, quota op of een onleesbaar antwoord), dan probeert vetobot het volgende. Een afwijzing is een geldig antwoord; dan gaat hij niet verder naar de volgende.

- Laat je de key van een model leeg, dan gebruikt het de key van een eerder model met dezelfde provider (en base-URL). Zo kun je bijvoorbeeld twee Gemini-modellen met één key gebruiken.
- Met ↑ en ↓ verander je de volgorde; de keys verhuizen mee.
- **Alle modellen testen** stuurt elk model een testvraag en laat per model zien of het werkt.
- Neemt een back-up het over, dan krijg je een Discord-melding. Falen alle modellen, dan krijg je een melding met tag en de fout van elk model, en volgt het signaal je instelling bij "Als alle modellen falen".
- Dezelfde volgorde wordt ook gebruikt voor het dagoverzicht.

## Installeren in je bestaande Docker Compose

De GitHub Action bouwt bij elke push naar `main` de image `ghcr.io/iitssjstn/vetobot:latest`.

Voeg de service toe aan je `docker-compose.yml`. Hier staan alleen instellingen in, geen keys:

```yaml
  vetobot:
    image: ghcr.io/iitssjstn/vetobot:latest
    container_name: vetobot
    restart: unless-stopped
    pull_policy: always
    networks:
      - media
    dns:
      - 1.1.1.1
      - 1.0.0.1
    environment:
      - TZ=Europe/Amsterdam
    ports:
      - "127.0.0.1:3020:3000"
    volumes:
      - ./vetobot/data:/app/data
```

```bash
mkdir -p vetobot/data && sudo chown 1000:1000 vetobot/data
docker compose up -d vetobot
docker compose logs vetobot     # hier staat de setup-code
```

Het dashboard staat dan op `http://127.0.0.1:3020` (via een SSH-tunnel). Via Nginx Proxy Manager forward je naar `vetobot` op poort `3000`. Doe de first-run setup dan meteen, en zet bij voorkeur HTTPS aan.

De image is publiek, dus inloggen bij ghcr.io is niet nodig. Krijg je bij `docker compose pull` toch `denied`, zet dan op GitHub bij Packages → vetobot → Package settings de visibility op Public.

## Instellingen

Naast elk veld bij Planning, Risico & inzet en Strategie staat een **?** met uitleg: wat het doet, wat hoger of lager betekent en een gebruikelijke waarde. Bij Strategie staat ook een uitleg in gewone taal over candles, EMA, kruisingen en RSI, plus drie voorbeeldinstellingen (rustig, gemiddeld, actief) om mee te beginnen. Die passen alleen planning, stop-loss, take-profit, afkoelperiode en strategie aan, nooit je inzet of limieten.

In het dashboard onder **Instellingen** regel je:

- **Handelsmodus**: paper of live (zie hieronder)
- **Planning**: hoe vaak de bot checkt (10 seconden tot 60 minuten) en de candle-tijd (1 minuut tot 1 dag). Checks onder de minuut geven geen extra koopsignalen, maar de stop-loss en take-profit reageren sneller. Het dashboard waarschuwt als je met veel coins tegen de rate limit van Bitvavo aanloopt.
- **Risico & inzet**: inzet per trade, maximaal aantal open trades, stop-loss, take-profit, dagelijkse verlieslimiet (telt ook open verliezen mee), fee, afkoelperiode na een verkoop en slippage in paper. Stop-loss, take-profit en daglimiet kun je met 0 uitzetten
- **Strategie**: EMA fast, EMA slow, RSI-periode, maximale RSI bij instap, en optionele filters: trend-EMA (alleen kopen boven de lange trend), minimale ADX (zijwaartse markten overslaan), volumefilter en BTC-filter (geen altcoins als Bitcoin daalt)
- **Strategieën**: bovenaan Instellingen staan acht kant-en-klare strategieën, van Zeer voorzichtig (4-uurscandles, alle filters, een paar trades per maand) tot Zeer riskant (minuutcandles, geen filters). Toepassen zet planning, strategie, filters en stops; inzet, max. open trades en daglimiet blijven van jezelf. Het profiel dat je nu gebruikt, wordt gemarkeerd.
- **AI-team** (bij AI-veto → Werkwijze): in plaats van één model overleggen drie AI's per koopsignaal. Model 1 is de **analist**, model 2 de **criticus** (zoekt bewust wat er mis kan gaan) en model 3 de **beslisser**. Met minder modellen speelt een model meerdere rollen; faalt er een, dan neemt het volgende de rol over. Signalen die al op een harde eis afvallen, worden niet besproken. Het hele gesprek lees je terug op de pagina **AI-chat** (bij AI-signalen staat een link "Bekijk gesprek"). Kost ongeveer drie keer zoveel AI-vragen. De winstcheck blijft één model.
- **AI-strengheid** (bij Strategie): streng, normaal (standaard) of soepel. Bepaalt de harde eisen van de AI (trendsterkte, volume, RSI, hoe ver de koers al gestegen is, kosten ten opzichte van je stop-loss) en hoeveel verwachte winst hij minimaal wil zien. Wat je zelf bij Strategie instelt (max RSI, minimale ADX, volumefilter, BTC-filter) gaat voor. De AI krijgt je stop-loss, take-profit en kosten per ronde (ook met limietorders) als getallen mee, plus zijn eerdere beslissingen in die coin en hoe die afliepen.
- **Bescherming tegen whipsaw**: op korte candles kruisen de lijnen vaak heen en weer, waardoor de bot koopt en kort daarna met verlies verkoopt. Daarom verkoopt hij op het verkoopsignaal pas als EMA fast **Verkoopsignaal bevestigen** candles op rij (standaard 2) onder EMA slow ligt, en als de positie **Minimaal in positie** candles (standaard 3) open staat. Stop-loss, trailing stop, take-profit en de AI-winstcheck werken altijd direct.
- **Resultaatanalyse**: bovenaan de Trades-pagina zie je hoe je trades eindigden (stop-loss, verkoopsignaal, AI, take-profit), gemiddelde winst tegenover gemiddeld verlies, betaalde fees, resultaat per coin en concrete tips.
- **Snelheid**: bij elke check haalt de bot de koersen en candles van al je coins tegelijk op (maximaal 8 verzoeken tegelijk) voordat hij ze één voor één beoordeelt. Met **Maximale tijd in positie** verkoopt hij een positie na een ingestelde tijd, ook zonder signaal (standaard uit).
- **Limietorders**: stand **Alleen winst nemen** koopt direct met een market order en neemt winst met een limietorder (± 0,1% goedkoper per ronde, zonder gemiste instappen). Met **Kopen en winst nemen** koopt de bot met een post-only limietorder op de biedprijs en neemt hij winst met een limietorder op de laatprijs. Je betaalt dan de maker-fee van Bitvavo (0,15%) in plaats van de taker-fee (0,25%), zo'n 0,2% minder per ronde. Wordt een koop niet binnen de wachttijd (standaard 20 sec) gevuld, dan gaat hij niet door; een verkoop gaat dan alsnog market. Stop-loss, ATR-stop, trailing stop en handmatig sluiten zijn altijd market. Standaard uit.
- **Winst herinvesteren**: met **Winst herinvesteren** (%) groeit de inzet per trade mee met je gerealiseerde winst in de huidige modus: inzet = je eigen inzet + winst × % ÷ max. open trades. Verlies haalt het extra deel weer weg, maar de inzet komt nooit onder je eigen inzet. Met **Max. inzet per trade** zet je er een plafond op. In live gelden je saldo en budgetplafond nog steeds. Standaard uit (0).
- **Sneller winst nemen**: open posities worden elke paar seconden bewaakt (**Posities bewaken elke**, standaard 15 sec), los van de gewone check. Stop-loss, trailing stop en take-profit gaan dus direct af, niet pas bij de volgende check. Met **AI mag winst nemen vanaf** (standaard 1%) vraagt de bot de AI, zodra een positie zoveel in de winst staat, of hij de winst nu moet nemen; hooguit eens per **AI-winstcheck hooguit elke** minuten (standaard 3) per positie. De AI kan alleen eerder verkopen, nooit later; de stops blijven altijd gelden. Volgers verkopen mee met de admin en vragen zelf geen AI.
- **Actuele signalen**: een kruising telt alleen als hij vers is, dus op een candle die sinds de vorige check is bijgekomen. Na een herstart koopt de bot niet op een kruising van uren geleden. Met **Max. stijging sinds signaal** (standaard 1%) slaat hij een aankoop over als de koers sinds het signaal al verder is gestegen. Met **Lopende candle meenemen** telt ook de candle die nog loopt mee: sneller, maar met meer valse signalen (standaard uit).
- **Slimmer uitstappen**: trailing stop vanaf het hoogste punt sinds aankoop, en een ATR-stop die de vaste stop-loss vervangt en meebeweegt met de beweeglijkheid van de coin
- **Paper-account**: opnieuw beginnen met een zelfgekozen startsaldo
- **Coins**: kies uit alle EUR-markten op Bitvavo, gesorteerd op volume, maximaal 100
- **AI-veto**: provider, model, base-URL en wat er gebeurt als de AI faalt
- **API-keys** en je **wachtwoord**

Deze keuzes worden opgeslagen in `data/users/<id>/settings.json` en blijven bewaard na een herstart.

De environment variables hieronder zijn alleen beginwaarden voor de allereerste start; daarna gaat het dashboard voor. Geen ervan is geheim. In live-modus vraagt het dashboard je wachtwoord bij het wijzigen van risico of strategie.

| Variabele | Standaard | Betekenis |
|---|---|---|
| `LIVE_TRADING` | `false` | Beginwaarde voor de modus; daarna via het dashboard |
| `PAIRS` | `BTC/EUR,ETH/EUR` | Beginwaarde voor de coins; daarna via het dashboard |
| `TIMEFRAME` | `1h` | Beginwaarde voor de candle-tijd; daarna via het dashboard |
| `CHECK_INTERVAL_MINUTES` | `15` | Beginwaarde voor het check-interval; daarna via het dashboard |
| `EMA_FAST` / `EMA_SLOW` | `12` / `26` | EMA-periodes |
| `RSI_PERIOD` / `RSI_MAX_ENTRY` | `14` / `70` | Geen aankoop boven deze RSI |
| `STAKE_EUR` | `25` | Inzet per trade |
| `MAX_OPEN_TRADES` | `2` | Maximaal gelijktijdige posities |
| `STOP_LOSS_PCT` / `TAKE_PROFIT_PCT` | `3` / `6` | Exit-percentages |
| `MAX_DAILY_LOSS_EUR` | `20` | Daarna geen nieuwe trades tot morgen |
| `FEE_PCT` | `0.25` | Fee voor paper trading |
| `COOLDOWN_MINUTES` | `30` | Na een verkoop dezelfde coin zoveel minuten niet kopen (0 = uit) |
| `PAPER_SLIPPAGE_PCT` | `0.1` | Paper koopt iets duurder en verkoopt iets goedkoper, zoals live met spread |
| `LIVE_BUDGET_EUR` | `0` | Live: nooit meer dan dit bedrag tegelijk in posities (0 = uit) |
| `PAPER_START_BALANCE_EUR` | `500` | Startsaldo paper trading |
| `AI_PROVIDER` | `none` | `none`, `gemini` of `openai` |
| `AI_MODEL` | leeg | Leeg = standaardmodel van de provider |
| `AI_BASE_URL` | Groq | Alleen voor `openai` |
| `AI_FAIL_MODE` | `reject` | Wat te doen bij een AI-fout |
| `AI_TIMEOUT_MS` | `45000` | Hoe lang de bot op de AI wacht (ms) |
| `PORT` | `3000` | Poort in de container |

## Meldingen (Discord) en offline-waarschuwing

Bij Instellingen → Meldingen stel je in:

- **Discord-webhook**: vetobot stuurt meldingen naar een kanaal naar keuze. De webhook wordt versleuteld opgeslagen, net als de API-keys.
- **Jouw Discord user ID**: dan word je getagd en krijg je een push-melding op je mobiel en pc.
- **Per soort melding** of hij gestuurd wordt en of je getagd wordt: herstart, trades, stop-loss, fouten (maximaal één keer per 30 minuten per soort), dagelijkse verlieslimiet, wisselen van modus en AI-afwijzingen.

Met **Testmelding sturen** controleer je of het werkt.

### Dagelijks overzicht

Elke dag op een tijd naar keuze (standaard 08:00) stuurt vetobot een overzicht van de afgelopen 24 uur naar Discord: resultaat, winrate, signalen, saldo en open posities, met een korte analyse door de AI van hoe het ging en wat opvalt. Dat kost één AI-call per dag. Faalt de AI, dan komt het overzicht er zonder analyse. Het laatste overzicht staat ook op het dashboard. Met **Overzicht nu versturen** maak je er direct een.

Ziet de AI daar aanleiding toe, dan doet hij in het overzicht ook een **voorstel** voor andere instellingen. Op het dashboard zie je per instelling de huidige waarde en het voorstel; vink aan wat je wilt en klik op **Geselecteerde overnemen**. Er verandert nooit iets vanzelf. De AI mag alleen de strategie (EMA's en RSI), de stop-loss en take-profit en de planning voorstellen, nooit bedragen zoals de inzet per trade, het aantal open trades of de daglimiet. In live-modus is je wachtwoord nodig om over te nemen.

Start vetobot pas na de ingestelde tijd op, dan komt het overzicht van die dag direct na het opstarten.

### Melding als de server offline gaat

Valt je server uit, dan kan vetobot zelf niets meer sturen. Daarom stuurt hij na elke check een heartbeat naar een externe monitor, bijvoorbeeld [healthchecks.io](https://healthchecks.io) (gratis). Bij een check met fouten gaat de ping naar `<url>/fail`. Komen de heartbeats niet meer binnen, dan stuurt de monitor de melding.

1. Maak op healthchecks.io een check aan. Zet **Period** op je check-interval en **Grace Time** op bijvoorbeeld 10 minuten.
2. Plak de ping-URL bij Heartbeat-URL in vetobot en klik op **Heartbeat testen**.
3. Kies in healthchecks.io bij **Integrations** de **Webhook**-integratie met als URL je Discord-webhook, methode POST, header `Content-Type: application/json` en body `{"content": "<@JOUW_ID> vetobot is offline ($NAME)"}`. Dan word je getagd. Zonder tag kun je ook de Discord-integratie gebruiken.

### Gezondheid en meldingen bij stille uitval

Vetobot kijkt niet alleen of hij "draait", maar of hij doet wat hij moet doen. Elke 30 seconden beoordeelt hij zichzelf op basis van tijdstempels: de laatste geslaagde check, de laatste geslaagde koerscontrole per open positie, en het laatste geslaagde contact met Bitvavo.

| Status | Betekenis |
|---|---|
| 🟢 Gezond | Checks lopen, posities worden gecontroleerd, Bitvavo bereikbaar |
| 🟠 Met problemen | Bijv. 3+ checks op rij met fouten, nieuwe aankopen geblokkeerd, Discord-meldingen komen niet aan, Bitvavo onbereikbaar zonder open live positie |
| 🔴 Kritiek | De handelsronde hangt, er draaien geen checks meer, een **live positie wordt niet meer gecontroleerd**, Bitvavo onbereikbaar mét open live positie, een stop bij Bitvavo niet bevestigd, of 10+ checks op rij met fouten |
| 🟡 Gepauzeerd | Zelf gepauzeerd of daglimiet bereikt; open posities worden bewaakt |
| ⚪ Gestopt | De planner van de bot draait niet |

**Meldingen** (Discord, soort *Gezondheid*, standaard aan en met tag):
- Kritiek: direct. Een probleem pas als het 5 minuten aanhoudt, zodat korte haperingen geen melding geven.
- Een melding vertelt wat er misging, wat getroffen is, of live trading nog loopt, of open posities bewaakt worden, wat de bot zelf deed en of jij iets moet doen.
- Geen spam: hetzelfde probleem niet opnieuw, behalve als het erger wordt (dan direct) of lang aanhoudt (kritiek elk uur, een probleem elke 6 uur).
- Is het weg, dan één melding **Opgelost**.
- Een melding die niet aankomt, wordt nog 2 keer geprobeerd. Lukt het niet, dan staat dat op het dashboard.
- Bij een hangende ronde, gestopte checks of onbewaakte posities gaat ook de heartbeat op *fout* (hooguit elke 5 minuten), zodat je externe monitor het meteen ziet.
- Een onverwachte crash wordt gemeld. Bij de volgende start zegt vetobot dat hij **onverwacht herstart** is (crash, stroom weg, geforceerde herstart), met het tijdstip waarop hij voor het laatst actief was.

**Automatisch herstel**, alleen wat veilig kan:
- Draaien er geen checks meer, dan start de bewaking de planner opnieuw.
- Bitvavo-storingen: elke check en bewakingsronde probeert het opnieuw. Live staan nieuwe aankopen intussen stil.
- Na een herstart controleert de bot live eerst saldo en stop-orders bij Bitvavo, voordat hij iets nieuws koopt.
- Een **hangende** check breekt de bot nooit af, want een lopende order zou dan dubbel kunnen gaan. Dan alleen melden.
- Je live posities blijven beschermd door de stop-loss bij Bitvavo zelf, ook als de bot hangt of uitvalt.

**Dashboard**: bovenaan staat het blok **Gezondheid** met de status en, uitklapbaar:
- de laatste geslaagde check, positiecontrole en contact met Bitvavo;
- de laatste fout en het aantal fouten op rij;
- het aantal open live-posities, en of ze bewaakt worden;
- of live trading actief is, en de laatste herstelpoging.

**Docker**: `/healthz` geeft fout 503 als een handelsronde hangt of er geen checks meer draaien. Met een healthcheck en `autoheal` (of je eigen monitor) kan de container dan herstart worden. Voorbeeld voor je compose (alleen `vetobot`):

```yaml
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:3000/healthz"]
      interval: 1m
      timeout: 10s
      retries: 3
      start_period: 2m
```

Docker zelf herstart een container niet op een mislukte healthcheck. Hij toont dan alleen *unhealthy*. Automatisch herstarten doet bijvoorbeeld de container `willfarrell/autoheal`.

### AI-trader (leert zelf kopen en verkopen)

Een lerende agent (reinforcement learning, *fitted Q-iteration*) die zelf uitzoekt wanneer kopen en wanneer verkopen loont. Geen EMA-kruisingen, vaste winstdoelen, stops of strategieën: zijn enige beloning is de winst na kosten.

- **Verkopen leren:** voor posities op allerlei momenten in het verleden leert hij de waarde van "nog een candle vasthouden" (koersverandering plus de waarde van de beste keuze daarna), herhaald zodat hij steeds verder vooruit kijkt. Hij kijkt daarbij naar de markt én zijn eigen positie (winst nu, hoe lang al, hoogste stand, terugval). Hij verkoopt zodra vasthouden naar verwachting niets meer oplevert.
- **Kopen leren:** voor elk moment speelt hij een aankoop na met zijn eigen verkoopgedrag, inclusief kosten, en leert zo de waarde van "nu kopen".
- **Eerlijk testen:** 70% van de tijd leren, 15% om de koopdrempel te kiezen, 15% als eindtest die hij nooit zag (één positie per coin, kosten, noodstop), vergeleken met kopen en vasthouden.
- **Zelf de beste manier zoeken:** elke ronde probeert hij een **recept**: candle-tijd, hoe lang hij hooguit vasthoudt, hoe uitgebreid zijn model is en hoe ver hij vooruitkijkt. Per recept kiest hij zelf de koopdrempel en de **coins** (op de validatie; standaard uit je eigen coins plus de 20 grootste van Bitvavo). Hij bouwt verder op zijn beste recept, test het opnieuw op de nieuwste koersen, en probeert af en toe iets nieuws; candle-tijden waar alles verlies gaf krijgt bijna geen kansen meer.
- **Vertrouwen en verlies beperken:** een recept is pas *betrouwbaar* als het in minstens 2 rondes standhoudt (gewogen gemiddeld ≥ +0,1% per trade over ≥ 60 eindtest-trades, de laatste ronde goed) én de grootste terugval in de eindtest hooguit 15% is, én hij beter deed dan de markt. *Beter dan de markt:* bij elke testtrade wordt gekeken wat alle coins samen in precies die tijd deden; alleen het voordeel daarboven telt (winst die je ook met meedobberen had gehad, is geen verdienste). Een ronde is pas goed als dat voordeel positief is. *Rangschikken:* op winst ten opzichte van de grootste terugval (gemiddelde winst boven de markt per ronde, gedeeld door de grootste terugval): liever iets minder winst dan diepe dalen. *Te riskant:* zakt een recept in een eindtest meer dan 25% terug, dan wordt het nooit meer gebruikt, ook niet om in paper te oefenen. Was de bot ermee bezig en is er geen ander bruikbaar recept, dan krijgt de AI-trader de stand *geblokkeerd* en handelt de bot er niet meer mee (open posities verkoopt hij nog wel). Echte trades van de bot gaan terug als leervoorbeelden.
- **Eerlijk meten:** leren, validatie en eindtest liggen na elkaar in de tijd, met een buffer van de maximale duur ertussen. Recepten worden gekozen op de **validatie**; de **eindtest** is alleen de controle. Echte bot-trades leren alleen mee als ze van vóór de validatie zijn. De terugval komt uit een **echte portefeuille** (evenveel trades tegelijk als de bot, op echte tijd, ook verlies tijdens een trade). Kosten zijn de **werkelijke kosten per coin** die de bot betaalde (fees plus afwijking; 75e percentiel van de laatste 30 trades, vanaf 5 metingen).
- **Rollen:** *getest* (eindtest gehaald) handelt in paper; *oefenen* alleen in paper als dat mag; *bewezen*: alle eisen voor live gehaald. **Live** pas als een recept alle eisen haalt: betrouwbaar, ≥ 50 paper-trades over ≥ 21 dagen, gemiddeld ≥ +0,1% na kosten met een voorzichtige ondergrens boven 0, beter dan de markt, paper-terugval ≤ 10%, ≥ 2 marktfases, gemeten kosten ≤ 1,5× de aangenomen kosten, **én** je het recept zelf live toestaat (pagina Trainer → Live-toelating). Live begint met de kleinste inzet tot 20 live-trades met gemiddeld winst (instelling *Live beginnen met de kleinste inzet*, standaard aan). Valt een eis weg, dan stopt hij live, trekt hij je akkoord in en krijg je een melding.
- **Live op eigen risico:** een recept dat de backtests haalde (*getest* of *bewezen*) maar nog niet alle eisen voor live, kun je toch live zetten (Trainer → Live-toelating, met je wachtwoord en de bevestiging `EIGEN RISICO`). Dan geldt altijd je eigen inzet, en kies je zelf een verliesgrens in euro: zodra het live verlies van dat recept sinds dat moment (gesloten + open trades, na kosten) die grens haalt, of het recept terugvalt naar *oefenen*/*te riskant*, stopt hij live vanzelf met een melding. Noodstop en dagelijkse verlieslimiet blijven gelden.
- **Inzet door de AI-trader** (Instellingen → Strategie, standaard aan): jouw inzet is het minimum, je *maximale inzet* (Instellingen → Risico) het plafond. Per trade zet hij meer in naarmate zijn verwachting verder boven zijn koopdrempel ligt, zijn verwachtingen in de praktijk uitkwamen (laatste 30 trades; met minder dan 10 hooguit de helft van de ruimte) en het recept in deze marktfase het best was. Na 2 verliezen op rij, als zijn trades verlies maakten, bij een te dun orderboek of te weinig vrij saldo: jouw inzet. Werkt in paper en live; op AI-chat zie je waarom, op Trainer → Live of grotere inzetten beter uitkomen.
- **Extra recepten:** de leerserver stuurt naast het hoofdrecept en de recepten per marktfase ook de 6 beste andere recepten mee (getest of betrouwbaar). Je ziet ze bij Live-toelating en kunt ze live toestaan of op eigen risico live zetten. De bot gebruikt een extra recept alleen live en alleen als jij het zo hebt aangezet; anders kijkt hij er niet naar. Mag het recept voor de marktfase van een coin niet live handelen, dan gebruikt hij een recept dat wel mag.
- **Lange paper-test:** de pagina Trainer toont per week de trades, het gemiddelde na kosten en of hij beter deed dan de markt.
- **Verkenner** (alleen paper, Instellingen → Strategie, standaard aan): volgt gemiste kansen met aparte **virtuele posities**, zonder orders, saldo of gewone handelsplekken te gebruiken. Hij kiest vooral kansen dicht bij de koopdrempel en coins en marktfases waar hij weinig weet; bewezen slechte kansen slaat hij over. Maximaal 100 tegelijk, hooguit 3 per coin en nooit dezelfde candle dubbel. Elke verkenning bewaart het verkoopmodel waarmee hij begon en rekent met fees, slippage, noodstop en maximale duur. Posities en modellen blijven na een herstart bewaard. Uitkomsten tellen voor een kwart mee tegenover uitgevoerde trades, zowel in de directe bijsturing als in de modeltraining. Ze tellen niet mee voor saldo, live-toelating, gemeten uitvoeringskosten, verliesreeks of daglimiet. Per soort verkennen zie je op de pagina Trainer hoe het afliep tegenover de verwachting.
- **Meerdere periodes (walk-forward):** een recept dat op de gewone validatie winst maakt, wordt ook op twee eerdere periodes getest: opnieuw geleerd op 40% en 55% van de geschiedenis en getest op het stuk erna (met buffer). De koopdrempel en de coins kiest hij op alle drie de periodes samen. Een ronde is alleen goed als hij in alle periodes op één na winst maakte; recepten die maar in een deel van de periodes werken, zakken in de rangorde. De eindtest blijft de aparte controle.
- **Snelheid:** de kenmerken per coin en candle-tijd worden bewaard (`/data/features`), zodat een ronde alleen de nieuwe candles uitrekent; het naspelen van verkopen gaat voor alle aankopen tegelijk.
- **Geduld bij verkopen (zoekt hij zelf uit):** elk recept heeft ook een minimale duur (1, 3 of 6 candles vasthouden; de noodstop werkt altijd) en een verkoopmarge (pas verkopen als de verwachting van langer vasthouden onder 0%, −0,05% of −0,15% zakt). Het leren van verkopen, de backtest en de bot gebruiken dezelfde regels. 1 candle / 0% is het oude gedrag; die recepten houden hun resultaten.
- **Directe bijsturing:** na elke afgesloten trade (ook van de verkenner) vergelijkt de bot wat het model verwachtte met wat het werd, en stuurt zijn verwachting per groep verwachtingen en per coin bij (laatste 300 uitgevoerde plus maximaal 300 virtuele trades, voorzichtig bij weinig trades, hooguit 1 procentpunt per deel). Virtuele voorbeelden verdringen de uitgevoerde ervaringen niet. Het model zelf traint de leerserver; nieuwe leervoorbeelden tellen daar alleen mee als de trade volledig vóór de validatie is afgesloten.
- **Overleg:** op de pagina **AI-chat** (filter *AI-trader*) staat per aankoop, tegengehouden aankoop en verkoop wat elk onderdeel zag en besloot.
- **Vangnet:** alleen een noodstop (standaard −10%, instelbaar) en een maximale duur (±2 dagen). De orderboek-check en je AI als controleur blijven gelden.
- Aanzetten: Instellingen → Strategie → **AI-trader → Aan**. Op de pagina Trainer staat het blok **AI-trader** (resultaat per candle-tijd, welke in gebruik is, resultaat in de praktijk). Staat de AI-trader aan, dan staat de strategie-zoeker stil (de AI-trader vervangt hem).

#### Het team van de AI-trader

De AI-trader werkt als een team van vijf onderdelen (geen losse AI's, maar stukken van het programma):

- **Learning Agent** (leerserver): leert kopen en verkopen uit de koersgeschiedenis en uit de echte trades van de bot.
- **Market Agent**: bepaalt per coin de marktfase (*stijgend*, *zijwaarts* of *dalend*) op 1h-candles, wat de candle-tijd van het recept ook is. De leerserver en de bot rekenen precies hetzelfde.
- **Strategy Agent**: de leerserver meet per recept het resultaat per marktfase (in de eindtests) en kiest per fase het recept dat daar het meest beter deed dan de markt (minstens 20 trades in die fase, status betrouwbaar of veelbelovend). Verloor het hoofdrecept in een fase van de markt en doet geen ander het daar beter, dan handelt de bot in die fase niet. Zonder bewijs per fase: het hoofdrecept. De bot kiest per coin het recept voor de huidige fase en verkoopt met hetzelfde recept dat kocht.
- **Risk Agent**: na 3 verliezen op rij van de AI-trader live 6 uur geen nieuwe aankopen (in paper handelt hij door met de kleinste inzet, om te blijven leren); halve inzet (nooit onder € 5) als er voor de marktfase nog weinig bewijs is; geen aankoop in een coin waar de laatste 3 orders gemiddeld meer dan 0,5% slechter uitvielen dan verwacht. Daarnaast gelden de daglimiet, het maximum aantal trades, de noodstop, de orderboek-check en de AI-controleur.
- **Execution Agent**: meet bij elke order hoeveel de prijs afweek van de koers vlak ervoor, en waarschuwt boven 0,3%.

Op de pagina Trainer staat het blok **Het team van de AI-trader** met wat elk onderdeel nu ziet, en in de lijst met recepten de kolom **Per marktfase** (voordeel boven de markt per fase).

## Eigen model (trainer op een VPS)

Naast de AI kan vetobot een **eigen voorspelmodel** gebruiken. Dat wordt getraind door een aparte container, **vetobot-trainer**, die je op een sterkere server (bijv. een VPS) draait. De bot zelf blijft op je eigen server.

- De trainer haalt maanden koersgeschiedenis op bij Bitvavo (publieke data, geen keys nodig) en bepaalt voor elk moment of een aankoop daar eerst je winstdoel of eerst je stop had geraakt, na kosten.
- Hij kijkt niet alleen naar de grafiek van de coin zelf, maar ook naar **het grotere plaatje** (de trend over een ~20× langere periode), **wat Bitcoin doet** (de hele markt beweegt vaak mee), hoe de coin het doet **ten opzichte van BTC**, en het **tijdstip** (uur en dag, UTC).
- **Hij leert van je eigen trades.** Bij elke trade onthoudt de bot wat het model op het moment van kopen zag; bij het sluiten gaat dat met de echte uitkomst (winst/verlies na kosten) naar de trainer. Trades van vóór de testperiode leert hij van (zwaarder gewogen dan historische voorbeelden); recentere trades gebruikt hij als extra, eerlijke controle ("Op echte trades" op de pagina Trainer). Is de trainer even onbereikbaar, dan wachten de trades in een wachtrij.
- Daarop traint hij een gradient-boosting-model en test het op de laatste 20% van de periode, die het model niet gezien heeft. **Alleen als het model daar echt winst na kosten maakt en duidelijk beter is dan zomaar kopen, wordt het gepubliceerd.** Anders blijft het vorige model in gebruik.
- Wanneer hij traint stel je in op de pagina **Trainer** → **Wanneer trainen**: op vaste tijden (standaard 03:00), elke paar uur, of doorlopend (na elke training opnieuw, met een pauze). Daar kies je ook hoeveel dagen geschiedenis hij gebruikt (7 tot 365).
- De trainer **bewaart de opgehaalde koersen** (tot 400 dagen). Bij een volgende training haalt hij alleen de nieuwe candles op, en als je meer dagen kiest alleen het ontbrekende oudere stuk. Om trainen snel te houden gebruikt hij maximaal 300.000 voorbeelden (instelbaar), gespreid over de hele periode.
- vetobot haalt elk half uur het nieuwste model op. Bij een koopsignaal rekent hij de **winstkans** uit (in JavaScript, zonder extra software). Die kans krijgt de AI als extra argument, en met **Minimale modelkans** (bij Strategie) kun je er ook op filteren. Is de VPS onbereikbaar, dan blijft het vorige model gewoon werken.

- **Orderboek-check bij het kopen** (Instellingen → Risico): de bot kijkt in het echte orderboek van Bitvavo hoe groot het verschil tussen bied en laat is en tegen welke prijs je inzet écht gevuld zou worden. Is dat te duur (standaard: verschil > 0,5% of > 0,3% boven de middenprijs), dan koopt hij niet. Paper vult nu ook tegen de echte prijzen in het boek, zodat paper eerlijker is. De AI krijgt het orderboek mee (verschil, kosten, kopers t.o.v. verkopers).
- **Orderboek en transacties opnemen** (pagina Trainer). Bitvavo bewaart geen geschiedenis van het orderboek, dus de trainer neemt het zelf op: elke minuut per coin het orderboek (kopers en verkopers binnen 1%, verschil bied/laat) en alle transacties (koop- of verkoopinitiatief, drukte, grootste order). Bewaard tot 120 dagen in `/data/micro`. Na 14 dagen draait één keer per dag een eerlijk experiment: hetzelfde model met en zonder deze gegevens, op dezelfde periode. Alleen als het mét duidelijk beter is, neemt het model ze voortaan mee (en haalt de bot ze elke minuut bij de trainer op).
- **Het model praat.** Op de pagina Trainer staat **Wat denkt het model?**: in gewoon Nederlands vertellen de trainer en de bot wat ze doen en waarom. Welke strategie hij probeert en waarom (nieuw idee, variatie op de beste, opnieuw testen), wat eruit kwam, waar het model het meest op let, in welk soort markt het goed of slecht is, wat hij tot nu toe geleerd heeft (bijv. welke candle-tijd het best werkt), welke strategie de bot kiest en waarom, wat de AI ervan vond, en na elke trade de beloning of straf. Alles is opgebouwd uit de echte cijfers, niet verzonnen door een taalmodel.
- **Beloning (zelflerend).** Elke bevestigde strategie van de zoeker krijgt een eigen model. Met **Kiezen tussen strategieën → Zelflerend** (bij Strategie) bepalen die strategieën zelf wanneer er gekocht wordt, elk op haar eigen candle-tijd (los van je eigen candle-instelling en EMA-kruisingen); willen er meerdere kopen, dan kiest de bot er één (Thompson sampling): na het sluiten krijgt de gebruikte strategie de echte winst of het verlies als beloning, en wat geld oplevert kiest hij vaker, terwijl hij de rest af en toe opnieuw probeert. Recente trades tellen zwaarder. De gekozen strategie bepaalt voor die trade de stop, het winstdoel en de maximale duur. Hij hoeft niet te wachten op een bevestigde strategie: de trainer geeft altijd minstens 3 strategieën die hij zelf bedacht heeft mee, elk met een rol. **Bevestigd** mag echt traden; **proef** (veelbelovend, nog niet bevestigd) traded in paper echt (instelbaar) en live alleen als schaduwtrade; **verkenning** doet alleen schaduwtrades. Alle resultaten (echt en schaduw) gaan terug naar de trainer als **live-test**: na 15 trades wordt een strategie die live gemiddeld ≥ +0,1% haalt bevestigd, en een die live verliest valt af. De zoeker bouwt vervolgens verder op wat live het best werkt. Daarnaast volgt hij **schaduwtrades**: elke keer dat een strategie wil kopen, rekent hij met haar regels uit hoe die trade afloopt, ook als hij hem niet echt doet (andere strategie gekozen, AI zei nee, al een positie open). Die tellen half zo zwaar als een echte trade, zodat hij veel sneller leert. Paper en live delen hetzelfde geheugen. Ook bij het trainen telt beloning mee: voorbeelden met een grote winst of groot verlies wegen zwaarder dan trades die rond 0 eindigden, en recente koersen en trades wegen zwaarder dan oude (halveert elke 45 dagen, instelbaar met `halfLifeDays`).
- **AI en model werken samen.** Het model geeft bij elk signaal niet alleen een winstkans, maar legt ook uit **waarom**: welke kenmerken de kans het meest omhoog of omlaag duwden (bijv. "Bitcoin laatste 12 candles +0,8% → +6 procentpunt"). De AI krijgt die uitleg en zegt in zijn reden waar hij het model volgt of juist niet. Elk oordeel van de AI gaat naar de trainer, die met de echte koersen uitrekent hoe het signaal afliep, ook de afgewezen. Dat **scorebord** (goedgekeurd vs. afgewezen, en de gevallen waarin model en AI het oneens waren) staat op de pagina Trainer en gaat terug naar de AI, zodat hij leert wanneer hij het model moet vertrouwen. Bij AI-signalen zie je de uitleg van het model onder de reden.
- **Marktfase.** De trainer kijkt per soort markt (stijgend, zijwaarts, dalend; de trend over een langere periode gemeten in normale beweging) hoe de trades die het model zou nemen het op de test deden. De bot geeft de AI een waarschuwing als het model in de huidige soort markt verlies maakte; met **Marktfase waarin het model verliest → Overslaan** (bij Strategie) slaat hij zo'n signaal helemaal over.
- **Strategie-zoeker** (pagina Trainer). Staat hij aan, dan zoekt de trainer **doorlopend** (met een instelbare pauze tussen rondes; een geplande training gaat altijd voor). Ongeveer de helft van elke ronde bouwt verder op de beste strategie tot nu toe (net iets ander doel, stop of duur), de rest zoekt nieuwe richtingen, en de beste wordt regelmatig opnieuw getest op de nieuwste koersen. Met **Beste strategie gevonden → Automatisch overstappen** traint de trainer bij een nieuwe, duidelijk betere bevestigde strategie meteen een model daarop, en neemt de bot die strategie over zodra het model klaar is (je krijgt een melding). Hij probeert combinaties van winstdoel, stop, maximale duur en candle-tijd, en houdt een ranglijst bij. Om toeval uit te sluiten gebruikt hij drie stukken data: op de oudste 60% leert het model, op de volgende 20% wordt de strategie beoordeeld, en de winnaar moet zich daarna nog bewijzen op de nieuwste 20% (met de drempel die vooraf gekozen is). Hoe meer strategieën getest, hoe hoger de lat. Alleen een **bevestigde** strategie kun je met **Toepassen** overnemen: dat zet je stop, winstdoel, maximale duur, candle-tijd en minimale modelkans, en traint meteen een model daarop. Het blijft een test op het verleden, geen garantie.

**Op de VPS** (apart, klein compose-bestand):

```yaml
services:
  vetobot-trainer:
    image: ghcr.io/iitssjstn/vetobot-trainer:latest
    container_name: vetobot-trainer
    restart: unless-stopped
    environment:
      - TZ=Europe/Amsterdam
      - TRAIN_HOUR=3        # voorspelmodel (oude methode): elke nacht om 03:00 trainen
      - TRAIN_JOBS=2        # zoveel processorkernen mag het trainen gebruiken (standaard 2)
      - TRAIN_NICE=10       # lagere voorrang: andere programma's op de server gaan voor (0-19)
      - AGENT_HOURS=        # AI-trader alleen op deze uren laten leren, bijv. 0-7 (leeg = doorlopend)
    ports:
      - "8787:8787"        # of achter je reverse proxy met HTTPS (aanbevolen)
    volumes:
      - ./trainer-data:/data
    cpus: "2.0"            # harde grens voor de container
    mem_limit: 3g          # 365 dagen 5m-candles met 24 coins: ±2 GB nodig
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
```

**Helpers: meer apparaten laten meeleren.** Op elk apparaat met Docker of Linux (pc, laptop, Raspberry Pi 4/5, tweede server, Android-telefoon via Termux) kan een **helper** draaien. Een helper vraagt de leerserver om een recept, haalt zelf de koersen bij Bitvavo, traint en test het recept met dezelfde code en stuurt de uitkomst terug. De leerserver blijft de baas: hij kiest de recepten, beoordeelt de uitkomsten en bepaalt wat de bot gebruikt. Een recept dat al getraind wordt, deelt hij niet nog eens uit; komt een helper niet binnen 90 minuten terug, dan gaat het recept vanzelf terug. Helpers gebruiken een **aparte helper-code**, die alleen toegang geeft tot recepten ophalen en uitkomsten terugsturen; je koppelt een helper met een korte koppelcode van 6 cijfers (zie hieronder). Op de pagina Trainer zie je welke helpers meedoen. Helpers trainen ook buiten de leeruren van de VPS.

Helper met Docker (op een ander apparaat):

```yaml
services:
  vetobot-helper:
    image: ghcr.io/iitssjstn/vetobot-trainer:latest
    restart: unless-stopped
    environment:
      - ROLE=helper
      - TRAINER_URL=https://trainer.jouwdomein.nl
      - HELPER_NAME=pc-zolder      # naam op het dashboard
      - TRAIN_JOBS=2
    volumes:
      - ./helper-data:/data
```

**Koppelen:** klik op de pagina Trainer → Overzicht → Helpers op **Helper koppelen**. Je krijgt een koppelcode van 6 cijfers (15 minuten geldig, één keer te gebruiken). Zet die de eerste keer als `PAIR_CODE=123456` bij de environment van de helper en start hem (`docker compose up -d vetobot-helper`); de helper wisselt de koppelcode zelf in voor de lange helper-code en bewaart die in `helper-data/helper-token`. Daarna mag `PAIR_CODE` weer weg. Zonder koppelcode kan ook: zet de lange helper-code (Helpers → Tonen) in `helper-data/helper-token`. Niet op je thuisserver met de Athlon (numpy draait daar niet), en het apparaat heeft ±1,5 GB vrij geheugen nodig bij 365 dagen geschiedenis.

Helper op een Android-telefoon (Termux): `curl -fsSLo helper.sh https://raw.githubusercontent.com/iitssjstn/vetobot/main/scripts/telefoon-helper.sh && bash helper.sh` (zie [docs/telefoon-trainer.md](docs/telefoon-trainer.md)).

**Telefoon als leerserver?** Zie [docs/telefoon-trainer.md](docs/telefoon-trainer.md): een stappenplan voor een Android-telefoon (Termux) en het meetprogramma `bench.py`, dat een paar nep-leerrondes draait en zegt hoe snel een apparaat leert (`docker run --rm ghcr.io/iitssjstn/vetobot-trainer:latest python bench.py`).

**Resources op een gedeelde server.** Het trainen gebruikt standaard 2 kernen (`TRAIN_JOBS`) met lagere voorrang (`TRAIN_NICE`). De **AI-trader leert doorlopend** (een ronde, korte pauze, de volgende); dat is iets anders dan `TRAIN_HOUR`, dat alleen voor het voorspelmodel van de oude methode geldt. Wil je dat de AI-trader alleen 's nachts leert, zet dan `AGENT_HOURS=0-7`, of vul de **Leeruren** in op de pagina Trainer → Recepten (die instelling gaat voor de omgevingsvariabele). De koersopslag wordt hooguit eens per half uur bijgewerkt en de opgeslagen kenmerken eens per 6 uur; elk uur ruimt hij oude bestanden op.

Start hem met `docker compose up -d` en kijk in de logs (`docker compose logs vetobot-trainer`) voor de **code**. Die code staat ook in `trainer-data/token`. Er staan geen geheimen in de compose of in een .env-bestand.

**In vetobot** (als admin): Instellingen → **Eigen model** → vul het adres van de trainer (bijv. `https://trainer.jouwdomein.nl` of `http://IP-van-je-VPS:8787`) en de code in, en klik op **Nu trainen met mijn instellingen**. De bot stuurt dan je candle-tijd, stop-loss, take-profit (of maximale tijd in positie), kosten en coinlijst naar de trainer. Na een paar minuten zie je het resultaat op de testperiode, met de aanbevolen minimale modelkans. Het model wordt alleen gebruikt als het getraind is op dezelfde candle-tijd als je bot.

Op de pagina **Trainer** (alleen voor de admin) zie je live wat de trainer doet: welke stap (coins kiezen, koersen ophalen, model trainen, testen), een voortgangsbalk, het logboek, het huidige model en alle eerdere trainingen met hun resultaat. Zodra de trainer een nieuw model heeft, haalt de bot het meteen op.

Gebruik bij voorkeur HTTPS (bijv. via Nginx Proxy Manager op de VPS), zodat de code niet onversleuteld over internet gaat. Het model is gedeeld: alle gebruikers van je vetobot gebruiken hetzelfde model.

## Learning: hoe vetobot leert en zich verbetert

Vetobot leert in een gesloten, gecontroleerde cyclus. Live gaat er nooit iets vanzelf.

```
marktdata ─► beslissing (bot) ─► dagboek (learning.db) ─► achteraf: wat gebeurde er? (labels)
                                        │
trades + feedback ─► leerserver: nieuw model trainen ─► eerlijk testen ─► vergelijken met het actieve model
                                        │
              alleen aantoonbaar beter ─► publiceren voor paper ─► paper-test ─► live alleen met jouw akkoord per recept
```

### Onderdelen

| Onderdeel | Waar | Wat |
|---|---|---|
| Trading Engine | `src/bot.js`, `src/exchange.js`, `src/risk.js` | Kopen/verkopen, harde risicolimieten, orderboek-check, paper/live-brokers |
| Decision Engine | `src/agents.js`, `src/strategy.js`, `src/ai.js` | AI-trader en zijn team (Market/Strategy/Risk/Execution Agent), AI-controleur |
| Data Collection | `src/journal.js` | Beslissingsdagboek (SQLite), labels achteraf, trades met kosten en MFE/MAE |
| Learning Engine | `trainer/agent.py`, `trainer/agent_search.py` | Recepten leren, walk-forward, aparte eindtest, metrics |
| Model Manager | `trainer/registry.py`, `trainer/server.py` | Modelversies, poortwachter bij publiceren, terugzetten/vastzetten |
| Model Evaluation | `trainer/livecheck.py`, `trainer/agent.py` | Eisen voor live, profit factor, Sharpe, per marktomstandigheid |
| Dashboard | `public/index.html` (pagina **Learning**), `src/server.js` (`/api/learning`) | Inzicht in wat de bot leert |

### 1. Beslissingsdagboek (bot)

Bij elke echte koopkans legt de bot vast: coin, tijd, candle-tijd, prijs, indicatoren (trend, RSI, ATR/volatiliteit, volume), orderboek (spread, kosten van je order, diepte), het advies van de AI-controleur (model, ja/nee, reden), het regelgebaseerde advies (EMA/RSI-signaal of de verwachting en drempel van de AI-trader), het recept en de modelversie, de marktfase (trend én volatiliteit) en **of en waarom** er gekocht werd. Ook afgewezen kansen: door de toelating (live/paper), de Risk Agent, een pauze in de marktfase, de risicoregels, de orderboek-check, de AI-controleur, of een order die niet gevuld werd. (Gewone candles onder de koopdrempel niet: dat zijn geen kansen.)

**Achteraf beoordelen zonder lekken.** Na 1 uur, 4 uur en 24 uur rekent de bot uit wat er gebeurd zou zijn: rendement na kosten en de grootste stijging/daling, met **alleen koersen ná het besluit**. Die uitkomsten staan in een aparte tabel en komen nooit in de gegevens van de beslissing zelf. Zo zie je of een afwijzing terecht was. Trades krijgen fees, spread, slippage in/uit en hun grootste stijging (MFE) en daling (MAE) tijdens de trade.

Bestand: `learning.db` in de map van elke gebruiker (`data/users/<id>/`). Beslissingen ouder dan 180 dagen worden opgeruimd.

### 2. Marktomstandigheden

Naast de trend (stijgend / zijwaarts / dalend) herkent vetobot nu de **volatiliteit**: de ATR (in % van de koers) vergeleken met de mediaan van de voorgaande (max. 500) candles van die coin. Boven 1,5× = hoog, onder 0,67× = laag, anders normaal; met minder dan 100 voorgaande candles: onbekend. Bot en leerserver gebruiken exact dezelfde regel, alleen met verleden data.

### 3. Modellen beoordelen

Elke leerronde wordt getest op een periode die het model nooit zag (eindtest), plus walk-forward over meerdere periodes, met echte kosten per coin en portefeuille-terugval. Per model: rendement van een echte portefeuille in de eindtest (zoveel trades tegelijk als de bot, elk een gelijk deel van het vermogen; niet het theoretische samengestelde rendement alsof elke trade het hele vermogen inzet), winrate, **profit factor**, **Sharpe** (per trade), maximale terugval, aantal trades, gemiddelde winst en gemiddeld verlies per trade, en resultaten **per trend én per volatiliteit**. Baseline: de markt tijdens dezelfde trades ("beter dan meedobberen").

### 4. Modelversies en promotie

Elke leerronde wordt een versie in `registry.db` (op de leerserver) met datum, wie hem trainde (VPS of helper), dataset (coins, dagen, periodes), kenmerken, instellingen, alle metrics, de vergelijking met het actieve model en de beslissing met reden:

- **gepromoot**: aantoonbaar beter. Een ánder recept moet minstens 2 geteste rondes hebben, een duidelijk hogere score (≥ 5%), een eindtest-terugval van hooguit 1,25× die van het actieve model en geen lagere profit factor. Hetzelfde recept opnieuw getraind mag als het hooguit 5% slechter is (ruis).
- **niet beter** (kept): het actieve model blijft. Bij een nieuwe training van hetzelfde recept die slechter is, blijft ook het vorige model van dat recept.
- **afgewezen**: niet bruikbaar of niet beter.
- **teruggezet**: jij zette een eerdere versie terug.

Van elke gepromote versie wordt een kopie bewaard (`agents/versions/v<n>.json`) als terugvaloptie; die worden nooit opgeruimd. Is het actieve model te riskant geworden (> 25% terugval), dan kiest de leerserver uit veiligheid zelf het beste veilige model.

**Promotie gaat alleen naar paper.** Live handelt de bot uitsluitend met recepten die jij zelf live toestaat of op eigen risico live zet (Trainer → Live).

**Terugzetten**: op de pagina Learning (admin, met wachtwoord) bij een gepromote versie **Terugzetten**. Die versie wordt actief en **vastgezet**: nieuwe leerrondes worden nog getest en geregistreerd, maar niet in gebruik genomen tot je **Vastzetten opheffen** kiest. Een te riskant recept kan niet terug.

**Statistische toets.** Een ander recept moet in de eindtests **met 95% zekerheid** meer per trade opleveren dan het actieve model (eenzijdige Welch t-toets op gemiddelde, spreiding en aantal trades, samengevoegd over alle eindtest-rondes). Omdat de leerserver veel recepten probeert en er altijd wel een toevallig goed uitkomt, wordt die zekerheid strenger naarmate er meer recepten op het leaderboard staan (Bonferroni). Recepten met alleen oude rondes (zonder spreiding) vallen terug op de score-eis.

**Proefperiode.** Na elke promotie staat de nieuwe versie **op proef**: na 30 echte trades (paper of live, geen verkenner) vergelijkt de leerserver het resultaat met wat de eindtest beloofde. Is het gemiddelde ≤ 0 én met 90% zekerheid lager dan beloofd, dan is de proef mislukt: de leerserver zet **vanzelf** de vorige goedgekeurde versie terug (niet vastgezet), dat recept mag 72 uur niet opnieuw gepromoot worden, en de bot stuurt je een melding ("AI-trader: nieuw model teruggedraaid"). Op Learning zie je per versie de proefstatus en een grafiek **Praktijk tegen verwachting**.

**Volatiliteit bij het kiezen.** Per recept meet de leerserver het resultaat bij hoge, normale en lage volatiliteit (`volStats`). Verloor het gekozen recept in de eindtests bij de huidige volatiliteit (≥ 30 trades, gemiddeld verlies), dan koopt de AI-trader niet, of gebruikt hij een ander toegestaan recept dat daar niet verloor (met halve inzet). Instelling: Strategie → Volatiliteit meewegen.

**Gemiste kansen bijsturen.** De directe bijsturing van de verwachting gebruikt naast eigen trades en de verkenner nu ook de afgewezen kansen van de AI-trader waarvan de uitkomst vaststaat (gewicht 0,15, vanaf 30 stuks). Zo wordt hij minder vaak te voorzichtig of te optimistisch.

**Alleen trainen als er iets nieuws is**: een al getest recept wordt pas opnieuw getraind na 6 uur (of één candle van het recept als dat langer is) of na 20 nieuwe trades met dat recept. Nieuwe recepten blijven altijd mogelijk.

### 5. De pagina Learning

Voor iedere gebruiker, kies modus (paper/live) en periode:

- **Overzicht**: huidige modelversie, laatste training, aantal sessies, datapunten, geaccepteerd/afgewezen, laatste evaluatie.
- **Modelprestaties**: de gepromote versies naast elkaar (rendement, winrate, profit factor, Sharpe, terugval, trades, gemiddelde winst/verlies, per marktomstandigheid).
- **Trainingsgeschiedenis**: elke leerronde met de data, de uitkomst, de reden en het verschil met het actieve model; terugzetten (admin).
- **Beslissingsanalyse**: goede en slechte beslissingen, terecht afgewezen, **gemiste kansen** (regels/toelating hielden een stijging tegen), **onterechte afwijzingen** (de AI-controleur zei nee, maar het steeg), per AI-model, per coin, per marktomstandigheid, per stap waar het besluit viel, en de laatste beslissingen met hun uitkomst na 1/4/24 uur.

### 6. Database, migraties en herstel

- Twee SQLite-databases, zonder extra software (Node 22 en Python hebben SQLite ingebouwd): `learning.db` per gebruiker (bot) en `registry.db` op de leerserver.
- Bestaande gegevens (`state-paper.json`, `state-live.json`, `agents.json`, `agent.json`) blijven zoals ze waren; de databases staan ernaast. **Herstel**: stop de container en verwijder of hernoem de database; de bot en de leerserver beginnen dan met een lege, en alles werkt zoals vóór deze versie.
- Elke database heeft een `schema_version` en genummerde migraties die maar één keer draaien. Is een database kapot, dan wordt hij hernoemd naar `*.corrupt-<tijd>` en begint een nieuwe; trading en leren gaan door.
- Een fout in het dagboek of het register (schijf vol, kapotte database) heeft nooit invloed op kopen of verkopen.

### 7. Instellingen

Bot (compose, `vetobot`):

| Variabele | Standaard | Betekenis |
|---|---|---|
| `JOURNAL_ENABLED` | 1 | Beslissingsdagboek aan (0 = uit) |
| `JOURNAL_HORIZONS` | 60,240,1440 | Na zoveel minuten beoordelen |
| `JOURNAL_MAIN_HORIZON` | 240 | Horizon voor terecht/onterecht/gemist |
| `JOURNAL_RETENTION_DAYS` | 180 | Zo lang beslissingen bewaren |
| `BITVAVO_OPERATOR_ID` | 1 | Verplicht nummer bij Bitvavo-orders |
| `EXCHANGE_STOP` | 1 | Stop-loss ook bij Bitvavo zetten (live) |
| `AGENT_VOL_GUARD` | 1 | Strategy Agent let op volatiliteit |

Leerserver (compose, `vetobot-trainer`; ook in de config van de leerserver):

| Variabele | Standaard | Betekenis |
|---|---|---|
| `PROMOTE_MIN_GAIN_PCT` | 5 | Zoveel % betere score nodig om een ander recept te promoten |
| `PROMOTE_MIN_ROUNDS` | 2 | Minimaal zoveel geteste rondes |
| `PROMOTE_MAX_DD_FACTOR` | 1.25 | Eindtest-terugval hooguit zoveel × die van het actieve model |
| `RETRAIN_TOLERANCE_PCT` | 5 | Hetzelfde recept opnieuw getraind: hooguit zoveel % slechter |
| `RETEST_HOURS` | 6 | Een recept pas na zoveel uur opnieuw trainen ... |
| `RETEST_TRADES` | 20 | ... of na zoveel nieuwe trades met dat recept |
| `PROMOTE_CONFIDENCE` | 0.95 | Zekerheid dat een ander recept echt beter is (vóór de correctie voor het aantal recepten) |
| `PROBATION_TRADES` | 30 | Zoveel echte trades in de proefperiode |
| `PROBATION_CONFIDENCE` | 0.9 | Zekerheid voor "duidelijk slechter dan beloofd" |
| `PROBATION_COOLDOWN_HOURS` | 72 | Zo lang mag een recept na een mislukte proef niet opnieuw |

Geen nieuwe containers, volumes of poorten nodig: de databases staan in de bestaande data-volumes.

## Meerdere gebruikers

Je kunt andere mensen uitnodigen. Iedereen heeft een eigen bot met eigen Bitvavo- en AI-keys, eigen saldo, trades en instellingen, in een eigen map `data/users/<id>/`.

- **Uitnodigen**: alleen de admin kan dat, via **Gebruikers** → **Uitnodiging maken**. Je krijgt een link die één keer werkt en 7 dagen geldig is. Wie hem opent, kiest zelf een gebruikersnaam en wachtwoord. Zonder uitnodiging kan niemand een account maken.
- **Nieuwe accounts beginnen in paper**, ook als `LIVE_TRADING=true` in je compose staat. Live zet iemand zelf aan, met zijn eigen wachtwoord en het woord `LIVE`, net als de admin.
- **Zelf instellen of volgen**: een gebruiker stelt óf zelf coins, strategie en AI in, óf zet **Strategie volgen** aan. Dan koopt en verkoopt zijn bot mee met de trades van de admin, met zijn eigen keys en saldo. Coins, planning, strategie, stop-loss, take-profit en trailing stop komen dan van de admin; inzet per trade, max. open trades en daglimiet blijven van de gebruiker zelf. Zit hij aan zijn limiet, dan slaat hij die trade over. De AI wordt voor gevolgde trades niet aangeroepen, dus een volger heeft geen AI-key nodig. Verkoopt de admin terwijl een volger een check mist, dan verkoopt de volger bij zijn volgende check alsnog.
- **Beheer**: bij Gebruikers zie je per account de modus, of hij volgt, open posities en resultaat. Uitschakelen stopt de bot en logt de gebruiker uit. Verwijderen vraagt je wachtwoord en zet de map opzij in `data/users/_verwijderd/` in plaats van hem te wissen.
- **Gedeelde marktdata**: alle bots halen koersen via één gecachete verbinding, omdat Bitvavo de rate limit per IP telt. Orders en saldo gaan via de eigen keys van elke gebruiker.
- De heartbeat (offline-melding) gaat over de server en wordt alleen door de admin ingesteld. Discord-meldingen en het dagoverzicht stelt iedereen zelf in.

Let op als je dit voor anderen draait: je bewaart dan hun API-keys op jouw server en wie root heeft, kan erbij. Laat iedereen een Bitvavo-key maken **zonder opnamerechten**, gekoppeld aan het IP van je server. Handel je voor anderen tegen betaling of beheer je hun geld, dan kan dat onder de Europese MiCA-regels vergunningplichtig zijn. Voor vrienden die hun eigen account en eigen keys gebruiken is het een hulpmiddel, geen beleggingsadvies.

## Live trading

Doe dit pas na weken paper trading met resultaten waar je tevreden over bent.

1. Maak bij Bitvavo een API-key aan met **alleen handelsrechten, zonder opnamerechten**, en koppel hem aan het IP-adres van je server.
2. Vul de key en het secret in bij Instellingen → API-keys en klik op **Bitvavo-keys testen**.
3. Klik bij Handelsmodus op **Overschakelen naar live**, vul je wachtwoord in en typ `LIVE`.
4. Begin met een kleine inzet (minimaal € 5, het minimum van Bitvavo) en een lage daglimiet. De bot gebruikt nooit meer dan inzet × maximaal open trades; met € 5 en 2 trades heb je genoeg aan zo'n € 15 tot € 20 op Bitvavo. In paper kan de inzet vanaf € 0,10.

Beveiligingen tijdens live handelen:

- **Stop-loss bij Bitvavo zelf** (standaard aan; Instellingen → Risico): na elke live aankoop zet de bot een stop-loss-order bij Bitvavo op de noodstop. Die werkt ook als je server of internet uitvalt. Verkoopt de bot zelf, dan annuleert hij die order eerst (en controleert dat); ging de stop bij Bitvavo af terwijl de bot offline was, dan sluit hij de positie af met de echte uitvoering. Onder de minimale orderwaarde van Bitvavo (€ 5) wordt geen stop geplaatst; de bot bewaakt dan zelf.
- **Bij twijfel geen nieuwe aankopen** (alleen live): vóór de coins bekijkt de bot eerst de stand bij Bitvavo (saldo, stop-orders, saldocontrole). Lukt het saldo ophalen niet, vond de saldocontrole een positie die op Bitvavo mist, heeft een open positie geen werkende stop bij Bitvavo, of is een aankoop onzeker (geen antwoord van Bitvavo), dan koopt hij niets nieuws tot het is opgelost. Bewaken, verkopen en stop-orders gaan altijd door. De reden staat op de pagina Posities bij Live-veiligheid.
- **Saldocontrole met Bitvavo**: bij het starten en elke 24 uur (of met **Nu controleren** op de pagina Posities) vergelijkt de bot zijn posities met je echte saldo en meldt afwijkingen. Hij handelt er nooit zelf op.

- Kan de bot het orderboek niet ophalen, dan koopt hij live niet ("in live koop ik niet blind"); in paper wel.
- Per coin loopt er nooit meer dan één order tegelijk, en een positie wordt nooit twee keer verkocht.
- De AI (controleur, AI-trader, eigen inzet) kan de harde limieten niet omzeilen: max. open trades, dagelijkse verlieslimiet, budgetplafond, vrij saldo, max. inzet en de noodstop worden vlak voor elke order nog een keer gecontroleerd.
- Het vrije Bitvavo-saldo wordt na elke order bijgewerkt; fees tellen mee in winst en verlies, net als in paper.

Beveiligingen bij het wisselen:

- De bot test eerst of je Bitvavo-keys werken en haalt je saldo op. Lukt dat niet, dan blijft hij op paper.
- Wisselen kan alleen als er in de huidige modus geen posities meer open staan. Zo blijft een echte positie nooit onbewaakt achter. Sluit ze eerst, eventueel met de knop **Sluiten** bij Posities.
- Zolang je live staat, kun je de Bitvavo-keys niet verwijderen.
- In live-modus staat er een rode streep bovenaan het dashboard en een rode **LIVE**-badge.

Paper en live hebben elk een eigen state-bestand (`state-paper.json` en `state-live.json` in de map van de gebruiker), dus ze lopen nooit door elkaar.

Let op: stop-loss en take-profit worden per check bekeken, niet direct op de exchange. Bij een interval van 15 minuten kan de koers in die tijd verder doorlopen dan je stop-loss.

## Dashboard

- Saldo (paper), resultaat totaal en vandaag, winrate
- Open posities en afgesloten trades
- Elke AI-beslissing met de reden
- API-keys invullen, vervangen of verwijderen
- Wachtwoord wijzigen
- **Nu checken** voert direct een check uit
- **Pauzeren** stopt nieuwe trades; open posities worden nog wel bewaakt
- **Sluiten** bij een positie verkoopt hem direct tegen de marktprijs

## Ontwikkelen

```bash
npm install
npm start      # open http://localhost:3000, setup-code staat in de terminal
npm test
```

## Disclaimer

Dit is experimentele software. Handelen in crypto kan je je hele inzet kosten. Een strategie die er in paper trading goed uitziet, kan live gewoon verliezen.
