# Handoff vetobot

## Goal

De eigenaar wil een AI-trader die hij kan vertrouwen:
"Ik wil gewoon een AI trader hebben die ik kan vertrouwen dat hij uit eindelijk winst kan maken, ik weet van de kans dat hij ook verlies kan maken maar dat hij dat zodanig het verlies kan limieteren door de juiste trades te maken".

Besluiten in deze chat (7 november 2026):
- De geparkeerde verbeteringen voor verlies beperken: "Maak de geparkeerde dingen maar alvast dan kunnen we daarna volledig testen". Gebouwd.
- Een team van agents (Learning, Market, Strategy, Risk, Execution): "Maak het maar". Gebouwd.
- "En daarna mag je kijken of er bugs, errors of lege code wat we niet meer gebruiken, los de bugs of errors op en haal de lege code weg". Gedaan.

Nu: alles in paper volledig testen. Niets nieuws bouwen tot de eigenaar het vraagt.

## Staat van de code

- Branch: `main` (direct op `main`, geen PR's).
- Laatste codecommit: `4516df4` "AI-trader: leren gebruikt veel minder geheugen (leerserver liep vol)".
- CI: geslaagd voor `4516df4`; beide images gebouwd.
- VPS (`vetobot-trainer`): bijgewerkt naar `4516df4`, de eigenaar bevestigde dat de geheugenfout weg is.
- Thuisserver (`vetobot`): niet bevestigd dat die na `82fdcec` (het team) is bijgewerkt. Bij twijfel: `docker compose pull vetobot && docker compose up -d vetobot`.

## Active files

- `trainer/agent.py`: AI-trader leren en backtest; marktvergelijking (`market_move`, `edgePct`), resultaat per marktfase (`byRegime`), geheugenplafonds (`MAX_EXIT_ROWS`, `MAX_ENTRY_ROWS`).
- `trainer/agent_search.py`: recepten; score (winst/terugval `ratio`, `edge`), status incl. "te riskant", Strategy Agent (`regime_score`, `choose_per_regime`).
- `trainer/market.py`: Market Agent; marktfase per coin op 1h-candles (`RegimeLookup`).
- `trainer/server.py`: publiceert `agent.json` met `regimes` (recept per fase), `agent_stage`, `regime_plan`, blokkeren van een te riskant recept.
- `src/agents.js`: Strategy/Risk/Execution Agent in de bot (pure functies, getest in `test/agents.test.js`).
- `src/bot.js`: `#marketRegime`, `#agentSignal` → `#agentBuy`, verkopen met het recept dat kocht, `#execution`, `agentTeam()`.
- `src/manager.js`: valideert ook de recepten per fase uit `agent.json`.
- `public/index.html`: pagina Trainer: blok "Het team van de AI-trader", kolommen "Per marktfase", "Beter dan de markt", "Winst / terugval".
- `README.md`: sectie "Het team van de AI-trader" en de regels voor verlies beperken.

## Veranderingen gemaakt

1. Verlies beperken (`1f6b86f`):
   - recepten gerangschikt op winst ten opzichte van de grootste terugval;
   - elke testtrade vergeleken met wat alle coins samen in dezelfde tijd deden: alleen het voordeel boven de markt telt, voor "goed" en "betrouwbaar";
   - een terugval van meer dan 25% maakt een recept voor altijd "te riskant", ook niet in paper. Is er dan geen ander recept, dan staat de AI-trader op "geblokkeerd" en koopt de bot niets.
2. Het team (`82fdcec`):
   - Market Agent: marktfase per coin op 1h-candles, in de leerserver en de bot met dezelfde berekening.
   - Strategy Agent: per fase het recept dat het meest beter deed dan de markt (minstens 20 trades in die fase, status betrouwbaar of veelbelovend). Verloor het hoofdrecept in een fase van de markt, dan "niet handelen" in die fase. Zonder bewijs: het hoofdrecept.
   - Risk Agent: 6 uur pauze na 3 verliezen op rij; halve inzet (nooit onder € 5) bij weinig bewijs voor de fase; geen aankoop in een coin waar de laatste 3 orders gemiddeld meer dan 0,5% slechter uitvielen.
   - Execution Agent: meet de prijsafwijking bij elke order en waarschuwt boven 0,3%.
   - Een bug gerepareerd: verkopen gebeurde altijd met het actuele recept; nu met het recept dat kocht.
3. Opruimen (`205fb27`):
   - weg: `askVeto` (vervangen door `askVetoChain`), `isDiscordWebhook` (dubbel met `secrets.js`), `max_hold_candles`, ongebruikte imports en variabelen;
   - gecontroleerd: ESLint, pyflakes en vulture schoon; alle dashboard-velden, API-routes en trainer-endpoints kloppen.
4. Geheugen (`97fedee`, `4516df4`): de leerserver liep vol (6,5 GB) en werd steeds door het systeem gestopt, met HTTP 502 in het dashboard.
   - Oorzaak: leervoorbeelden als Python-lijsten. Dit zat er al vóór de updates van deze chat.
   - Nu: numpy-blokken, plafonds op het aantal voorbeelden en `market_move` met numpy-zoeken.
   - Gemeten met 24 coins op 5m: 60 dagen van 2,0 naar 0,66 GB; 180 dagen 1,2 GB. De voorbeelden zijn aantoonbaar identiek.

Tests bij `4516df4`: `npm test` 150/150 geslaagd; `cd trainer && python3 -m unittest test_trainer` 43 tests OK.

## Failed attempts

- Eerst dacht ik dat alleen de nieuwe tijd → candle-tabel (dict, ongeveer 8 MB per coin) de leerserver liet vollopen. Dat was het niet alleen. Meten met `resource.getrusage` op een oude en een nieuwe worktree liet zien dat `learn_exit` met Python-lijsten de echte oorzaak was. Altijd eerst meten met realistische aantallen (24 coins, 60+ dagen 5m).
- HTTP 502 in het dashboard betekent: Nginx Proxy Manager bereikt de leerserver niet. Diagnose:
  - `docker compose ps` (Created tegenover Up);
  - `docker inspect vetobot-trainer --format '{{.RestartCount}}'`;
  - `dmesg | grep -i "out of memory"`.
  `OOMKilled` stond op false terwijl het systeem het proces wel had gestopt; dmesg was de echte bron.
- `gh pr list` werkt niet (GraphQL geblokkeerd); gebruik `gh api repos/iitssjstn/vetobot/pulls?state=open`.
- Lokaal testen: na `npm install` een `package-lock.json` en na de Python-tests `trainer/__pycache__` weggooien, niet committen.
- Uit eerdere chats: een test mag niet naar `/data` schrijven; draai `python3 -c "import thoughts"` vóór een push; gebruik in het dashboard `whenAt` buiten `renderTrainer`.

## Specific next steps

0. **Plan richting live staat in `PLAN.md`** (5 stappen: validatie en eindtest scheiden, drawdown op een echte portefeuille, werkelijke kosten in het leren, strengere live-toelating, daarna lange paper-test; plus stap 6: het overleg van de AI-trader terug te lezen op de pagina AI-chat, bij voorkeur vóór stap 5). Vastgelegd op verzoek van de eigenaar: "Kunnen we dit als plan neerzetten". Nog niets van gebouwd; per stap wachten op zijn akkoord.
1. Niets bouwen tot de eigenaar het vraagt; hij test nu alles in paper.
2. Wat de eigenaar in paper moet zien:
   - eerst koopt de AI-trader met het hoofdrecept en de halve inzet ("weinig bewijs");
   - na een paar leerrondes verschijnen cijfers in "Per marktfase" en kiest de Strategy Agent per fase (bericht "Strategy Agent: ..." bij "Wat denkt het model?").
3. Als de eigenaar resultaten deelt, let op:
   - halen recepten een 2e/3e ronde met een positieve "Beter dan de markt"?
   - wordt er een recept "te riskant"?
   - hoe groot is de afwijking in "Execution Agent" (in paper vult hij tegen het echte orderboek)?
   - komt de Risk Agent-pauze vaak voor?
4. Mogelijke vervolgstappen, alleen op verzoek:
   - Market Agent uitbreiden met een fase "onrustig" (beweeglijkheid). Daarvoor moet een kenmerk in zowel `src/mlmodel.js` als `trainer/features.py` erbij.
   - De werkelijke uitvoeringskosten uit de Execution Agent terugsturen naar de leerserver, zodat `costPct` klopt.
   - De Risk Agent instelbaar maken in het dashboard (nu vaste waarden in `RISK` in `src/agents.js`).
5. Eerder genoemd maar niet gekozen:
   - de namen opschonen (AI-trader, AI-controleur, Winstkans-model, Leerserver);
   - het taalmodel laten antwoorden op vragen over de AI-trader.
6. Na 14 dagen orderboek-opname draait het experiment vanzelf; de uitslag staat op de pagina Trainer.
