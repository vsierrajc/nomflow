# NOMFLOW: guía para agentes y desarrolladores

Especificación canónica: `docs/requirements/NOMFLOW_SSD.md`. Estado: `docs/STATUS.md`. Protocolo de sesión: SSD sección 10.2. Git y CI: SSD sección 11.

## Antes de cambiar código

- Leer `docs/STATUS.md` y la última bitácora de `docs/sessions/`.
- Ver el impacto con Graphify: `npm run graph` y `graphify affected "<función>"` (ver `docs/graphify.md`).
- Trabajar en una rama por incidencia; nada directo a `main`.

## Verificación obligatoria antes de commit (todo debe pasar)

```bash
DATABASE_URL=postgresql://nomflow:nomflow@localhost:5432/nomflow_test \
  npm run format:check && npm run lint && npm run typecheck && npm run build && npm test && npm run audit:deps
```

- Las pruebas vacían las tablas: usar **siempre** la base `nomflow_test`, nunca `nomflow`.
- Correr `npx prettier --write .` antes de `format:check` (incluye migraciones generadas).

## Datos y secretos

- Nunca versionar ni imprimir datos reales de empleados, salarios, claves ni archivos Excel de origen (`*.xlsx` está ignorado).
- No pegar claves en logs, bitácoras ni conversaciones.
