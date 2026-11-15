# Een telefoon als leerserver (Samsung Galaxy Z Fold4)

Doel: eerst **meten** hoe snel de telefoon leert, en dat vergelijken met de VPS. Pas daarna kiezen
we of de telefoon de leerserver wordt of de VPS helpt. In dit stappenplan wordt niets aan je bot
of je VPS veranderd.

Reken op ongeveer 30 tot 45 minuten. Het meten zelf duurt een paar minuten per apparaat.

---

## Deel 1: de VPS meten (5 minuten)

Om eerlijk te vergelijken stop je de leerserver even, zodat hij niet tegelijk aan het rekenen is.

```bash
docker compose stop vetobot-trainer
```

```bash
docker compose pull vetobot-trainer
```

```bash
docker run --rm --cpus 2 -e TRAIN_JOBS=2 ghcr.io/iitssjstn/vetobot-trainer:latest python bench.py --rounds 5
```

```bash
docker compose start vetobot-trainer
```

Bewaar de uitkomst (een screenshot is genoeg). Draait de shortcutter op dat moment, dan is de VPS
trager dan normaal; meet dan liever als die stil ligt.

---

## Deel 2: de telefoon klaarmaken

### 2.1 Updates en opslag
- Zet de telefoon aan de lader en installeer alle updates (Instellingen → Software-update).
- Zorg voor minstens 5 GB vrije opslag.

### 2.2 Batterij sparen bij 24/7 aan de lader
- Instellingen → **Batterij** → **Batterijbescherming** (*Battery protection*) → aan, kies
  **Maximaal** (laadt tot 80%). Zo gaat de batterij niet kapot als hij altijd aan de lader ligt.

### 2.3 Ontwikkelaarsopties
1. Instellingen → **Over de telefoon** → **Software-informatie** → tik **7 keer** op
   **Buildnummer**. Je krijgt de melding dat de ontwikkelaarsopties aan staan.
2. Staat bij Instellingen → **Opties voor ontwikkelaars** de optie **Beperkingen voor
   onderliggende processen uitschakelen** (*Disable child process restrictions*), zet die aan.
   Staat hij er niet (op Samsung vaak het geval): **sla dit voor het meten over**. Houd Termux dan
   open op het scherm tijdens het meten. Stopt het meten toch halverwege met
   `[Process completed (signal 9)]`, volg dan **Bijlage A** onderaan.

### 2.4 Termux installeren
Termux is een Linux-omgeving voor Android. Installeer **Termux** uit de **Google Play Store**
(op de Fold4 werkt die versie goed). De versie van F-Droid mag ook.

### 2.5 Termux mag altijd blijven draaien
- Instellingen → **Apps** → **Termux** → **Batterij** → **Onbeperkt** (*Unrestricted*).
- Instellingen → **Batterij** → **Achtergrondgebruik beperken** → **Nooit in slaapstand
  gezette apps** (*Never sleeping apps*) → voeg **Termux** toe.

---

## Deel 3: alles in één keer installeren en meten

Leg de telefoon **opengevouwen**, **zonder hoesje**, op een koele plek (niet in de zon), aan de
lader. Open **Termux** en typ deze ene regel (precies overnemen, dan Enter):

```bash
pkg install -y curl && curl -fsSLo meten.sh https://raw.githubusercontent.com/iitssjstn/vetobot/main/scripts/telefoon-meten.sh && bash meten.sh
```

Het script doet alles zelf:
1. de telefoon wakker houden;
2. Termux bijwerken en een Debian-omgeving installeren;
3. Python, numpy en scikit-learn installeren (dit duurt het langst, 5 tot 10 minuten);
4. de leerserver-code van GitHub halen;
5. meten met 2, 4 en 8 kernen, elk 5 rondes (samen ongeveer 20 minuten);
6. een **samenvatting** tonen.

Houd Termux open op het scherm tot je **Klaar** ziet. Maak dan een screenshot van de
samenvatting en stuur hem door. Let vooral op:
- **Gemiddeld per ronde**: lager is sneller.
- **Laatste t.o.v. eerste ronde**: meer dan 15% trager betekent dat de telefoon warm wordt.

Opnieuw meten? Typ alleen `bash meten.sh`. Wat al geïnstalleerd is, wordt overgeslagen.

---

## Problemen

| Wat je ziet | Wat te doen |
|---|---|
| `pip install` duurt heel lang of geeft een compileerfout | Stuur de laatste regels door; dan was er geen kant-en-klare versie voor de telefoon. |
| Termux sluit of stopt halverwege | Controleer 2.5 (en zo nodig Bijlage A); open Termux opnieuw en typ `bash meten.sh`. |
| `Killed` midden in een ronde | Geheugen vol: sluit andere apps en typ `bash meten.sh` opnieuw. |
| De telefoon wordt erg heet | Stoppen met Ctrl+C (in Termux: Ctrl staat boven het toetsenbord). |

---

## Bijlage A: Android laten stoppen met het afsluiten van Termux (zonder computer)

Nodig als het meten halverwege stopt met `[Process completed (signal 9)]`, en voor een
leerserver die dag en nacht draait. De telefoon moet op wifi zitten.

1. Instellingen → **Opties voor ontwikkelaars** → **Draadloze foutopsporing** aanzetten.
2. Zet Termux en Instellingen naast elkaar op het grote scherm van de Fold.
3. In Termux (niet in Debian; typ eerst `exit` als je in Debian zit):

```bash
pkg install -y android-tools
```

4. In Instellingen: **Draadloze foutopsporing** → **Apparaat koppelen met koppelingscode**. Je
   ziet een code van 6 cijfers en een poort, bijvoorbeeld `192.168.1.20:37123`. In Termux, met
   jouw poort:

```bash
adb pair localhost:37123
```

   Vul de code van 6 cijfers in.

5. Op het hoofdscherm van Draadloze foutopsporing staat bij **IP-adres en poort** een ander
   poortnummer. In Termux, met die poort:

```bash
adb connect localhost:41234
```

6. Kijk je Android-versie na: Instellingen → Over de telefoon → Software-informatie →
   **Android-versie**.

   Android 14 of hoger:

```bash
adb shell settings put global settings_enable_monitor_phantom_procs false
```

   Android 12 of 13:

```bash
adb shell "/system/bin/device_config set_sync_disabled_for_tests persistent; /system/bin/device_config put activity_manager max_phantom_processes 2147483647"
```

Dit blijft ook na een herstart gelden. Draadloze foutopsporing mag je daarna weer uitzetten.
