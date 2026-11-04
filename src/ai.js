// AI-veto: de AI mag een koopsignaal alleen goedkeuren of afwijzen.
// Positiegrootte, stop-loss en verkopen worden nooit door de AI bepaald.

const SYSTEM_PROMPT = `Je bent een risicofilter voor een crypto trading bot.
Een regelgebaseerde strategie wil een positie openen. Jij beoordeelt alleen of dit
moment verstandig lijkt, op basis van de meegegeven data. Je bepaalt geen bedragen.
Wees kritisch: bij twijfel wijs je af.
Antwoord uitsluitend met JSON in deze vorm:
{"decision": "approve" | "reject", "reason": "korte uitleg in het Nederlands"}`;

export function buildPrompt({ pair, timeframe, indicators, recentCandles, extra = {} }) {
  const n = (v, d = 2) => (v == null ? 'onbekend' : Number(v).toFixed(d));
  const candles = recentCandles
    .map((c) => `${new Date(c[0]).toISOString()} O:${c[1]} H:${c[2]} L:${c[3]} C:${c[4]} V:${c[5]}`)
    .join('\n');
  const btc = extra.btcTrend ? `${extra.btcTrend.up ? 'omhoog' : 'omlaag'} (koers ${n(extra.btcTrend.close, 0)} vs EMA50 ${n(extra.btcTrend.ema50, 0)})` : 'niet bekeken';
  const trades = extra.recentTrades?.length
    ? extra.recentTrades.map((t) => `${n(t.pnlPct)}% (${t.exit})`).join(', ')
    : 'nog geen trades in deze coin';
  return `Pair: ${pair}
Timeframe: ${timeframe}
Signaal: KOPEN (EMA-crossover omhoog)
Slotkoers: ${indicators.close}
EMA fast: ${n(indicators.emaFast, 4)}
EMA slow: ${n(indicators.emaSlow, 4)}
Trend-EMA (lang): ${indicators.emaTrend == null ? 'uit' : n(indicators.emaTrend, 4)}
RSI: ${n(indicators.rsi, 1)}
ADX (trendsterkte, <20 = zijwaarts): ${n(indicators.adx, 1)}
ATR (beweeglijkheid per candle): ${n(indicators.atrPct)}% van de koers
Volume laatste candle: ${indicators.volumeRatio == null ? 'onbekend' : `${n(indicators.volumeRatio, 1)}× het gemiddelde`}
Verandering laatste 24 candles: ${indicators.change24 == null ? 'onbekend' : n(indicators.change24) + '%'}
Bitcoin-trend: ${btc}
Laatste trades van deze bot in ${pair}: ${trades}

Laatste candles:
${candles}`;
}

export function parseDecision(text) {
  if (!text) throw new Error('Leeg antwoord van AI');
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Geen JSON in AI-antwoord');
  const obj = JSON.parse(match[0]);
  const decision = String(obj.decision || '').toLowerCase();
  if (!['approve', 'reject'].includes(decision)) throw new Error(`Ongeldige decision "${obj.decision}"`);
  return { decision, reason: String(obj.reason || '').slice(0, 500) };
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    if (!res.ok) {
      // Toon de foutmelding van de provider zelf, zonder de JSON eromheen.
      const body = await res.text();
      let message = body;
      try {
        const j = JSON.parse(body);
        message = j.error?.message ?? j.message ?? j.error ?? body;
      } catch {}
      throw new Error(`HTTP ${res.status}: ${String(message).slice(0, 500)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// system en json zijn optioneel, zodat dezelfde functies ook het dagoverzicht kunnen schrijven.
async function askGemini(cfg, prompt, { system = SYSTEM_PROMPT, json = true, temperature = 0.2 } = {}) {
  const model = cfg.model || defaultModel('gemini');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const data = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature, ...(json ? { responseMimeType: 'application/json' } : {}) },
      }),
    },
    cfg.timeoutMs,
  );
  return data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') ?? '';
}

async function askOpenAICompatible(cfg, prompt, { system = SYSTEM_PROMPT, json = true, temperature = 0.2 } = {}) {
  const model = cfg.model || defaultModel('openai');
  const call = (withJsonMode) => fetchWithTimeout(
    `${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model,
        temperature,
        ...(withJsonMode ? { response_format: { type: 'json_object' } } : {}),
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
      }),
    },
    cfg.timeoutMs,
  );
  try {
    const data = await call(json);
    return data?.choices?.[0]?.message?.content ?? '';
  } catch (err) {
    // Sommige (kleinere) modellen kunnen de strenge JSON-modus niet aan; Groq geeft dan
    // "Failed to generate JSON" of "json_validate_failed". Probeer het één keer zonder;
    // de JSON wordt dan uit de tekst gehaald.
    if (json && /HTTP 400/.test(err.message) && /json|response_format/i.test(err.message)) {
      const data = await call(false);
      return data?.choices?.[0]?.message?.content ?? '';
    }
    throw err;
  }
}

const SUMMARY_PROMPT = `Je schrijft het dagelijkse overzicht van een crypto trading bot voor de eigenaar.
Schrijf in het Nederlands, zakelijk en concreet, maximaal 120 woorden, zonder opsommingstekens of kopjes.
Behandel: hoe het de afgelopen 24 uur ging, wat opvalt in de markt voor de gevolgde coins, en of de
huidige instellingen passen bij wat je ziet (bijv. veel stop-losses, geen enkel signaal, veel AI-afwijzingen).
Verzin geen cijfers die niet in de data staan. Geef geen garanties en voorspel geen koersen.

Doe daarnaast, alleen als de data daar echt aanleiding toe geeft, een voorstel voor andere instellingen.
Je mag ALLEEN deze velden voorstellen: emaFast, emaSlow, rsiPeriod, rsiMaxEntry, trendEma (0 = uit), adxMin (0 = uit),
volumeMult (0 = uit), btcFilter (0 of 1), stopLossPct, takeProfitPct, trailingStopPct (0 = uit), atrStopMult (0 = uit), cooldownMinutes,
timeframe (een van 1m, 5m, 15m, 30m, 1h, 2h, 4h, 1d) en checkIntervalMinutes. Stel nooit bedragen voor.
Laat velden weg die je niet wilt veranderen. Geen goede reden? Laat "voorstel" dan leeg ({}).

Antwoord uitsluitend met JSON in deze vorm:
{"analyse": "de tekst van maximaal 120 woorden", "voorstel": {"veld": waarde}, "toelichting": "waarom, in 1 of 2 zinnen"}`;

// Schrijft de analyse en een eventueel voorstel voor het dagoverzicht.
// Gooit bij een fout; de aanroeper vangt dat op.
export async function writeSummary(cfg, data) {
  if (cfg.provider === 'none' || !cfg.apiKey) return null;
  const prompt = `Data van de bot (JSON):\n${JSON.stringify(data, null, 1)}`;
  const opts = { system: SUMMARY_PROMPT, json: true, temperature: 0.4 };
  const text = cfg.provider === 'gemini' ? await askGemini(cfg, prompt, opts) : await askOpenAICompatible(cfg, prompt, opts);
  return parseSummary(text);
}

export function parseSummary(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? raw);
    return {
      analysis: String(obj.analyse ?? obj.analysis ?? '').trim().slice(0, 1500) || null,
      suggestions: obj.voorstel && typeof obj.voorstel === 'object' ? obj.voorstel : {},
      rationale: String(obj.toelichting ?? '').trim().slice(0, 500) || null,
    };
  } catch {
    // Geen geldige JSON: gebruik de tekst als analyse, zonder voorstel.
    return { analysis: raw.slice(0, 1500), suggestions: {}, rationale: null };
  }
}

// Voor de testknop in het dashboard: dezelfde aanroep als een echte veto, maar
// fouten worden doorgegeven in plaats van opgevangen door de fail-mode.
export async function testConnection(cfg, context) {
  if (cfg.provider === 'none') throw new Error('Er is geen AI-provider gekozen');
  if (!cfg.apiKey) throw new Error('Er is geen AI-key ingesteld');
  const started = Date.now();
  const text = cfg.provider === 'gemini' ? await askGemini(cfg, buildPrompt(context)) : await askOpenAICompatible(cfg, buildPrompt(context));
  const ms = Date.now() - started;
  let parsed;
  try {
    parsed = parseDecision(text);
  } catch (err) {
    throw new Error(`De AI antwoordt, maar niet in het verwachte formaat (${err.message}). Antwoord: ${String(text).slice(0, 200)}`);
  }
  return { ...parsed, provider: cfg.provider, model: cfg.model || defaultModel(cfg.provider), ms };
}

// Standaardmodellen als je zelf niets kiest. Providers schrappen regelmatig oude modellen;
// met listModels() haal je in het dashboard de actuele lijst op.
export const defaultModel = (provider) => (provider === 'gemini' ? 'gemini-3.8-flash' : 'llama-3.3-70b-versatile');

// Haalt de modellen op die je key mag gebruiken.
export async function listModels(cfg) {
  if (cfg.provider === 'none') throw new Error('Er is geen AI-provider gekozen');
  if (!cfg.apiKey) throw new Error('Er is geen AI-key ingesteld');
  if (cfg.provider === 'gemini') {
    const data = await fetchWithTimeout(
      'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200',
      { headers: { 'x-goog-api-key': cfg.apiKey } },
      cfg.timeoutMs,
    );
    return (data.models ?? [])
      .filter((m) => (m.supportedGenerationMethods ?? []).includes('generateContent'))
      .map((m) => ({ id: m.name.replace(/^models\//, ''), label: m.displayName ?? m.name, context: m.inputTokenLimit ?? null }))
      .filter((m) => isTextModel(m.id))
      .sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }));
  }
  const data = await fetchWithTimeout(
    `${cfg.baseUrl.replace(/\/$/, '')}/models`,
    { headers: { Authorization: `Bearer ${cfg.apiKey}` } },
    cfg.timeoutMs,
  );
  return (data.data ?? [])
    .filter((m) => m.active !== false && isTextModel(m.id))
    .map((m) => ({
      id: m.id,
      label: m.name && m.name !== m.id ? m.name : m.id,
      context: m.context_window ?? m.context_length ?? null,
      // OpenRouter: modellen met ":free" of prijs 0 zijn gratis
      free: /:free$/.test(m.id) || (m.pricing && Number(m.pricing.prompt) === 0 && Number(m.pricing.completion) === 0) || undefined,
    }))
    .sort((a, b) => Number(Boolean(b.free)) - Number(Boolean(a.free)) || a.id.localeCompare(b.id));
}

// Modellen voor spraak, beeld, video, embeddings of moderatie kunnen geen veto geven.
export const isTextModel = (id) =>
  !/(embed|whisper|tts|audio|speech|transcri|imagen|image|veo|video|vision-only|aqa|guard|moderation|rerank|orpheus|playai|dall-e|sora|realtime|live)/i.test(id);

// ---------- AI-volgorde (back-ups) ----------
const hostOf = (u) => {
  try {
    return new URL(u).hostname.replace(/^api\./, '');
  } catch {
    return 'openai';
  }
};
export const aiLabel = (cfg) => `${cfg.provider === 'gemini' ? 'Gemini' : hostOf(cfg.baseUrl)} · ${cfg.model || defaultModel(cfg.provider)}`;
const callModel = (cfg, prompt, opts) => (cfg.provider === 'gemini' ? askGemini(cfg, prompt, opts) : askOpenAICompatible(cfg, prompt, opts));

// Probeert de modellen op volgorde. Gooit fn een fout (verbinding, quota, time-out,
// onleesbaar antwoord), dan volgt het volgende model. Lukt geen enkele, dan gooit runChain
// een fout met chainErrors: [{ slot, label, error }].
export async function runChain(chain, fn) {
  const errors = [];
  for (const cfg of chain) {
    if (!cfg.apiKey) {
      errors.push({ slot: cfg.slot, label: aiLabel(cfg), error: 'Geen API-key ingesteld' });
      continue;
    }
    try {
      return { result: await fn(cfg), cfg, errors };
    } catch (err) {
      errors.push({ slot: cfg.slot, label: aiLabel(cfg), error: err.message });
    }
  }
  const e = new Error(errors.map((x) => `${x.label}: ${x.error}`).join(' | ') || 'Geen AI ingesteld');
  e.chainErrors = errors;
  throw e;
}

// Veto via de volgorde. Een afwijzing is een geldig antwoord; alleen fouten gaan door naar het volgende model.
// Geeft altijd een beslissing terug en gooit nooit.
export async function askVetoChain(chain, failMode, context) {
  if (!chain.length) return { decision: 'approve', reason: 'Geen AI ingesteld, signaal automatisch goedgekeurd', provider: 'none' };
  const prompt = buildPrompt(context);
  try {
    const r = await runChain(chain, async (cfg) => parseDecision(await callModel(cfg, prompt)));
    return { ...r.result, provider: aiLabel(r.cfg), usedSlot: r.cfg.slot, fallbackErrors: r.errors };
  } catch (err) {
    const decision = failMode === 'approve' ? 'approve' : 'reject';
    return { decision, reason: `Alle AI-modellen faalden, fail-mode "${decision}"`, provider: 'geen', error: true, chainErrors: err.chainErrors ?? [] };
  }
}

export async function writeSummaryChain(chain, data) {
  if (!chain.length) return null;
  const r = await runChain(chain, async (cfg) => {
    const res = await writeSummary(cfg, data);
    if (!res?.analysis) throw new Error('Leeg antwoord');
    return res;
  });
  return { ...r.result, model: aiLabel(r.cfg), fallbackErrors: r.errors };
}

// Test elk model in de volgorde los, zodat je ziet welke werken.
export async function testChain(chain, context) {
  const out = [];
  for (const cfg of chain) {
    try {
      out.push({ slot: cfg.slot, label: aiLabel(cfg), ok: true, ...(await testConnection(cfg, context)) });
    } catch (err) {
      out.push({ slot: cfg.slot, label: aiLabel(cfg), ok: false, error: err.message });
    }
  }
  return out;
}

// Geeft altijd { decision, reason, provider, error? } terug en gooit nooit.
export async function askVeto(cfg, context) {
  if (cfg.provider === 'none') {
    return { decision: 'approve', reason: 'Geen AI ingesteld, signaal automatisch goedgekeurd', provider: 'none' };
  }
  if (!cfg.apiKey) {
    const decision = cfg.failMode === 'approve' ? 'approve' : 'reject';
    return { decision, reason: `Geen AI-key ingesteld in het dashboard, fail-mode "${decision}"`, provider: cfg.provider, error: true };
  }
  const prompt = buildPrompt(context);
  try {
    const text = cfg.provider === 'gemini' ? await askGemini(cfg, prompt) : await askOpenAICompatible(cfg, prompt);
    return { ...parseDecision(text), provider: cfg.provider };
  } catch (err) {
    const decision = cfg.failMode === 'approve' ? 'approve' : 'reject';
    return {
      decision,
      reason: `AI-fout, fail-mode "${decision}": ${err.message}`,
      provider: cfg.provider,
      error: true,
    };
  }
}
