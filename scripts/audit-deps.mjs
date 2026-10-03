#!/usr/bin/env node
// Auditoría de dependencias: equivale a `npm audit --audit-level=high`, pero admite excepciones
// explícitas, justificadas y con vencimiento (ALLOWED). Cualquier otro aviso alto o crítico falla,
// y una excepción vencida también falla: obliga a revisarla en vez de olvidarla.
import { spawnSync } from 'node:child_process';

/** Avisos aceptados temporalmente. Quitar la entrada en cuanto exista una versión corregida. */
const ALLOWED = [
  {
    id: 'GHSA-86w9-cpqp-85rv',
    package: 'node-forge',
    expires: '2026-11-01',
    reason:
      'Falla en la verificación RSA PKCS#1 v1.5 de node-forge (<= 1.4.0, sin versión corregida; ' +
      'arreglo abierto en digitalbazaar/forge#1152). NOMFLOW usa node-forge solo para generar ' +
      'certificados, leer el .p12 y firmar (@signpdf/signer-p12); nunca llama a su verificación ' +
      'RSA: las firmas se verifican con node:crypto (certificates/digital-signature.ts).',
  },
];

const res = spawnSync('npm', ['audit', '--json'], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});
let report;
try {
  report = JSON.parse(res.stdout);
} catch {
  console.error('No se pudo leer la salida de `npm audit`:\n' + (res.stdout || res.stderr));
  process.exit(1);
}
if (report.error) {
  console.error(`npm audit falló: ${report.error.summary ?? JSON.stringify(report.error)}`);
  process.exit(1);
}

const idOf = (url = '') => /GHSA-[a-z0-9-]+/i.exec(url)?.[0] ?? url;
const today = new Date().toISOString().slice(0, 10);

// Avisos reales (objetos en `via`) de severidad alta o crítica, sin repetir.
const found = new Map();
for (const v of Object.values(report.vulnerabilities ?? {})) {
  for (const via of v.via ?? []) {
    if (typeof via === 'object' && ['high', 'critical'].includes(via.severity))
      found.set(idOf(via.url), { package: via.name, title: via.title, severity: via.severity });
  }
}

const failures = [];
for (const [id, a] of found) {
  const allowed = ALLOWED.find((e) => e.id === id);
  if (!allowed) failures.push(`${a.severity.toUpperCase()} ${a.package}: ${a.title} (${id})`);
  else if (allowed.expires < today)
    failures.push(
      `Excepción vencida el ${allowed.expires}: ${id} (${allowed.package}). Revisarla.`,
    );
  else
    console.log(
      `Aviso aceptado hasta el ${allowed.expires}: ${id} (${allowed.package})\n  ${allowed.reason}`,
    );
}
for (const e of ALLOWED)
  if (!found.has(e.id))
    console.log(
      `La excepción ${e.id} ya no aplica (aviso resuelto): quítela de scripts/audit-deps.mjs.`,
    );

if (failures.length > 0) {
  console.error('\nAvisos de seguridad sin excepción vigente:\n- ' + failures.join('\n- '));
  process.exit(1);
}
console.log(
  'Auditoría de dependencias: sin avisos altos ni críticos fuera de las excepciones vigentes.',
);
