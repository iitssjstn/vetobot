# Handoff vetobot

## Goal

De eigenaar wil een volwaardige AI-trader die zelf uitzoekt hoe hij het best kan traden:
"Ik wil dat de AI trader alles zelf uit zoekt maar dan voor trading, wat de beste manier is om te traden"
en die hij kan vertrouwen:
"Ik wil gewoon een AI trader hebben die ik kan vertrouwen dat hij uit eindelijk winst kan maken, ik weet van de kans dat hij ook verlies kan maken maar dat hij dat zodanig het verlies kan limieteren door de juiste trades te maken".

Laatste besluit (7 november 2026, 01:11): "laat hem nu maar eventjes door lopen we hebben aardig veel weer aangepast".
Er wordt dus nu niets nieuws gebouwd; de AI-trader draait in paper en verzamelt resultaten.

## Staat van de code

- Branch: `main` (er wordt direct op `main` gewerkt, geen PR's).
- Laatste codecommit: `d88ad70` "Kopregel toont de candle-tijd en coins van de AI-trader als die aan staat".
- CI (`.github/workflows/docker.yml`): geslaagd voor `d88ad70`; beide images (`ghcr.io/iitssjstn/vetobot` en `ghcr.io/iitssjstn/vetobot-trainer`) zijn gebouwd.
- De eigenaar heeft rond 01:00 bijgewerkt (zijn screenshots tonen de recepten en de AI-trader). De laatste twee kleine commits (`ab93f63` AI-controleur aan/uit, `d88ad70` kopregel) vragen nog een update van vetobot op de thuisserver als dat nog niet gedaan is:
  - Thuisserver: `docker compose pull vetobot && docker compose up -d vetobot`
  - VPS: `docker compose pull vetobot-trainer && docker compose up -d vetobot-trainer`

## Active files

- `trainer/agent.py`: de AI-trader (fitted Q-iteration met HistGradientBoosting): verkopen en kopen leren, backtest met terugval, export naar JSON-bomen.
- `trainer/agent_search.py`: recepten (candle-tijd, maximale duur, modelgrootte, vooruitkijken), keuze per ronde, status (betrouwbaar/veelbelovend/oefenen/afgevallen), rangschikking.
- `trainer/server.py`: leerserver: agent-worker, `/agent.json`, live-resultaten, orderboek-opname, winstkans-model, status voor het dashboard.
- `trainer/micro.py`: orderboek en transacties opnemen, kenmerken, experiment met/zonder.
- `trainer/thoughts.py`: "Wat denkt het model?" in gewoon Nederlands.
- `src/bot.js`: bot: AI-trader koopt/verkoopt per candle (`#agentSignal`, `#agentExit`), orderboek-check, AI-controleur aan/uit, gedachten.
- `src/mlmodel.js`: kenmerken, `predictRaw`, `validateAgent`, `positionFeatures`, uitleg per kenmerk.
- `src/manager.js`: haalt AI-trader (`/agent.json`), strategieën en orderboek-kenmerken op bij de leerserver; feedback-wachtrij.
- `public/index.html`: dashboard; pagina Trainer (AI-trader, gedachten, samenwerking, orderboek, ingeklapte groepen), instellingen.
- `README.md`: uitleg per onderdeel.

## Veranderingen gemaakt

In deze chat, in volgorde:
- Trainer: instelbaar schema, groeiende koerscache (onthoudt ook als Bitvavo geen oudere candles heeft), Bad Request bij candles opgelost.
- Winstkans-model: BTC/groter plaatje/tijd als kenmerken, leren van eigen trades, marktfase, uitleg per voorspelling, scorebord AI + model.
- Strategie-zoeker met bandit en schaduwtrades (oude methode; staat stil zolang de AI-trader aan staat).
- Orderboek-check bij kopen, paper vult tegen het echte orderboek, orderboek/transacties opnemen + experiment na 14 dagen.
- "Wat denkt het model?" (gedachten van leerserver en bot).
- AI-trader: lerende agent die zelf kopen en verkopen leert, zoekt zelf recepten en coins, pas betrouwbaar na meerdere rondes, terugval wordt meegewogen, live pas na 20 echte trades met gemiddeld ≥ +0,1%.
- Instelling "AI-controleur bij de AI-trader" (aan/uit), kopregel toont AI-trader, pagina Trainer opgeschoond.

Tests bij de laatste codecommit: `npm test` 147/147 geslaagd; `cd trainer && python3 -m unittest test_trainer` 37 tests OK.
Testen lokaal: ccxt- en express-stubs in `node_modules` nodig (zie hoe CI het doet), en end-to-end met een nep-trainer.

## Failed attempts

- Eerste build na het trainingsschema faalde: een test schreef naar `/data` op de bouwserver. Opgelost door de test een tijdelijke map te geven.
- Een build faalde op een syntaxfout in `trainer/thoughts.py` (aanhalingsteken). Altijd `python3 -c "import thoughts"` en de unittests draaien voor een push.
- In het dashboard is `when` binnen `renderTrainer` lokaal; daarbuiten bestaat in Chrome een globale `when` (Observable). Gebruik `whenAt` buiten `renderTrainer`.
- `gh run list` met `--limit 3` gaf soms een proxy-fout (numerieke repo-paden); `--limit 1` werkt.
- Strategie-zoeker (oude methode) bleef 1m-candles proberen en bouwde te weinig door; vervangen door de AI-trader met recepten.

## Specific next steps

1. Niets bouwen tot de eigenaar het vraagt. Hij laat de AI-trader nu in paper lopen.
2. Als de eigenaar resultaten deelt: lees de ranglijst van recepten (rondes, gemiddelde, terugval, kopen en vasthouden) en "In de praktijk". Let erop of recepten een 2e/3e ronde halen en positief blijven, en of de testperiode een sterk stijgende markt was (dan zegt winst weinig).
3. Geparkeerd, alleen op verzoek (eigenaar zei "laat hem nu maar eventjes door lopen"). De drie verbeteringen voor verlies beperken:
   1. rangschikken op winst ten opzichte van terugval (bijv. totale winst / grootste terugval) in plaats van `avg - dd/100` in `agent_search.score`;
   2. vergelijken met de markt: alleen meetellen wat beter is dan meedobberen met de markt tijdens de trades;
   3. recepten met een terugval van meer dan 25% nooit gebruiken, ook niet om in paper te oefenen.
4. Andere ideeën die genoemd zijn maar niet gekozen: de namen opschonen (AI-trader, AI-controleur, Winstkans-model, Leerserver; overzicht in het gesprek, niet doorgevoerd), en het taalmodel laten antwoorden op vragen over de AI-trader.
5. Na 14 dagen orderboek-opname draait het experiment vanzelf; uitslag staat op de pagina Trainer onder "Orderboek en transacties".
