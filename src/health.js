// Gezondheid van één bot: niet "draait hij?", maar "doet hij wat hij moet doen?".
// Op basis van tijdstempels (laatste geslaagde check, positiecontrole, contact met Bitvavo) bepaalt
// assess() de toestand: healthy (groen), degraded (oranje), critical (rood), paused of stopped.
// alerts() maakt daar meldingen van: kritiek direct, een probleem pas als het een paar minuten
// aanhoudt, opnieuw als het erger wordt of lang blijft duren, en één melding als het opgelost is.
// Dit bestand doet zelf niets met orders: alleen meten, beoordelen en melden.

export const HEALTH = {
  hangMinMs: 5 * 60000,        // een check die langer duurt dan max(dit, 3 × het interval) hangt
  staleFactor: 3,              // geen check meer na 3 × het interval (+ 5 min) = de planner loopt niet
  staleExtraMs: 5 * 60000,
  positionStaleMinMs: 2 * 60000, // een open positie die zo lang niet gecontroleerd is, is onbewaakt
  exchangeStaleMs: 10 * 60000,   // live: zo lang geen geslaagd contact met Bitvavo
  errorsDegraded: 3,           // zoveel checks op rij met fouten: probleem
  errorsCritical: 10,          // ... kritiek
  degradedAfterMs: 5 * 60000,  // een probleem pas melden als het zo lang aanhoudt (geen gefladder)
  renotifyCriticalMs: 60 * 60000,
  renotifyDegradedMs: 6 * 60 * 60000,
  startupGraceMs: 60000,
};

const RANK = { healthy: 0, paused: 1, degraded: 2, critical: 3, stopped: 4 };
const worst = (a, b) => (RANK[b] > RANK[a] ? b : a);
const iso = (t) => (t ? new Date(t).toISOString() : null);
const ago = (ms) => {
  const m = Math.round(ms / 60000);
  return m < 1 ? `${Math.round(ms / 1000)} sec` : m < 120 ? `${m} min` : `${Math.round(m / 60)} uur`;
};

export class Health {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.startedAt = now();
    this.s = {
      tickStartedAt: null, tickOkAt: null, tickEndAt: null, consecutiveTickErrors: 0,
      watchOkAt: null, consecutiveWatchErrors: 0,
      exchangeOkAt: null, exchangeErrorAt: null, consecutiveExchangeErrors: 0,
      lastError: null, lastRecovery: null, positions: {},
    };
    this.open = new Map(); // probleem-sleutel → { level, since, notifiedAt, notifiedLevel, title }
    this.notifyFailure = null;
  }

  // ---------- Metingen (de bot roept dit aan) ----------
  tickStarted() { this.s.tickStartedAt = this.now(); }

  tickFinished(errors = 0, firstError = null) {
    const t = this.now();
    this.s.tickEndAt = t;
    this.s.tickStartedAt = null;
    if (errors) {
      this.s.consecutiveTickErrors++;
      if (firstError) this.error('check', firstError);
    } else {
      this.s.consecutiveTickErrors = 0;
      this.s.tickOkAt = t;
    }
  }

  tickFailed(err) {
    this.s.tickEndAt = this.now();
    this.s.tickStartedAt = null;
    this.s.consecutiveTickErrors++;
    this.error('check', err);
  }

  positionChecked(pair) {
    this.s.positions[pair] = { ...(this.s.positions[pair] ?? {}), okAt: this.now(), errors: 0, error: null };
  }

  positionFailed(pair, err) {
    const p = (this.s.positions[pair] ??= { okAt: null, errors: 0 });
    p.errors++;
    p.error = msg(err);
    p.errorAt = this.now();
  }

  watchFinished(failed = 0, firstError = null) {
    if (failed) {
      this.s.consecutiveWatchErrors++;
      if (firstError) this.error('positiebewaking', firstError);
    } else {
      this.s.consecutiveWatchErrors = 0;
      this.s.watchOkAt = this.now();
    }
  }

  exchangeOk() {
    this.s.exchangeOkAt = this.now();
    this.s.consecutiveExchangeErrors = 0;
  }

  exchangeFailed(err) {
    this.s.exchangeErrorAt = this.now();
    this.s.consecutiveExchangeErrors++;
    this.error('Bitvavo', err);
  }

  error(where, err) {
    this.s.lastError = { at: iso(this.now()), where, message: msg(err) };
  }

  recovered(what) {
    this.s.lastRecovery = { at: iso(this.now()), what };
  }

  // ---------- Beoordelen ----------
  // ctx: { mode, intervalMs, watchSeconds, running, scheduled, halted, openPositions: [{pair, live, stop}],
  //        buyBlock, uncleanRestart }
  assess(ctx) {
    const now = this.now();
    const s = this.s;
    const problems = [];
    const add = (key, level, title, detail, extra = {}) => problems.push({ key, level, title, detail, ...extra });
    const interval = Math.max(10000, ctx.intervalMs ?? 60000);
    const live = ctx.mode === 'live';
    const openLive = (ctx.openPositions ?? []).filter((p) => p.live);
    const lastEnd = s.tickEndAt ?? null;

    if (ctx.scheduled === false) {
      return this.#result('stopped', [{ key: 'stopped', level: 'stopped', title: 'Bot gestopt', detail: 'De planner van deze bot draait niet (uitgeschakeld of gestopt).' }], ctx);
    }
    // 1. Hangt de check?
    const hangMs = Math.max(HEALTH.hangMinMs, interval * 3);
    if (ctx.running && s.tickStartedAt && now - s.tickStartedAt > hangMs) {
      add('loop-hang', 'critical', 'De handelsronde hangt',
        `De huidige check loopt al ${ago(now - s.tickStartedAt)} (normaal hooguit ${ago(hangMs)}). Zolang die hangt, draait er geen nieuwe check en ook de snelle positiebewaking niet.`,
        { affected: 'handelsronde, positiebewaking, nieuwe aankopen', auto: 'Nieuwe checks wachten; de bot breekt een lopende order niet af (dat kan dubbele orders geven).', manual: true });
    }
    // 2. Loopt de planner nog? (geen check meer, terwijl er ook geen hangt)
    const staleMs = interval * HEALTH.staleFactor + HEALTH.staleExtraMs;
    const since = lastEnd ?? this.startedAt;
    if (!ctx.running && now - since > staleMs) {
      add('scheduler', 'critical', 'Er draaien geen checks meer',
        `De laatste check eindigde ${lastEnd ? `${ago(now - lastEnd)} geleden` : 'nog nooit sinds de start'} (verwacht elke ${ago(interval)}).`,
        { affected: 'handelsronde, positiebewaking', auto: 'De planner wordt opnieuw gestart.', manual: false });
    }
    // 3. Fouten op rij in de check.
    if (s.consecutiveTickErrors >= HEALTH.errorsDegraded) {
      add('tick-errors', s.consecutiveTickErrors >= HEALTH.errorsCritical ? 'critical' : 'degraded', 'Checks geven steeds fouten',
        `${s.consecutiveTickErrors} checks op rij met fouten. Laatste: ${s.lastError ? `${s.lastError.where}: ${s.lastError.message}` : 'onbekend'}.`,
        { affected: 'handelsronde', auto: 'Elke check probeert het opnieuw.', manual: s.consecutiveTickErrors >= HEALTH.errorsCritical });
    }
    // 4. Worden de open posities nog gecontroleerd?
    const posStale = Math.max(HEALTH.positionStaleMinMs, interval * 3, (Number(ctx.watchSeconds) || 0) * 3000);
    const unwatched = (ctx.openPositions ?? []).filter((p) => {
      const ok = s.positions[p.pair]?.okAt ?? null;
      return now - (ok ?? Math.max(this.startedAt, p.openedAt ?? 0)) > posStale;
    });
    if (unwatched.length) {
      const liveOnes = unwatched.filter((p) => p.live);
      const protectedCount = liveOnes.filter((p) => p.stop === 'actief').length;
      add('positions', liveOnes.length ? 'critical' : 'degraded', 'Open posities worden niet bewaakt',
        `${unwatched.map((p) => p.pair).join(', ')}: al meer dan ${ago(posStale)} geen geslaagde koerscontrole.` +
        (liveOnes.length ? ` Stop bij Bitvavo actief voor ${protectedCount} van ${liveOnes.length} live positie(s).` : '') +
        (unwatched.map((p) => s.positions[p.pair]?.error).filter(Boolean)[0] ? ` Laatste fout: ${unwatched.map((p) => s.positions[p.pair]?.error).filter(Boolean)[0]}.` : ''),
        { affected: 'positiebewaking (stop-loss, take-profit, trailing stop door de bot)', auto: 'Elke check en elke bewakingsronde probeert het opnieuw.',
          manual: liveOnes.length > protectedCount });
    }
    // 5. Contact met Bitvavo (live).
    if (live && s.consecutiveExchangeErrors > 0 && now - (s.exchangeOkAt ?? this.startedAt) > HEALTH.exchangeStaleMs) {
      add('exchange', openLive.length ? 'critical' : 'degraded', 'Bitvavo niet bereikbaar',
        `Al ${ago(now - (s.exchangeOkAt ?? this.startedAt))} geen geslaagd contact met Bitvavo (${s.consecutiveExchangeErrors} fouten op rij).`,
        { affected: 'saldo, orders, koersen', auto: 'Nieuwe aankopen staan stil; elke check en bewakingsronde probeert opnieuw.', manual: false });
    }
    // 6. Live posities zonder bevestigde stop bij Bitvavo.
    const noStop = openLive.filter((p) => p.stop === 'mislukt');
    if (noStop.length) {
      add('stops', 'critical', 'Stop-loss bij Bitvavo niet bevestigd',
        `${noStop.map((p) => p.pair).join(', ')}: de stop-order bij Bitvavo is mislukt of onbekend. De bot bewaakt de noodstop zelf, maar alleen zolang hij draait.`,
        { affected: 'bescherming bij uitval', auto: 'De bot zet de stop elke 10 minuten opnieuw; nieuwe aankopen staan stil.', manual: false });
    }
    // 7. Nieuwe aankopen geblokkeerd (veilige toestand), meldingen die niet aankomen, gepauzeerd.
    if (ctx.buyBlock?.blocked) {
      add('buy-block', 'degraded', 'Nieuwe aankopen staan stil', (ctx.buyBlock.reasons ?? []).join('; '),
        { affected: 'nieuwe aankopen', auto: 'Wordt vanzelf opgeheven als de situatie weer betrouwbaar is.', manual: false });
    }
    if (this.notifyFailure && now - this.notifyFailure.at < 60 * 60000) {
      add('notify', 'degraded', 'Discord-meldingen komen niet aan', this.notifyFailure.error,
        { affected: 'meldingen', auto: 'Kritieke meldingen worden nog een paar keer opnieuw geprobeerd.', manual: true, silent: true });
    }
    if (ctx.halted) add('paused', 'paused', 'Handel gepauzeerd', String(ctx.halted.reason ?? ''), { silent: true });
    // Opstarten: de eerste check moet nog komen.
    if (!lastEnd && !ctx.running && now - this.startedAt < interval + HEALTH.startupGraceMs) {
      const i = problems.findIndex((p) => p.key === 'scheduler');
      if (i >= 0) problems.splice(i, 1);
    }
    const level = problems.reduce((l, p) => worst(l, p.level), 'healthy');
    return this.#result(level, problems, ctx);
  }

  #result(level, problems, ctx) {
    const s = this.s;
    const posTimes = (ctx.openPositions ?? []).map((p) => s.positions[p.pair]?.okAt).filter(Boolean);
    return {
      level, problems,
      emoji: { healthy: '🟢', degraded: '🟠', critical: '🔴', paused: '🟡', stopped: '⚪' }[level],
      label: { healthy: 'Gezond', degraded: 'Met problemen', critical: 'Kritiek', paused: 'Gepauzeerd', stopped: 'Gestopt' }[level],
      lastTickOkAt: iso(s.tickOkAt), lastTickEndAt: iso(s.tickEndAt), tickRunningSince: iso(s.tickStartedAt),
      lastWatchOkAt: iso(s.watchOkAt), lastPositionCheckAt: posTimes.length ? iso(Math.min(...posTimes)) : null,
      lastExchangeOkAt: iso(s.exchangeOkAt), lastError: s.lastError, lastRecovery: s.lastRecovery,
      consecutiveErrors: s.consecutiveTickErrors, consecutiveExchangeErrors: s.consecutiveExchangeErrors,
      openLivePositions: (ctx.openPositions ?? []).filter((p) => p.live).length,
      positionsWatched: !problems.some((p) => p.key === 'positions' || p.key === 'loop-hang'),
      liveTrading: ctx.mode === 'live' && !problems.some((p) => ['loop-hang', 'scheduler', 'stopped'].includes(p.key)) && !ctx.buyBlock?.blocked && !ctx.halted,
      startedAt: iso(this.startedAt), uncleanRestart: ctx.uncleanRestart ?? null,
    };
  }

  // ---------- Meldingen ----------
  // Geeft de meldingen die nu verstuurd moeten worden (en onthoudt dat). Nieuwe kritieke problemen
  // direct; een probleem pas na degradedAfterMs; opnieuw als het erger wordt of lang aanhoudt;
  // en één melding "opgelost" als een gemeld probleem weg is.
  alerts(result) {
    const now = this.now();
    const out = [];
    const seen = new Set();
    for (const p of result.problems) {
      if (p.silent || p.level === 'paused' || p.level === 'stopped') continue;
      seen.add(p.key);
      const o = this.open.get(p.key) ?? { since: now, notifiedAt: null, notifiedLevel: null };
      o.level = p.level;
      o.title = p.title;
      this.open.set(p.key, o);
      const due = p.level === 'critical' || now - o.since >= HEALTH.degradedAfterMs;
      const worse = o.notifiedLevel && RANK[p.level] > RANK[o.notifiedLevel];
      const again = o.notifiedAt && now - o.notifiedAt >= (p.level === 'critical' ? HEALTH.renotifyCriticalMs : HEALTH.renotifyDegradedMs);
      if (due && (!o.notifiedAt || worse || again)) {
        o.notifiedAt = now;
        o.notifiedLevel = p.level;
        out.push({ kind: 'problem', problem: p, result, repeat: Boolean(again && !worse), since: o.since });
      }
    }
    for (const [key, o] of this.open) {
      if (seen.has(key)) continue;
      this.open.delete(key);
      if (o.notifiedAt) out.push({ kind: 'resolved', key, title: o.title, since: o.since, result });
    }
    return out;
  }

  // Een Discord-melding die niet aankwam (zichtbaar op het dashboard).
  notifyFailed(error) { this.notifyFailure = { at: this.now(), error: msg(error) }; }
  notifyOk() { this.notifyFailure = null; }
}

// Tekst van een melding: wat, wat getroffen is, of live trading nog loopt, of posities bewaakt
// worden, wat de bot zelf deed en of jij iets moet doen.
export function alertMessage(a, { now = Date.now() } = {}) {
  const r = a.result;
  if (a.kind === 'resolved') {
    return {
      title: `🟢 Opgelost: ${a.title}`,
      message: `Het probleem is weg (duurde ${ago(now - a.since)}). Status nu: ${r.emoji} ${r.label}.`,
      level: 'ok',
      fields: [{ name: 'Posities bewaakt', value: r.positionsWatched ? 'ja' : 'nee' }],
    };
  }
  const p = a.problem;
  return {
    title: `${p.level === 'critical' ? '🔴 Kritiek' : '🟠 Probleem'}: ${p.title}${a.repeat ? ' (houdt aan)' : ''}`,
    message: p.detail,
    level: p.level === 'critical' ? 'error' : 'warn',
    fields: [
      { name: 'Getroffen', value: p.affected ?? '–', inline: false },
      { name: 'Live trading actief', value: r.liveTrading ? 'ja' : 'nee' },
      { name: 'Open posities bewaakt', value: r.openLivePositions ? (r.positionsWatched ? 'ja' : 'NEE') : 'geen live posities' },
      { name: 'Wat de bot deed', value: p.auto ?? '–', inline: false },
      { name: 'Actie nodig', value: p.manual ? 'ja, kijk op het dashboard' : 'nee, de bot probeert het zelf' },
    ],
  };
}

function msg(err) {
  return String(err?.message ?? err ?? 'onbekende fout').slice(0, 300);
}
