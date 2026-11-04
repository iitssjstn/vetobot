// AI-veto: de AI mag een koopsignaal alleen goedkeuren of afwijzen.
// Positiegrootte, stop-loss en verkopen worden nooit door de AI bepaald.

const SYSTEM_PROMPT = `Je bent een risicofilter voor een crypto trading bot.
Een regelgebaseerde strategie wil een positie openen. Jij beoordeelt alleen of dit
moment verstandig lijkt, op basis van de meegegeven data. Je bepaalt geen bedragen.
Wees kritisch: bij twijfel wijs je af.
Antwoord uitsluitend met JSON in deze vorm:
{"decision": "approve" | "reject", "reason": "korte uitleg in het Nederlands"}`;

export function buildPrompt({ pair, timeframe, indicators, recentCandles }) {
  const candles = recentCandles
    .map((c) => `${new Date(c[0]).toISOString()} O:${c[1]} H:${c[2]} L:${c[3]} C:${c[4]} V:${c[5]}`)
    .join('\n');
  return `Pair: ${pair}
Timeframe: ${timeframe}
Signaal: KOPEN (EMA-crossover omhoog)
Slotkoers: ${indicators.close}
EMA fast: ${indicators.emaFast.toFixed(4)}
EMA slow: ${indicators.emaSlow.toFixed(4)}
RSI: ${indicators.rsi.toFixed(1)}
Verandering laatste 24 candles: ${indicators.change24 == null ? 'onbekend' : indicators.change24.toFixed(2) + '%'}

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
  const data = await fetchWithTimeout(
    `${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model,
        temperature,
        ...(json ? { response_format: { type: 'json_object' } } : {}),
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
      }),
    },
    cfg.timeoutMs,
  );
  return data?.choices?.[0]?.message?.content ?? '';
}

const SUMMARY_PROMPT = `Je schrijft het dagelijkse overzicht van een crypto trading bot voor de eigenaar.
Schrijf in het Nederlands, zakelijk en concreet, maximaal 120 woorden, zonder opsommingstekens of kopjes.
Behandel: hoe het de afgelopen 24 uur ging, wat opvalt in de markt voor de gevolgde coins, en of de
huidige instellingen passen bij wat je ziet (bijv. veel stop-losses, geen enkel signaal, veel AI-afwijzingen).
Verzin geen cijfers die niet in de data staan. Geef geen garanties en voorspel geen koersen.`;

// Schrijft de korte analyse voor het dagoverzicht. Gooit bij een fout; de aanroeper vangt dat op.
export async function writeSummary(cfg, data) {
  if (cfg.provider === 'none' || !cfg.apiKey) return null;
  const prompt = `Data van de bot (JSON):\n${JSON.stringify(data, null, 1)}`;
  const opts = { system: SUMMARY_PROMPT, json: false, temperature: 0.4 };
  const text = cfg.provider === 'gemini' ? await askGemini(cfg, prompt, opts) : await askOpenAICompatible(cfg, prompt, opts);
  return String(text ?? '').trim().slice(0, 1500) || null;
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
      .map((m) => ({ id: m.name.replace(/^models\//, ''), label: m.displayName ?? m.name }))
      .sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }));
  }
  const data = await fetchWithTimeout(
    `${cfg.baseUrl.replace(/\/$/, '')}/models`,
    { headers: { Authorization: `Bearer ${cfg.apiKey}` } },
    cfg.timeoutMs,
  );
  return (data.data ?? []).map((m) => ({ id: m.id, label: m.id })).sort((a, b) => a.id.localeCompare(b.id));
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
