"""Kleine telling voor het blok "Leert hij echt?" van de bot (GET /learnstats).

Twee dingen die de bot nergens anders kan zien:
  - hoeveel leerrondes er de laatste 24 uur waren (uit het modelregister: elke ronde is een sessie,
    terugzettingen tellen niet mee), en wanneer de laatste was;
  - wanneer de leerserver voor het laatst trades van de AI-trader ontving, en hoeveel in de laatste
    3 dagen (uit agent_trades.json: 'at' is het moment van ontvangen).
Alle tijden worden hier met de klok van de leerserver vergeleken (de tijdstempels in het register en
in agent_trades.json zijn lokale tijd van de leerserver), zodat een andere tijdzone bij de bot niet
uitmaakt: de bot krijgt leeftijden in uren. Alleen lezen; verandert niets aan leren of promoveren.
"""
from datetime import datetime

import probation as probation_mod

ROUND_WINDOW_H = 24
TRADE_WINDOW_D = 3


def _age_h(ts, now_ts):
    return None if ts is None else round(max(0.0, now_ts - ts) / 3600, 2)


def compute(versions, agent_trades, enabled, learning_now, now_ts):
    """versions: register-sessies (registry.versions), agent_trades: rijen uit agent_trades.json.
    Geeft {'now', 'enabled', 'learningNow', 'rounds': {...}, 'agentTrades': {...}}."""
    rounds = [probation_mod.ts_of(v.get('at')) for v in versions or [] if isinstance(v, dict) and v.get('decision') != 'rollback']
    rounds = [t for t in rounds if t is not None]
    last_round = max(rounds) if rounds else None
    recv = []
    for t in agent_trades or []:
        if not isinstance(t, dict):
            continue
        ts = probation_mod.ts_of(t.get('at'))
        if ts is not None:
            recv.append((ts, bool(t.get('explore') or t.get('virtual'))))
    last_recv = max((ts for ts, _ in recv), default=None)
    since = now_ts - TRADE_WINDOW_D * 86400
    return {
        'now': datetime.fromtimestamp(now_ts).isoformat(timespec='seconds'),
        'enabled': bool(enabled), 'learningNow': bool(learning_now),
        'rounds': {'windowHours': ROUND_WINDOW_H, 'lastDay': sum(1 for t in rounds if t > now_ts - ROUND_WINDOW_H * 3600),
                   'lastAt': None if last_round is None else datetime.fromtimestamp(last_round).isoformat(timespec='seconds'),
                   'ageHours': _age_h(last_round, now_ts)},
        'agentTrades': {'windowDays': TRADE_WINDOW_D, 'total': len(recv),
                        'recent': sum(1 for ts, _ in recv if ts > since),
                        'recentReal': sum(1 for ts, ex in recv if ts > since and not ex),
                        'lastAt': None if last_recv is None else datetime.fromtimestamp(last_recv).isoformat(timespec='seconds'),
                        'ageHours': _age_h(last_recv, now_ts)},
    }
