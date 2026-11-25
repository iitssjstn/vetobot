# Handoff vetobot

## Goal

De eigenaar wil een AI-trader die hij kan vertrouwen:
"Ik wil gewoon een AI trader hebben die ik kan vertrouwen dat hij uit eindelijk winst kan maken, ik weet van de kans dat hij ook verlies kan maken maar dat hij dat zodanig het verlies kan limieteren door de juiste trades te maken".

Laatste opdracht (25 november 2026): een audit van leren, statistische modelpromotie, stop-losses bij Bitvavo en live-veiligheid. "Focus op daadwerkelijke bugs en aantoonbare verbeteringen. Bouw niets opnieuw dat al correct bestaat." Uitgevoerd en gemerged (PR #4 t/m #7).

De eigenaar handelt live (op eigen risico, met eigen inzet). Eerste echte trade via Bitvavo is gelukt (+€ 0,17).

## Werkafspraken (bindend)

- **Alleen via PR's.** "we zouden met PR's gaan werken niet meer direct naar de main pushen". Werkbranch `claude/fervent-bohr-ezx52v` (of een eigen branch per onderwerp, bijv. `claude/audit-...`), PR naar `main`. **Nooit zelf mergen**; wachten op expliciete goedkeuring van de eigenaar. De skill `/hervat` zegt nog "direct op `main`": deze afspraak gaat voor.
- Splits grote wijzigingen in losse, overzichtelijke PR's. PR-tekst met: probleem, risico's, oplossing, gewijzigde bestanden, tests, testresultaten, resterende risico's.
- Geen live trading activeren, geen echte trades in tests (alleen mocks/nep-exchanges).
- Nergens een sessielink (repo, commits, PR's). Commits eindigen alleen met `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. `[skip ci]` als alleen `.md` verandert, en dan bij samenvoegen "Create a merge commit" adviseren (squash neemt `[skip ci]` mee).
- Bij gebruik van meerdere agents: elk een eigen werkgebied (bestanden), eigen worktree/branch; hoofdagent controleert, draait alle tests (ook alle branches samen) en maakt de PR's.

## Staat van de code

- `main` = `0068f7f` "Merge pull request #5 from iitssjstn/claude/audit-learning-data" (bevat PR #4, #5, #6, #7).
- CI: alle vier de builds geslaagd; CI draait nu `npm test` en **alle** Python-tests (`python -m unittest discover -p "test*.py"`).
- De eigenaar heeft de updates na de audit nog niet bevestigd. Bijwerken: VPS en thuisserver (zie stap 1).
- Tests op `main`: `npm test` 284/284; `cd trainer && python -m unittest discover -p "test*.py"` 141 OK.

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
- Tests: `test/live-safety.test.js`, `test/learning-data.test.js`, `test/regression*.test.js`, `trainer/test_learning_data.py`, `trainer/test_regression.py`, nieuwe Audit-klassen in `trainer/test_trainer.py`.

## Veranderingen gemaakt (deze chat, samengevat)

1. Live op eigen risico, extra recepten, eigen inzet door de AI-trader, live recepten vallen niet meer weg, operatorId-fix (alle live orders faalden), fees in live, web-app-manifest.
2. Leersysteem: beslissingsdagboek, modelversies met poortwachter, Learning-pagina, proefperiode met automatisch terugvallen, statistische promotietoets, volatiliteit, stop-loss bij Bitvavo, saldocontrole.
3. Audit (PR #4–#7), 12 bevestigde bugs gerepareerd, elk met een eerst falende test:
   - live: stop deels uitgevoerd, dubbele stop na time-out, controles pas ná aankopen (nu buyBlock: bij twijfel geen nieuwe aankopen; bewaken/verkopen nooit geblokkeerd);
   - leerdata: lek via coins met kortere geschiedenis, NaN/inf liet training crashen, label afhankelijk van rekenmoment, uitschieter in de bijsturing;
   - statistiek: herhaalde rondes telden als nieuwe trades (±26% onterechte promoties → 0,3–7%), t-kwantiel te klein, terugzetten naar een gezakt model, race feedback/terugzetten;
   - CI draaide niet alle Python-tests.

## Failed attempts

- Limietorders "niet gevuld" was eigenlijk ccxt die zonder operatorId elke order weigerde (opgelost).
- Agents die gestopt worden zonder commits verliezen hun worktree; bij hervatten maken ze een nieuwe vanaf origin/main (werkt).
- Rebasen van een branch met merge-commits speelt conflicten opnieuw af: niet rebasen als `main` al in de branch zit.
- Dashboard-screenshots: niet via `file://`; serveer `public/` met een kleine HTTP-server en vang `/api/**` af.

## Specific next steps

1. Eigenaar laten bijwerken:
   - VPS: `docker compose pull vetobot-trainer && docker compose up -d vetobot-trainer`
   - Thuisserver: `docker compose pull vetobot && docker compose up -d vetobot`
2. Live controleren bij de eerstvolgende aankoop: Posities → Live-veiligheid "actief bij Bitvavo", en in de Bitvavo-app dat de stop-order bestaat. Bij "Nieuwe aankopen staan stil": de reden bekijken.
3. Resterende risico's uit de audit, alleen op verzoek, elk als eigen PR:
   - verkoop met verloren antwoord pas zichtbaar bij de volgende saldocontrole (orders opzoeken);
   - correlatie binnen één eindtest: trade-rendementen met tijd bewaren, dan clusteren per dag of block-bootstrap;
   - proefperiode zakt ook bij een goed model in ±11–19% (overwegen: 0,95 of vergelijken met 0);
   - na de afkoeling een nieuwe eindtestperiode eisen voordat een gezakt recept terug mag;
   - `add_agent_trades`: NaN/inf niet opslaan en dubbele feedback ontdubbelen;
   - `agent_extra`: echte trades ook op recept filteren;
   - `#settleJournal`: slippage twee keer rekenen (labels 0,1 pp te optimistisch);
   - `cleanup_files` onder `publish_lock`; terugzetten atomair over bestanden heen.
4. Bekende, bewuste eigenschappen (geen bug): in live kost een aankoop inzet + fee; de Risk Agent halveert de inzet zonder plan per marktfase (nooit onder € 5); met de kleinste live-start (€ 5) geen stop bij Bitvavo (onder het minimum).
