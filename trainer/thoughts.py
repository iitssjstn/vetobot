"""Het model "praat": korte zinnen in gewoon Nederlands over wat de trainer doet en denkt.

Alles hier is opgebouwd uit de echte cijfers van de training en de zoeker (geen taalmodel),
zodat het klopt en niets kost.
"""

LABELS = {
    'rsi14': 'de RSI', 'adx14': 'de trendsterkte (ADX)', 'atrPct': 'hoe hard de coin normaal beweegt (ATR)',
    'volRatio': 'het volume t.o.v. normaal', 'distEma20Atr': 'de afstand tot de EMA20', 'distEma50Atr': 'de afstand tot de EMA50',
    'emaSpreadPct': 'de afstand tussen snelle en trage EMA', 'ret1': 'de laatste candle', 'ret3': 'de laatste 3 candles',
    'ret12': 'de laatste 12 candles', 'er24': 'hoe recht de koers liep', 'greens': 'het aantal groene candles op rij',
    'toHigh48Atr': 'de ruimte tot de recente top', 'fromLow48Atr': 'de afstand tot de recente bodem', 'upperWick': 'de bovenwick',
    'volTrend': 'de volume-trend', 'ret48': 'de laatste 48 candles', 'htfTrendPct': 'de trend over het grotere plaatje',
    'htfRet96': 'de laatste 96 candles', 'htfPos240': 'waar de koers in zijn range zit', 'btcRet3': 'Bitcoin op korte termijn',
    'btcRet12': 'wat Bitcoin doet', 'btcRet48': 'Bitcoin over een langere periode', 'btcTrendPct': 'de trend van Bitcoin',
    'relRet12': 'hoe de coin het doet t.o.v. Bitcoin', 'relRet48': 'de coin t.o.v. Bitcoin (langer)', 'hourUtc': 'het tijdstip',
    'dowUtc': 'de dag van de week',
    'microBookImb': 'kopers t.o.v. verkopers in het orderboek', 'microSpread': 'het verschil bied/laat',
    'microBuyRatio60': 'de koopdruk van het afgelopen uur', 'microFlow60': 'de netto geldstroom van het afgelopen uur',
    'microIntensity': 'hoe druk er gehandeld wordt',
}


def pct(v, dec=2, sign=True):
    if v is None:
        return '–'
    s = f'{v:+.{dec}f}' if sign else f'{v:.{dec}f}'
    return s.replace('.', ',') + '%'


def num(n):
    return f'{int(n):,}'.replace(',', '.')


def hold(minutes):
    if minutes >= 60:
        h = minutes / 60
        return f'{h:g} uur'.replace('.', ',')
    return f'{minutes} min'


def name(c):
    return f"{c['timeframe']}-candles, doel {pct(c['targetPct'], 1)} / stop {pct(-c['stopPct'], 1)}, max {hold(c['holdMinutes'])}"


# ---------- Training ----------

def train_start(cfg, tf_min):
    return (f"Ik ga een nieuw model trainen op {cfg['timeframe']}-candles. Mijn opdracht: voorspellen of de koers eerst "
            f"{pct(cfg['targetPct'], 1)} stijgt voordat hij {pct(-cfg['stopPct'], 1)} zakt, binnen {hold(int(cfg['horizon']) * tf_min)}. "
            f"De kosten ({pct(cfg['costPct'], 2, False)} per ronde) reken ik mee.")


def train_data(used, n_train, n_test, win_rate, fb_train):
    s = (f"Ik heb {len(used)} coins bekeken en {num(n_train)} momenten uit het verleden verzameld om van te leren "
         f"(en {num(n_test)} recentere om mezelf eerlijk te testen). In {pct(win_rate, 0, False)} van de gevallen werd het doel gehaald.")
    if fb_train:
        s += f' Ook {fb_train} echte trades van de bot neem ik mee; die tellen zwaarder.'
    return s


def importance(model, features, top=5):
    imp = sorted(zip(features, model.feature_importances_), key=lambda x: -x[1])[:top]
    parts = [f'{LABELS.get(k, k)} ({v * 100:.0f}%)'.replace('.', ',') for k, v in imp if v > 0]
    if not parts:
        return None
    return 'Waar ik het meest op let bij mijn voorspelling: ' + ', '.join(parts) + '.'


def train_result(metrics, good):
    best, base = metrics.get('best'), metrics['base']
    if not best:
        return ('Op de testperiode kon ik geen kansdrempel vinden waarbij ik genoeg trades met winst kies. '
                'Ik gebruik dit model niet.')
    s = (f"Op de testperiode (die ik niet gezien had): als ik alleen koop bij ≥ {best['minProb'] * 100:.0f}% kans, "
         f"verdien ik gemiddeld {pct(best['avgReturnPct'])} per trade over {best['n']} trades ({best['winRate']:.0f}% gewonnen). "
         f"Zomaar kopen: {pct(base['avgReturnPct'])}.")
    regimes = metrics.get('regimes') or {}
    good_r = [k for k, v in regimes.items() if v.get('avgReturnPct') is not None and v.get('nSelected', 0) >= 30 and v['avgReturnPct'] > 0]
    bad_r = [k for k, v in regimes.items() if v.get('avgReturnPct') is not None and v.get('nSelected', 0) >= 30 and v['avgReturnPct'] <= 0]
    if good_r or bad_r:
        s += ' ' + ' '.join(filter(None, [
            f"In een {' en '.join(good_r)} markt doe ik het goed." if good_r else '',
            f"In een {' en '.join(bad_r)} markt maak ik verlies, daar moet ik voorzichtig zijn." if bad_r else '',
        ]))
    s += (' Dat is goed genoeg: ik ga dit model gebruiken.' if good else
          ' Dat is niet overtuigend genoeg, dus ik blijf het vorige model gebruiken.')
    return s


# ---------- Strategie-zoeker ----------

WHY = {
    'retest': 'mijn beste strategie tot nu toe, opnieuw testen op de nieuwste koersen: werkt hij nog?',
    'near': 'een variatie op mijn beste strategie tot nu toe, misschien is dit nog beter',
    'fresh': 'iets nieuws dat ik nog nooit geprobeerd heb',
    'old': 'een oude strategie opnieuw, de markt kan veranderd zijn',
}


def search_try(c, why):
    return f"Ik probeer nu: {name(c)}. Waarom: {WHY.get(why, why)}."


def search_result(c, va):
    best, base = va.get('best'), va['base']
    if not best:
        return f"Hierbij vind ik geen kansdrempel met genoeg winstgevende trades. Afgevallen."
    better = best['avgReturnPct'] - max(0.0, base['avgReturnPct'])
    s = (f"Beoordeling: bij ≥ {best['minProb'] * 100:.0f}% kans gemiddeld {pct(best['avgReturnPct'])} per trade "
         f"({best['n']} trades), zomaar kopen {pct(base['avgReturnPct'])}.")
    if best['avgReturnPct'] <= 0:
        s += ' Nog steeds verlies na kosten.'
    elif better > 0.3:
        s += ' Dat ziet er veelbelovend uit, nu de controle op de nieuwste periode.'
    else:
        s += ' Een klein voordeel; kan ook toeval zijn.'
    return s


def search_status(entry, need):
    st = entry.get('status')
    ho = entry.get('holdout') or {}
    if st == 'bevestigd':
        return (f"Bevestigd! Ook op de nieuwste periode {pct(ho.get('avgReturnPct'))} per trade ({ho.get('n')} trades). "
                'Deze strategie vertrouw ik.')
    if st == 'niet bevestigd':
        return (f"Op de nieuwste periode viel hij tegen ({pct(ho.get('avgReturnPct'))} per trade). "
                'Waarschijnlijk was het geluk, dus ik vertrouw hem (nog) niet.')
    if st == 'niet goed genoeg' and entry.get('score') is not None and entry['score'] > 0:
        return f"Te weinig voordeel: ik eis nu minstens {pct(need)} per trade beter dan zomaar kopen."
    return None


def search_insights(results, need, n_scored):
    by_tf = {}
    for r in results.values():
        if r.get('score') is None:
            continue
        by_tf.setdefault(r['timeframe'], []).append(r['val']['best']['avgReturnPct'])
    lines = []
    if len(by_tf) >= 2:
        avg = sorted(((sum(v) / len(v), tf, len(v)) for tf, v in by_tf.items()), reverse=True)
        top, low = avg[0], avg[-1]
        lines.append(f"Wat ik tot nu toe zie: {top[1]}-candles werken het best (gemiddeld {pct(top[0])} per trade over {top[2]} strategieën), "
                     f"{low[1]}-candles het slechtst ({pct(low[0])}).")
        if low[0] < 0 and low[1] in ('1m', '5m'):
            lines.append(f'Op {low[1]} eten de kosten bijna alle winst op; de bewegingen zijn te klein.')
    from search import tf_stats, tf_weight
    for tf, st in sorted(tf_stats(results).items()):
        if tf_weight(st) <= 0.1:
            lines.append(f"{tf}-candles probeer ik voortaan bijna niet meer: {st['n']} van {st['n']} strategieën gaven verlies.")
    best = sorted((r for r in results.values() if r.get('status') == 'bevestigd'), key=lambda r: -r['score'])
    if best:
        lines.append(f"Ik bouw nu vooral verder op {name(best[0])}: 2/3 van elke ronde zijn variaties daarop.")
    longs = [r for r in results.values() if r.get('score') is not None and r['holdMinutes'] >= 480]
    shorts = [r for r in results.values() if r.get('score') is not None and r['holdMinutes'] <= 120]
    if len(longs) >= 3 and len(shorts) >= 3:
        al = sum(r['val']['best']['avgReturnPct'] for r in longs) / len(longs)
        ash = sum(r['val']['best']['avgReturnPct'] for r in shorts) / len(shorts)
        if abs(al - ash) > 0.15:
            lines.append(('Trades langer laten lopen' if al > ash else 'Snel winst pakken') +
                         f' werkt beter ({pct(max(al, ash))} tegen {pct(min(al, ash))} per trade).')
    lines.append(f"Ik heb nu {n_scored} {'strategie' if n_scored == 1 else 'strategieën'} beoordeeld; daarom eis ik minstens {pct(need)} per trade beter dan zomaar kopen "
                 "(hoe meer ik probeer, hoe groter de kans dat iets door geluk goed lijkt).")
    return ' '.join(lines)


def champion(r, auto):
    s = (f"Nieuwe beste strategie: {name(r)}. Beoordeling {pct(r['val']['best']['avgReturnPct'])}, "
         f"controle {pct((r.get('holdout') or {}).get('avgReturnPct'))} per trade.")
    s += (' Ik train er nu een model op; daarna neemt de bot hem over.' if auto else
          ' Je kunt hem overnemen met Toepassen in de ranglijst.')
    return s
