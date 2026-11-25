// Statische regressiechecks: Dockerfiles kopiëren alles wat nodig is, de CI draait de tests.
// Alleen tekstcontroles op de bestanden in de repository; er wordt niets gebouwd.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const lines = (text) => text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

test('Dockerfile (bot): kopieert package.json, src/ en public/, start src/index.js, healthcheck op /healthz', () => {
  const df = lines(read('Dockerfile'));
  assert.ok(df.some((l) => /^COPY package\*?\.json/.test(l)), 'package.json');
  assert.ok(df.some((l) => /^RUN npm (install|ci)\b.*--omit=dev/.test(l)), 'productie-dependencies');
  assert.ok(df.includes('COPY src ./src'), 'src/');
  assert.ok(df.includes('COPY public ./public'), 'public/');
  assert.ok(df.some((l) => /^CMD \["node", "src\/index\.js"\]/.test(l)));
  assert.ok(df.some((l) => /^USER node/.test(l)), 'niet als root');
  assert.match(read('Dockerfile'), /\/healthz/);
  assert.match(read('src/server.js'), /app\.get\('\/healthz'/, 'het healthcheck-endpoint bestaat');
  // .dockerignore mag src/, public/ en package.json niet uitsluiten.
  const ignore = lines(read('.dockerignore'));
  for (const p of ['src', 'public', 'package.json', '*.js', 'src/*']) assert.equal(ignore.includes(p), false, `.dockerignore sluit ${p} uit`);
});

test('bot: elke import in src/ wijst naar een bestand in src/, een dependency of een ingebouwde module', () => {
  const deps = new Set(Object.keys(JSON.parse(read('package.json')).dependencies ?? {}));
  const builtins = new Set(builtinModules);
  const files = fs.readdirSync(path.join(root, 'src')).filter((f) => f.endsWith('.js'));
  assert.ok(files.includes('index.js'));
  for (const f of files) {
    const text = read(`src/${f}`);
    const specs = [...text.matchAll(/(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1] ?? m[2]);
    for (const s of specs) {
      if (s.startsWith('.')) {
        const target = path.normalize(path.join('src', s));
        assert.ok(target.startsWith('src'), `${f} importeert ${s} buiten src/ (niet in de image)`);
        assert.ok(fs.existsSync(path.join(root, target)), `${f}: ${s} bestaat niet`);
      } else {
        const name = s.startsWith('node:') ? s.slice(5) : s.startsWith('@') ? s.split('/').slice(0, 2).join('/') : s.split('/')[0];
        assert.ok(builtins.has(name) || deps.has(name), `${f}: ${s} staat niet in dependencies`);
      }
    }
  }
  // De pagina die de server serveert staat in public/.
  assert.ok(fs.existsSync(path.join(root, 'public', 'index.html')));
  assert.match(read('src/server.js'), /'\.\.', 'public'/);
});

test('Dockerfile (trainer): kopieert alle .py-bestanden, installeert numpy en scikit-learn, start server.py', () => {
  const df = lines(read('trainer/Dockerfile'));
  assert.ok(df.includes('COPY *.py ./'), 'alle trainer/*.py');
  assert.ok(df.some((l) => /numpy/.test(l)) && df.some((l) => /scikit-learn/.test(l)));
  assert.ok(df.some((l) => /^CMD \["python", "server\.py"\]/.test(l)));
  assert.ok(df.some((l) => /^USER trainer/.test(l)), 'niet als root');
  // Elke lokale import van de trainer is een .py-bestand in trainer/ (dus meegekopieerd).
  const pys = new Set(fs.readdirSync(path.join(root, 'trainer')).filter((f) => f.endsWith('.py')).map((f) => f.slice(0, -3)));
  const seen = new Set();
  const visit = (mod) => {
    if (seen.has(mod)) return;
    seen.add(mod);
    const text = read(`trainer/${mod}.py`);
    for (const m of text.matchAll(/^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w., ]+))/gm)) {
      const names = m[1] ? [m[1]] : m[2].split(',').map((x) => x.trim().split(/\s+as\s+/)[0]);
      for (const n of names) {
        const top = n.split('.')[0];
        if (pys.has(top)) visit(top);
      }
    }
  };
  visit('server');
  for (const m of seen) assert.ok(pys.has(m), m);
  assert.ok(seen.size > 3, `server.py importeert lokale modules: ${[...seen].join(', ')}`);
});

test('CI: de workflow draait npm test en de Python-tests van de trainer', () => {
  const wf = read('.github/workflows/docker.yml');
  assert.match(wf, /run:\s*npm test/);
  assert.match(wf, /node-version:\s*22/);
  assert.match(wf, /python -m unittest[^\n]*test_trainer/);
  assert.match(wf, /working-directory:\s*trainer/);
  assert.match(wf, /pip install numpy scikit-learn/);
  // npm test pakt alle test/*.test.js, dus ook de regressietests.
  assert.equal(JSON.parse(read('package.json')).scripts.test, 'node --test test/*.test.js');
  // De images worden pas gebouwd na de tests.
  assert.ok(wf.indexOf('npm test') < wf.indexOf('docker/build-push-action'));
  assert.ok(wf.indexOf('unittest') < wf.indexOf('docker/build-push-action'));
});

test('CI draait ook trainer/test_regression.py (alle Python-tests)', { todo: 'de workflow draait alleen "python -m unittest -v test_trainer"; trainer/test_regression.py (en elk ander test_*.py) wordt in CI niet uitgevoerd' }, () => {
  const wf = read('.github/workflows/docker.yml');
  assert.match(wf, /python -m unittest[^\n]*(discover|test_regression)/);
});
