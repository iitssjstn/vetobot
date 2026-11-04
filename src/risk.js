// Harde risicoregels voor nieuwe posities. Geeft een reden terug als het niet mag, anders null.

// extra: { pair, openPnlEur }. openPnlEur telt mee voor de daglimiet, zodat open
// verliezen niet ongemerkt boven de limiet uitkomen.
export function checkEntry(store, config, mode, exchange, liveBalance, extra = {}) {
  const { risk } = config;
  const s = store.state;

  if (s.halted) return `Handel gepauzeerd: ${s.halted.reason}`;
  if (mode === 'live' && !(exchange?.apiKey && exchange?.secret)) {
    return 'Bitvavo-keys ontbreken, vul ze in via het dashboard';
  }

  const open = Object.keys(s.positions).length;
  if (open >= risk.maxOpenTrades) return `Maximum van ${risk.maxOpenTrades} open trades bereikt`;

  const realized = store.realizedTodayEur();
  const openPnl = extra.openPnlEur ?? 0;
  const today = realized + Math.min(0, openPnl);
  if (risk.maxDailyLossEur > 0 && today <= -risk.maxDailyLossEur) {
    return openPnl < 0
      ? `Daglimiet: ${today.toFixed(2)} EUR (gesloten ${realized.toFixed(2)}, open ${openPnl.toFixed(2)})`
      : `Dagverlies ${today.toFixed(2)} EUR bereikt limiet`;
  }

  const lastExit = extra.pair ? s.lastExit?.[extra.pair] : null;
  if (risk.cooldownMinutes > 0 && lastExit) {
    const left = risk.cooldownMinutes * 60000 - (Date.now() - new Date(lastExit).getTime());
    if (left > 0) return `Afkoelperiode: nog ${Math.ceil(left / 60000)} min na de vorige verkoop`;
  }

  // Live budgetplafond: totale inzet van open posities plus deze trade mag er niet boven komen.
  if (mode === 'live' && risk.liveBudgetEur > 0) {
    const inUse = Object.values(s.positions).reduce((a, p) => a + (p.costEur ?? 0), 0);
    if (inUse + risk.stakeEur > risk.liveBudgetEur + 1e-9) {
      return `Budgetplafond: ${inUse.toFixed(2)} van ${risk.liveBudgetEur.toFixed(2)} EUR in gebruik, geen ruimte voor nog ${risk.stakeEur.toFixed(2)}`;
    }
  }
  if (mode === 'live' && liveBalance && liveBalance.eurFree < risk.stakeEur) {
    return `Bitvavo-saldo ${liveBalance.eurFree.toFixed(2)} EUR is lager dan de inzet`;
  }
  if (mode === 'paper' && s.balanceEur < risk.stakeEur) {
    return `Paper-saldo ${s.balanceEur.toFixed(2)} EUR is lager dan de inzet`;
  }
  return null;
}
