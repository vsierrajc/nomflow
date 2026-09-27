#!/usr/bin/env node
// Compila docs/changelog.d/*.md (un fragmento por entrada) al final de docs/CHANGELOG.md y borra
// los fragmentos ya incorporados. Ver docs/changelog.d/README.md. Correr aparte, nunca dentro de
// un PR de una funcionalidad: es el único paso que toca CHANGELOG.md, por eso no choca entre ramas.
import { readdirSync, readFileSync, appendFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const dir = join(root, 'docs', 'changelog.d');
const target = join(root, 'docs', 'CHANGELOG.md');

if (!existsSync(dir)) {
  console.log('No hay docs/changelog.d/: nada que compilar.');
  process.exit(0);
}

const fragments = readdirSync(dir)
  .filter((f) => f.endsWith('.md') && f !== 'README.md')
  .sort();

if (fragments.length === 0) {
  console.log('No hay fragmentos pendientes.');
  process.exit(0);
}

const lines = fragments.map((f) => {
  const text = readFileSync(join(dir, f), 'utf8').trim();
  if (!text) throw new Error(`Fragmento vacío: ${f}`);
  return `- ${text}`;
});

appendFileSync(target, lines.join('\n') + '\n');
for (const f of fragments) rmSync(join(dir, f));

console.log(`Compilados ${fragments.length} fragmento(s) en ${target}:`);
for (const f of fragments) console.log(`  - ${f}`);
