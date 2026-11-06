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

## Eigen model (trainer op een VPS)

Naast de AI kan vetobot een **eigen voorspelmodel** gebruiken. Dat wordt getraind door een aparte container, **vetobot-trainer**, die je op een sterkere server (bijv. een VPS) draait. De bot zelf blijft op je eigen server.

- De trainer haalt maanden koersgeschiedenis op bij Bitvavo (publieke data, geen keys nodig) en bepaalt voor elk moment of een aankoop daar eerst je winstdoel of eerst je stop had geraakt, na kosten.
- Hij kijkt niet alleen naar de grafiek van de coin zelf, maar ook naar **het grotere plaatje** (de trend over een ~20× langere periode), **wat Bitcoin doet** (de hele markt beweegt vaak mee), hoe de coin het doet **ten opzichte van BTC**, en het **tijdstip** (uur en dag, UTC).
- **Hij leert van je eigen trades.** Bij elke trade onthoudt de bot wat het model op het moment van kopen zag; bij het sluiten gaat dat met de echte uitkomst (winst/verlies na kosten) naar de trainer. Trades van vóór de testperiode leert hij van (zwaarder gewogen dan historische voorbeelden); recentere trades gebruikt hij als extra, eerlijke controle ("Op echte trades" op de pagina Trainer). Is de trainer even onbereikbaar, dan wachten de trades in een wachtrij.
- Daarop traint hij een gradient-boosting-model en test het op de laatste 20% van de periode, die het model niet gezien heeft. **Alleen als het model daar echt winst na kosten maakt en duidelijk beter is dan zomaar kopen, wordt het gepubliceerd.** Anders blijft het vorige model in gebruik.
- Wanneer hij traint stel je in op de pagina **Trainer** → **Wanneer trainen**: op vaste tijden (standaard 03:00), elke paar uur, of doorlopend (na elke training opnieuw, met een pauze). Daar kies je ook hoeveel dagen geschiedenis hij gebruikt (7 tot 365).
- De trainer **bewaart de opgehaalde koersen** (tot 400 dagen). Bij een volgende training haalt hij alleen de nieuwe candles op, en als je meer dagen kiest alleen het ontbrekende oudere stuk. Om trainen snel te houden gebruikt hij maximaal 300.000 voorbeelden (instelbaar), gespreid over de hele periode.
- vetobot haalt elk half uur het nieuwste model op. Bij een koopsignaal rekent hij de **winstkans** uit (in JavaScript, zonder extra software). Die kans krijgt de AI als extra argument, en met **Minimale modelkans** (bij Strategie) kun je er ook op filteren. Is de VPS onbereikbaar, dan blijft het vorige model gewoon werken.

- **Het model praat.** Op de pagina Trainer staat **Wat denkt het model?**: in gewoon Nederlands vertellen de trainer en de bot wat ze doen en waarom. Welke strategie hij probeert en waarom (nieuw idee, variatie op de beste, opnieuw testen), wat eruit kwam, waar het model het meest op let, in welk soort markt het goed of slecht is, wat hij tot nu toe geleerd heeft (bijv. welke candle-tijd het best werkt), welke strategie de bot kiest en waarom, wat de AI ervan vond, en na elke trade de beloning of straf. Alles is opgebouwd uit de echte cijfers, niet verzonnen door een taalmodel.
- **Beloning (zelflerend).** Elke bevestigde strategie van de zoeker krijgt een eigen model. Met **Kiezen tussen strategieën → Zelflerend** (bij Strategie) bepalen die strategieën zelf wanneer er gekocht wordt, elk op haar eigen candle-tijd (los van je eigen candle-instelling en EMA-kruisingen); willen er meerdere kopen, dan kiest de bot er één (Thompson sampling): na het sluiten krijgt de gebruikte strategie de echte winst of het verlies als beloning, en wat geld oplevert kiest hij vaker, terwijl hij de rest af en toe opnieuw probeert. Recente trades tellen zwaarder. De gekozen strategie bepaalt voor die trade de stop, het winstdoel en de maximale duur. Paper en live delen hetzelfde geheugen. Ook bij het trainen telt beloning mee: voorbeelden met een grote winst of groot verlies wegen zwaarder dan trades die rond 0 eindigden, en recente koersen en trades wegen zwaarder dan oude (halveert elke 45 dagen, instelbaar met `halfLifeDays`).
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
      - TRAIN_HOUR=3        # elke nacht om 03:00 trainen
    ports:
      - "8787:8787"        # of achter je reverse proxy met HTTPS (aanbevolen)
    volumes:
      - ./trainer-data:/data
```

Start hem met `docker compose up -d` en kijk in de logs (`docker compose logs vetobot-trainer`) voor de **code**. Die code staat ook in `trainer-data/token`. Er staan geen geheimen in de compose of in een .env-bestand.

**In vetobot** (als admin): Instellingen → **Eigen model** → vul het adres van de trainer (bijv. `https://trainer.jouwdomein.nl` of `http://IP-van-je-VPS:8787`) en de code in, en klik op **Nu trainen met mijn instellingen**. De bot stuurt dan je candle-tijd, stop-loss, take-profit (of maximale tijd in positie), kosten en coinlijst naar de trainer. Na een paar minuten zie je het resultaat op de testperiode, met de aanbevolen minimale modelkans. Het model wordt alleen gebruikt als het getraind is op dezelfde candle-tijd als je bot.

Op de pagina **Trainer** (alleen voor de admin) zie je live wat de trainer doet: welke stap (coins kiezen, koersen ophalen, model trainen, testen), een voortgangsbalk, het logboek, het huidige model en alle eerdere trainingen met hun resultaat. Zodra de trainer een nieuw model heeft, haalt de bot het meteen op.

Gebruik bij voorkeur HTTPS (bijv. via Nginx Proxy Manager op de VPS), zodat de code niet onversleuteld over internet gaat. Het model is gedeeld: alle gebruikers van je vetobot gebruiken hetzelfde model.

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
