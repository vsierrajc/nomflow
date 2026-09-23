# ADR-001: Stack tecnológico

- Estado: Aceptada (2026-09-23)

## Contexto
La SSD (sección 2) propone TypeScript con web, API, BD relacional, cola de trabajos y almacenamiento privado.

## Decisión
- Lenguaje: TypeScript estricto en todo el repositorio (monorepo).
- Web: Next.js. API: NestJS (única responsable de autorización; la web no accede a BD ni almacenamiento).
- Base de datos: PostgreSQL. Cola y trabajos (importación, PDF, ZIP): Redis.
- Almacenamiento privado de documentos: compatible con S3.
- Versiones exactas y lockfiles se fijan al crear el repositorio de código.

## Consecuencias
- Cambiar un componente requiere nuevo ADR y pruebas.
- Pendiente: ADR-002 (ORM/migraciones), ADR-003 (motor PDF), ADR-004 (firma), ADR-005 (SMTP y sesiones).
