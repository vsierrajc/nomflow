# ADR-002: ORM y migraciones

- Estado: Propuesta (2026-09-23), pendiente de revisión

## Contexto
La SSD exige: importes `Decimal` exactos (`NUMERIC(18,6)`), índices únicos parciales (un contrato vigente por `N_IDE`, una versión publicada por alcance), bloqueos de fila para serializar aprobaciones de vacaciones y publicaciones de nómina (`SELECT ... FOR UPDATE`), migraciones revisadas y no editables tras aplicarse (11.3), y consultas siempre parametrizadas (3.2).

## Alternativas
- **Prisma:** buen DX, pero los índices únicos parciales y `FOR UPDATE` requieren SQL crudo fuera del modelo; `Decimal` se maneja bien.
- **TypeORM:** integra con NestJS, pero tipado más débil y migraciones autogeneradas menos predecibles.
- **Drizzle ORM + drizzle-kit:** esquema en TypeScript, `numeric` sin pérdida (string), índices parciales, `FOR UPDATE` y transacciones nativas; migraciones son SQL versionado y revisable.

## Decisión
Drizzle ORM con `drizzle-kit` para generar migraciones SQL, que se revisan en PR y se ejecutan una sola vez. Los importes se leen y escriben como texto/`numeric`, nunca `number`. Las pruebas de integración usan un PostgreSQL real (servicio del CI), no mocks.

## Consecuencias
- Ecosistema menor que Prisma; el equipo debe revisar el SQL generado.
- Cambiar de ORM requiere nuevo ADR; las migraciones SQL siguen siendo válidas.
