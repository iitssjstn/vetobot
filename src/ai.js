// AI-veto: de AI mag een koopsignaal alleen goedkeuren of afwijzen.
// Positiegrootte en stops worden nooit door de AI bepaald. Optioneel mag de AI bij een
// positie in de winst adviseren om eerder te verkopen (winst nemen), zie askExitChain.

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

// Haalt het JSON-object uit een AI-antwoord. Robuust voor:
// - "denkende" modellen (Qwen, DeepSeek, ...) die eerst <think>...</think> schrijven,
// - tekst of ```json-blokken rond de JSON,
// - accolades in de uitleg vóór de JSON.
// Probeert van achter naar voren elk { tot de bijpassende }, en neemt het laatste geldige object.
export function extractJson(text) {
  let t = String(text ?? '');
  t = t.replace(/<think>[\s\S]*?<\/think>/gi, '');
  // Afgebroken denkblok zonder </think>: alles tot en met <think> weg.
  if (/<think>/i.test(t)) t = t.slice(t.toLowerCase().lastIndexOf('<think>') + 7);
  t = t.trim();
  try {
    const whole = JSON.parse(t);
    if (whole && typeof whole === 'object') return whole;
  } catch {}
  for (let start = t.lastIndexOf('{'); start >= 0; start = t.lastIndexOf('{', start - 1)) {
    let depth = 0;
    let inStr = false;
    for (let i = start; i < t.length; i++) {
      const c = t[i];
      if (inStr) {
        if (c === '\\') i++;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        try {
          const obj = JSON.parse(t.slice(start, i + 1));
          // Alleen het buitenste object met de velden die we zoeken telt; een los { } in de tekst niet.
          if (obj && typeof obj === 'object' && ('decision' in obj || 'analyse' in obj || 'analysis' in obj)) return obj;
        } catch {}
        break;
      }
      if (start === 0 && i === t.length - 1) break;
    }
    if (start === 0) break;
  }
  return null;
}

export function parseDecision(text) {
  if (!text) throw new Error('Leeg antwoord van AI');
  const obj = extractJson(text);
  if (!obj) throw new Error(`Geen JSON in AI-antwoord: "${String(text).replace(/\s+/g, ' ').slice(0, 120)}"`);
  const decision = String(obj.decision || '').toLowerCase();
  if (!['approve', 'reject'].includes(decision)) throw new Error(`Ongeldige decision "${obj.decision}"`);
  return { decision, reason: String(obj.reason || '').slice(0, 500) };
}

// Hoe lang een provider vraagt te wachten na een rate limit (HTTP 429), in ms, of null.
// Groq: "Please try again in 3.67s" / "in 450ms"; Gemini: "retry in 3.2s" / "retryDelay": "3s";
// of de standaard Retry-After-header (seconden).
export function retryAfterMs(message, header) {
  const h = Number(header);
  if (header != null && header !== '' && Number.isFinite(h)) return h * 1000;
  const m = String(message).match(/(?:try again|retry)(?: in)?[^0-9]{0,12}([\d.]+)\s*(ms|s)\b/i) ?? String(message).match(/retryDelay"?:\s*"([\d.]+)(s)"/i);
  if (!m) return null;
  return Number(m[1]) * (m[2].toLowerCase() === 'ms' ? 1 : 1000);
}

// Bij een rate limit met een korte wachttijd eerst even wachten en het opnieuw proberen,
// in plaats van meteen naar het back-upmodel te gaan. Langer dan 20 seconden wachten
// heeft geen zin; dan neemt het back-upmodel het over.
const MAX_RATE_WAIT_MS = 20000;
export const rateLimit = { sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

async function fetchWithTimeout(url, options, timeoutMs, attempt = 0) {
  try {
    return await fetchOnce(url, options, timeoutMs);
  } catch (err) {
    if (err.status === 429 && attempt < 2) {
      const wait = retryAfterMs(err.message, err.retryAfter);
      if (wait != null && wait <= MAX_RATE_WAIT_MS) {
        await rateLimit.sleep(wait + 250);
        return fetchWithTimeout(url, options, timeoutMs, attempt + 1);
      }
    }
    throw err;
  }
}

async function fetchOnce(url, options, timeoutMs) {
  const ctrl = new AbortController();
  // Zonder ingestelde time-out niet meteen afbreken, maar na 30 seconden.
  const t = setTimeout(() => ctrl.abort(), timeoutMs > 0 ? timeoutMs : 30000);
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
      throw Object.assign(new Error(`HTTP ${res.status}: ${String(message).slice(0, 500)}`), {
        status: res.status, retryAfter: res.headers.get('retry-after'),
      });
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
    const obj = extractJson(raw);
    if (!obj) throw new Error('geen JSON');
    return {
      analysis: String(obj.analyse ?? obj.analysis ?? '').trim().slice(0, 1500) || null,
      suggestions: obj.voorstel && typeof obj.voorstel === 'object' ? obj.voorstel : {},
      rationale: String(obj.toelichting ?? '').trim().slice(0, 500) || null,
    };
  } catch {
    // Geen geldige JSON: gebruik de tekst als analyse, zonder voorstel.
    const clean = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    return { analysis: clean.slice(0, 1500) || null, suggestions: {}, rationale: null };
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

// ---------- Winst nemen ----------
// Bij een open positie in de winst mag de AI adviseren om nu te verkopen. Hij kan alleen
// eerder verkopen dan de regels; stop-loss en trailing stop blijven altijd gelden.
const EXIT_PROMPT = `Je bewaakt een open positie van een crypto trading bot. De positie staat in de winst.
Beslis of de bot de winst NU moet nemen (verkopen) of nog even moet vasthouden.
Verkoop als het momentum afneemt, de koers terugvalt vanaf de top, de RSI oververhit raakt,
het volume opdroogt of de korte trend keert. Houd alleen vast als de stijging duidelijk doorzet.
Bij twijfel neem je de winst: een zekere kleine winst is beter dan een winst die verdampt.
Antwoord uitsluitend met JSON in deze vorm:
{"decision": "sell" | "hold", "reason": "korte uitleg in het Nederlands"}`;

export function buildExitPrompt({ pair, timeframe, position, price, indicators, recentCandles, feePct = 0.25 }) {
  const n = (v, d = 2) => (v == null ? 'onbekend' : Number(v).toFixed(d));
  const change = ((price - position.entryPrice) / position.entryPrice) * 100;
  const top = position.highest ?? position.entryPrice;
  const minutes = position.openedAt ? Math.round((Date.now() - Date.parse(position.openedAt)) / 60000) : null;
  const candles = (recentCandles ?? []).map((c) => `${new Date(c[0]).toISOString()} O:${c[1]} H:${c[2]} L:${c[3]} C:${c[4]} V:${c[5]}`).join('\n');
  return `Pair: ${pair}
Timeframe: ${timeframe}
Instapkoers: ${position.entryPrice}
Huidige koers: ${price}
Resultaat nu: ${n(change)}% (na fees ongeveer ${n(change - 2 * feePct)}%)
Hoogste koers sinds aankoop: ${top} (nu ${n(((price - top) / top) * 100)}% daaronder)
Positie open sinds: ${minutes == null ? 'onbekend' : `${minutes} minuten`}
RSI: ${n(indicators?.rsi, 1)}
EMA fast / slow: ${n(indicators?.emaFast, 4)} / ${n(indicators?.emaSlow, 4)} (${indicators && indicators.emaFast > indicators.emaSlow ? 'trend omhoog' : 'trend omlaag'})
ADX: ${n(indicators?.adx, 1)}
Volume laatste candle: ${indicators?.volumeRatio == null ? 'onbekend' : `${n(indicators.volumeRatio, 1)}× het gemiddelde`}

Laatste candles (de laatste loopt nog):
${candles}`;
}

export function parseExit(text) {
  if (!text) throw new Error('Leeg antwoord van AI');
  const obj = extractJson(text);
  if (!obj) throw new Error(`Geen JSON in AI-antwoord: "${String(text).replace(/\s+/g, ' ').slice(0, 120)}"`);
  const decision = String(obj.decision || '').toLowerCase();
  if (!['sell', 'hold'].includes(decision)) throw new Error(`Ongeldige decision "${obj.decision}"`);
  return { decision, reason: String(obj.reason || '').slice(0, 500) };
}

// Gooit nooit. Lukt geen enkel model, dan "hold" met error: true (de regels blijven gelden).
export async function askExitChain(chain, context) {
  if (!chain.length) return { decision: 'hold', reason: 'Geen AI ingesteld', provider: 'none', error: true };
  const prompt = buildExitPrompt(context);
  try {
    const r = await runChain(chain, async (cfg) => parseExit(await callModel(cfg, prompt, { system: EXIT_PROMPT })));
    return { ...r.result, provider: aiLabel(r.cfg), usedSlot: r.cfg.slot, fallbackErrors: r.errors };
  } catch (err) {
    return { decision: 'hold', reason: `Alle AI-modellen faalden: ${err.message}`, provider: 'geen', error: true, chainErrors: err.chainErrors ?? [] };
  }
}

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
