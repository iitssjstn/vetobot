# Handoff vetobot

## Goal

De eigenaar wil een AI-trader die hij kan vertrouwen:
"Ik wil gewoon een AI trader hebben die ik kan vertrouwen dat hij uit eindelijk winst kan maken, ik weet van de kans dat hij ook verlies kan maken maar dat hij dat zodanig het verlies kan limieteren door de juiste trades te maken".

Laatste opdrachten (25–26 november 2026):
- Audit leren/promotie/stops/live-veiligheid (PR #4–#7, gemerged).
- Bulk live zetten van recepten + homepage-waarschuwing als niets live staat (PR #10, gemerged). Bij een gezakte eis blijft de toestemming **ingetrokken** (keuze eigenaar: "Intrekken (zoals nu)").
- "Live Trading Reliability & Failure Alerts Audit": gezondheidsbewaking tegen stille uitval + bugcontrole van de hele repo (PR #11, gemerged).
- AI-trader deed een dag niets: oorzaak gevonden en gefixt (PR #12–#14, gemerged).

De eigenaar handelt live (op eigen risico, met eigen inzet). Eerste echte trade via Bitvavo is gelukt (+€ 0,17).

## Werkafspraken (bindend)

- **Alleen via PR's.** "we zouden met PR's gaan werken niet meer direct naar de main pushen". Werkbranch `claude/fervent-bohr-ezx52v` (of een eigen branch per onderwerp, bijv. `claude/audit-...`), PR naar `main`. **Nooit zelf mergen**; wachten op expliciete goedkeuring van de eigenaar. De skill `/hervat` zegt nog "direct op `main`": deze afspraak gaat voor.
- Splits grote wijzigingen in losse, overzichtelijke PR's. PR-tekst met: probleem, risico's, oplossing, gewijzigde bestanden, tests, testresultaten, resterende risico's.
- Geen live trading activeren, geen echte trades in tests (alleen mocks/nep-exchanges).
- Nergens een sessielink (repo, commits, PR's). Commits eindigen alleen met `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. `[skip ci]` als alleen `.md` verandert, en dan bij samenvoegen "Create a merge commit" adviseren (squash neemt `[skip ci]` mee).
- Bij gebruik van meerdere agents: elk een eigen werkgebied (bestanden), eigen worktree/branch; hoofdagent controleert, draait alle tests (ook alle branches samen) en maakt de PR's.

## Staat van de code

- `main` = `fb61398` "Merge pull request #14 from iitssjstn/claude/agent-coin-recipe" (bevat PR #4 t/m #14).
- CI draait `npm test` en **alle** Python-tests; images worden alleen gebouwd bij een push naar `main`.
- De eigenaar heeft beide servers bijgewerkt tot en met PR #14 (26 november). Na elke update van de bot zet hij de recepten opnieuw live (Trainer → Live, bulkknop).
- Tests op `main`: `npm test` 319/319; `cd trainer && python -m unittest discover -p "test*.py"` 144 OK.
- Eigenaar werkt via Termius (mobiel) op de thuisserver (`/opt/media-stack`). Claude Code draait daar niet (CPU zonder AVX: "Illegal instruction").

## Active files

- `src/bot.js`: koop-flow, `#liveChecks` (saldo, stop-ronde, saldocontrole vóór de coins), `buyBlockReasons`/`safetyStatus().buyBlock`, exchange-stop (`#placeExchangeStop`, `#onStopState`, `stopFill`), dagboek-hooks, eigen risico, eigen inzet.
- `src/safety.js`: exchange-stop-prijs, saldovergelijking, statussen.
- `src/exchange.js`: `LiveBroker` (operatorId, fees in costEur, `placeStop`/`cancelStop`/`fetchStop`/`findStop`, minimum € 5), `isOrderRefusal`.
- `src/journal.js`: beslissingsdagboek `learning.db` (labels pas na gesloten candles), `labeledRejections`.
- `src/agents.js`: `onlineCorrection` (verschil per trade begrensd op 10 pp), `sizeStake`, `activeAgent`.
- `trainer/stats.py`: t-kwantiel exact (Newton op onvolledige bèta), Welch, `effective_trades` (overlappende eindtests niet dubbel tellen).
- `trainer/probation.py`, `trainer/registry.py`: proefperiode, modelregister, snapshots.
- `trainer/server.py`: `promotion_gate`/`stat_test`, `_finish_round`, `_rollback_target`, `_restore_version`, `add_agent_trades` (onder `publish_lock`), `/registry`.
- `trainer/agent.py`: `_time_split` (splitsing op kalendertijd, embargo), `learn_entry` (NaN/inf overslaan).
- `public/index.html`: Learning (grafiek praktijk vs verwachting, proefstatus), Posities → Live-veiligheid (incl. buyBlock), Trainer → Live.
- `src/health.js` (nieuw): gezondheid uit tijdstempels (gezond/probleem/kritiek/gepauzeerd/gestopt), meldingen met dedupe/escalatie/"Opgelost". `src/runstate.js`: onverwachte herstart herkennen. `manager.checkHealth` (elke 30 s, herstart planner), `/healthz` 503 bij hangende ronde, dashboardblok Gezondheid.
- `src/bot.js` `agentHourlyLog`: elk uur "AI-trader afgelopen 60 min: …" in activiteitenlog en containerlog. `#agentSignal`: handelt het gekozen recept de coin niet, dan een ander toegestaan recept dat dat wel doet.
- Tests: `test/health.test.js`, `test/review-health.test.js`, `test/live-safety.test.js`, `test/learning-data.test.js`, `test/regression*.test.js`, `trainer/test_learning_data.py`, `trainer/test_regression.py`, nieuwe Audit-klassen in `trainer/test_trainer.py`.

## Veranderingen gemaakt (deze chat, samengevat)

1. Live op eigen risico, extra recepten, eigen inzet door de AI-trader, live recepten vallen niet meer weg, operatorId-fix (alle live orders faalden), fees in live, web-app-manifest.
2. Leersysteem: beslissingsdagboek, modelversies met poortwachter, Learning-pagina, proefperiode met automatisch terugvallen, statistische promotietoets, volatiliteit, stop-loss bij Bitvavo, saldocontrole.
3. Audit (PR #4–#7), 12 bevestigde bugs gerepareerd, elk met een eerst falende test:
   - live: stop deels uitgevoerd, dubbele stop na time-out, controles pas ná aankopen (nu buyBlock: bij twijfel geen nieuwe aankopen; bewaken/verkopen nooit geblokkeerd);
   - leerdata: lek via coins met kortere geschiedenis, NaN/inf liet training crashen, label afhankelijk van rekenmoment, uitschieter in de bijsturing;
   - statistiek: herhaalde rondes telden als nieuwe trades (±26% onterechte promoties → 0,3–7%), t-kwantiel te klein, terugzetten naar een gezakt model, race feedback/terugzetten;
   - CI draaide niet alle Python-tests.

4. Gezondheidsbewaking (PR #11): zes oorzaken van stille uitval opgelost (hangende ronde legde ook de positiebewaking stil, fouten alleen in de console, geen crash-afhandeling, Discord-fouten onzichtbaar, `/healthz` altijd ok). Daarna bugcontrole van de hele repo met 4 agents: 14 bugs gefixt, o.a. deels uitgevoerde stop/verkoop kwijt, hele positie dicht bij half gevulde verkoop, state pas aan het eind opgeslagen, dubbele verkoop na verbindingsfout bij limietorders, vals alarm "niet bewaakt", leerserver-race in koersopslag en NaN in trades.
5. AI-trader kocht een dag niets (PR #14): met de fase onbekend of weinig bewijs koos de Strategy Agent het hoofdrecept; handelde dat de coin niet, dan stopte het ("coin niet gekozen" 52×). Andere live gezette recepten werden alleen geprobeerd als het gekozen recept zelf niet live mocht. Nu: ander toegestaan recept dat de coin handelt. Daarna dekt hij alle 12 coins (~170 candles/uur); dat hij in rustige markt niets koopt is de drempel (+0,50%, hoogste live verwachting ±0,3%), geen fout (kenmerken bot = leerserver, geen micro-features in het AI-trader-model).

## Failed attempts

- Limietorders "niet gevuld" was eigenlijk ccxt die zonder operatorId elke order weigerde (opgelost).
- Agents die gestopt worden zonder commits verliezen hun worktree; bij hervatten maken ze een nieuwe vanaf origin/main (werkt).
- Rebasen van een branch met merge-commits speelt conflicten opnieuw af: niet rebasen als `main` al in de branch zit.
- Dashboard-screenshots: niet via `file://`; serveer `public/` met een kleine HTTP-server en vang `/api/**` af.
- Force-push (ook na `--amend` op een eigen branch) wordt door de auto-mode geblokkeerd: een commit met per ongeluk `[skip ci]` laten staan en "Create a merge commit" adviseren.
- Containerlogs zijn weg na een update (container opnieuw aangemaakt); daarom de uurlijkse AI-trader-regel. Diagnose stille AI-trader: Trainer → "Wordt hij beter?" → "Waarom koopt de AI-trader (niet)?" (alleen in geheugen, begint na herstart opnieuw).

## Specific next steps

1. Bijwerken (alleen na merge, eigenaar doet het zelf):
   - VPS: `docker compose pull vetobot-trainer && docker compose up -d vetobot-trainer` (alleen als `trainer/` veranderde)
   - Thuisserver: `cd /opt/media-stack && docker compose pull vetobot && docker compose up -d vetobot`
2. Live volgen: `docker logs -t --since 2h vetobot 2>&1 | grep "AI-trader afgelopen"`; AI-chat "ik gebruik recept …, dat deze coin wel handelt" = PR #14 werkt. Bij de eerstvolgende aankoop: Posities → Live-veiligheid "actief bij Bitvavo".
3. Niet-gefixte vondsten uit de bugcontrole (alleen op verzoek, elk eigen PR): limiet-verkoop als `createOrder` zelf een time-out geeft (dan market van alles); maker-fee niet ingecalculeerd bij limiet-koop met bijna het hele saldo; `#fillOf` met lege `average`/`price` geeft NaN-fee; `#agentExit` geeft `true` bij BUSY; `posMaxPct` in training neemt instapcandle mee (bot niet); `config.json` lezen-aanpassen-schrijven zonder lock; procesbrede foutmeldingen gaan naar alle gebruikers; `uncleanRestart` blijft voor het hele proces gezet; `manager.stop` wacht niet op een lopende tick.
4. Resterende risico's uit de audit, alleen op verzoek, elk als eigen PR:
   - verkoop met verloren antwoord pas zichtbaar bij de volgende saldocontrole (orders opzoeken);
   - correlatie binnen één eindtest: trade-rendementen met tijd bewaren, dan clusteren per dag of block-bootstrap;
   - proefperiode zakt ook bij een goed model in ±11–19% (overwegen: 0,95 of vergelijken met 0);
   - na de afkoeling een nieuwe eindtestperiode eisen voordat een gezakt recept terug mag;
   - `add_agent_trades`: NaN/inf niet opslaan en dubbele feedback ontdubbelen;
   - `agent_extra`: echte trades ook op recept filteren;
   - `#settleJournal`: slippage twee keer rekenen (labels 0,1 pp te optimistisch);
   - `cleanup_files` onder `publish_lock`; terugzetten atomair over bestanden heen.
5. Bekende, bewuste eigenschappen (geen bug): in live kost een aankoop inzet + fee; de Risk Agent halveert de inzet zonder plan per marktfase (nooit onder € 5); met de kleinste live-start (€ 5) geen stop bij Bitvavo (onder het minimum).
