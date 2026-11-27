// Kleine statistiek voor "Leert hij echt?" (src/learncheck.js), zonder bibliotheken.
//
// Dezelfde rekenwijze als trainer/stats.py (de poortwachter en de proefperiode van de leerserver):
// - tQuantile: kwantiel van de t-verdeling. Startwaarde uit de Cornish-Fisher-reeks rond de normale
//   verdeling (exact voor 1 en 2 vrijheidsgraden), daarna Newton op de exacte verdelingsfunctie
//   (geregulariseerde onvolledige bètafunctie). De reeks alleen is bij weinig vrijheidsgraden te klein.
// - meanUpper: eenzijdige bovengrens van een gemiddelde.
// - welch: verschil in gemiddelde van twee groepen met ongelijke spreiding (Welch), met de eenzijdige
//   onder- en bovengrens.

const lgamma = (x) => {
  // Lanczos (g = 7, n = 9): nauwkeurig tot ~1e-15 voor x > 0.
  const g = 7;
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - lgamma(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
};

// Kettingbreuk van de onvolledige bètafunctie (Lentz).
function betacf(a, b, x) {
  const tiny = 1e-300;
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  d = 1 / (Math.abs(d) > tiny ? d : tiny);
  let h = d;
  for (let m = 1; m < 300; m++) {
    const m2 = 2 * m;
    for (const aa of [(m * (b - m) * x) / ((a + m2 - 1) * (a + m2)), (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1))]) {
      d = 1 + aa * d;
      d = 1 / (Math.abs(d) > tiny ? d : tiny);
      c = 1 + aa / c;
      c = Math.abs(c) > tiny ? c : tiny;
      h *= d * c;
    }
    if (Math.abs(d * c - 1) < 1e-15) break;
  }
  return h;
}

// Geregulariseerde onvolledige bètafunctie I_x(a, b).
export function ibeta(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lb = lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log1p(-x);
  if (x < (a + 1) / (a + b + 2)) return (Math.exp(lb) * betacf(a, b, x)) / a;
  return 1 - (Math.exp(lb) * betacf(b, a, 1 - x)) / b;
}

// P(T > t) voor t >= 0.
export function tTail(t, df) {
  return 0.5 * ibeta(df / 2, 0.5, df / (df + t * t));
}

// Kwantiel van de standaardnormale verdeling (Acklam, relatieve fout < 1,2e-9).
export function normInv(p) {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - lo) return -normInv(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

function tSeries(p, v) {
  if (v < 1.5) return Math.tan(Math.PI * (p - 0.5));
  if (v < 2.5) return (2 * p - 1) / Math.sqrt(2 * p * (1 - p));
  const z = normInv(p);
  const z2 = z * z;
  const g1 = ((z2 + 1) * z) / 4;
  const g2 = (((5 * z2 + 16) * z2 + 3) * z) / 96;
  const g3 = ((((3 * z2 + 19) * z2 + 17) * z2 - 15) * z) / 384;
  const g4 = (((((79 * z2 + 776) * z2 + 1482) * z2 - 1920) * z2 - 945) * z) / 92160;
  return z + g1 / v + g2 / v ** 2 + g3 / v ** 3 + g4 / v ** 4;
}

// Kwantiel p (0..1) van de t-verdeling met df vrijheidsgraden.
export function tQuantile(p, df) {
  p = Math.min(Math.max(p, 1e-12), 1 - 1e-12);
  if (df == null || !Number.isFinite(df) || df > 1e6) return normInv(p);
  if (p < 0.5) return -tQuantile(1 - p, df);
  const v = Math.max(Number(df), 1);
  if (v === 1 || v === 2) return tSeries(p, v);
  const q = 1 - p;
  let t = Math.max(tSeries(p, v), 0);
  const c = Math.exp(lgamma((v + 1) / 2) - lgamma(v / 2)) / Math.sqrt(v * Math.PI);
  for (let i = 0; i < 50; i++) {
    const pdf = c * (1 + (t * t) / v) ** (-(v + 1) / 2);
    if (pdf <= 0) break;
    const step = (tTail(t, v) - q) / pdf;
    t = Math.max(t + step, t / 2);
    if (Math.abs(step) < 1e-12 * Math.max(1, t)) break;
  }
  return t;
}

// Gemiddelde, standaardafwijking (n - 1) en aantal.
export function describe(xs) {
  const n = xs.length;
  if (!n) return { n: 0, mean: null, sd: null };
  const mean = xs.reduce((a, x) => a + x, 0) / n;
  const sd = n > 1 ? Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1)) : null;
  return { n, mean, sd };
}

// Eenzijdige bovengrens (betrouwbaarheid conf) van het gemiddelde van xs; null bij minder dan 2 waarden.
export function meanUpper(xs, conf = 0.95) {
  const { n, mean, sd } = describe(xs);
  if (n < 2) return { n, mean, sd, upper: null };
  return { n, mean, sd, upper: mean + (tQuantile(conf, n - 1) * sd) / Math.sqrt(n) };
}

// Welch: verschil gemiddelde(a) - gemiddelde(b), met eenzijdige onder- en bovengrens (elk met
// betrouwbaarheid conf). Bij minder dan 2 waarden in een groep: null.
export function welch(a, b, conf = 0.95) {
  const x = describe(a);
  const y = describe(b);
  if (x.n < 2 || y.n < 2) return null;
  const v1 = (x.sd * x.sd) / x.n;
  const v2 = (y.sd * y.sd) / y.n;
  const diff = x.mean - y.mean;
  const se = Math.sqrt(v1 + v2);
  if (se <= 1e-12) return { diff, se: 0, df: null, lower: diff, upper: diff, a: x, b: y };
  const den = (v1 * v1) / (x.n - 1) + (v2 * v2) / (y.n - 1);
  const df = den > 0 ? (v1 + v2) ** 2 / den : Math.max(x.n + y.n - 2, 1);
  const q = tQuantile(conf, df) * se;
  return { diff, se, df, lower: diff - q, upper: diff + q, a: x, b: y };
}
