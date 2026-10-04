# Respaldo y restauración

Cubre PostgreSQL y los objetos de Garage (certificados de retención y constancias de vacaciones). Los scripts son
`scripts/backup.sh` y `scripts/restore-ensayo.sh` (`npm run backup`, `npm run restore:ensayo`). La clave de cifrado
de los objetos se respalda aparte: [backup-clave-objetos.md](backup-clave-objetos.md).

## Qué se respalda y qué no

| Elemento | Cómo | Dónde queda |
| --- | --- | --- |
| PostgreSQL (todas las tablas, incluida la auditoría) | `pg_dump -Fc` | `backups/<fecha UTC>/postgres.dump` |
| Recuento de filas por tabla (antes y después del volcado) | consulta SQL | `postgres.counts.*.tsv` |
| Objetos de Garage (ya cifrados por la aplicación) | copia por la API S3, con `sha256` de cada uno | `objects/` y `objects.manifest.json` |
| **`OBJECT_ENCRYPTION_KEY`** | **no se incluye**: custodia aparte, fuera del servidor | ver [backup-clave-objetos.md](backup-clave-objetos.md) |
| `.env` (`SESSION_SECRET`, claves de Garage, SMTP) | **no se incluye** | custodia aparte |
| Objetos que el archivo histórico movió a la nube | no están en Garage | los conserva el proveedor de ese archivo |
| Redis y Mailpit | no guardan nada que haya que recuperar | - |

Sin la clave, los objetos respaldados no se pueden descifrar. Un respaldo de objetos sin la clave **no sirve**.

## Hacer un respaldo

```bash
npm run backup
```

Usa `DATABASE_URL` y `S3_*` del `.env` (lo que venga del entorno manda). Deja `backups/<fecha UTC>/` con permisos 700/600
y `backups/` está en `.gitignore`. Contiene datos personales: **guárdelo cifrado, con acceso restringido y copiado fuera
del servidor** (un respaldo en el mismo disco no protege de perder el disco). Para una base que no está en el
`docker compose` local, defina `PG_EXEC` (por ejemplo vacío para usar los clientes `pg_dump`/`psql` del equipo).

Recomendación (por confirmar con Operación): diario, y siempre antes de desplegar una versión con migraciones o de cargar
datos reales.

## Ensayar la restauración

El ensayo restaura en una base y un bucket **de ensayo** (`<base>_ensayo`, `<bucket>-ensayo`) y nunca toca los reales:

```bash
npm run restore:ensayo -- backups/<fecha> [--reemplazar] [--limpiar]
```

Comprueba, y falla (código de salida 1) si algo no cuadra:

1. La huella del volcado coincide con el manifiesto (si no, se detiene sin restaurar nada).
2. `pg_restore` termina sin errores.
3. Cada tabla tiene el mismo número de filas que al respaldar.
4. Las migraciones: cuántas trae el respaldo frente al código; si faltan, se aplican en la base de ensayo.
5. Los objetos restaurados son idénticos al manifiesto y **cada uno descifra con `OBJECT_ENCRYPTION_KEY`**.

`--reemplazar` reemplaza un ensayo anterior (solo se puede vaciar lo que termina en `_ensayo` / `-ensayo`); `--limpiar`
borra lo de ensayo al terminar bien; `ENSAYO_DB` fija otro nombre para la base de ensayo (debe terminar en `_ensayo`).
`restore-objects.mjs` se niega a restaurar sobre un bucket que no esté vacío.

## Restaurar de verdad (desastre)

1. Detener la aplicación (`./detener_app.sh`) y **no borrar nada** del estado dañado hasta tener la restauración verificada.
2. Garage: levantar el servicio y crear el bucket (`scripts/garage-init.sh`) y restaurar los objetos en un bucket vacío:
   `node scripts/restore-objects.mjs --from backups/<fecha> --bucket <bucket> --descifrar` (con `S3_*` y
   `OBJECT_ENCRYPTION_KEY` en el entorno).
3. PostgreSQL: crear una base vacía y restaurar:
   `docker compose exec -T postgres pg_restore -U <usuario> -d <base> --no-owner --exit-on-error < backups/<fecha>/postgres.dump`.
4. Poner en el `.env` la `OBJECT_ENCRYPTION_KEY` custodiada y los demás valores.
5. Compilar y migrar (`./iniciar_app.sh`): aplica las migraciones que falten.
6. Verificar: entrar, descargar un certificado y una constancia, y revisar la auditoría.

## Registro del ensayo realizado

Ensayo del 3 de octubre de 2026 (hora de Colombia) con Node 22 y el stack local. **Se hizo con los datos de pruebas
(`nomflow_test`), no con datos reales.**

| Comprobación | Resultado |
| --- | --- |
| Base `nomflow_test`: 61 tablas, 3.457 filas, 42 migraciones | Restaurada en `nomflow_limpio_ensayo`: mismas 61 tablas y 3.457 filas, 42 de 42 migraciones |
| Volcado 377 KB; respaldo y restauración | unos 3 s y 6 s |
| Objetos (5 ficticios cifrados por la aplicación con la clave del `.env`) | 5 restaurados, 5 idénticos al manifiesto, 5 de 5 descifrados |
| Bucket de pruebas `nomflow-test` (260 objetos, 1,7 MB) | 260 restaurados idénticos; **44 no descifran con la clave del `.env`**: es un bucket que mezcla objetos de varias corridas de pruebas con otras claves, y la comprobación lo detectó |
| Objeto del respaldo alterado | detectado antes de subirlo; el ensayo falla |
| Volcado alterado | se detiene sin restaurar nada |
| Restaurar sobre un bucket con datos, o vaciar uno que no es de ensayo | rechazado; el bucket de pruebas quedó intacto (260 objetos) |

## Lo que todavía NO está probado ni decidido

- **Datos reales y volumen:** los tiempos de arriba son de datos de prueba (cientos de KB). Hay que repetir el ensayo con un
  respaldo real antes de producción y medir cuánto tarda.
- **Programación y retención:** no hay una tarea que corra el respaldo ni una política de cuántos conservar (por ejemplo
  7 diarios, 4 semanales y 12 mensuales); se decide con Operación.
- **Cifrado y copia fuera del servidor** del directorio `backups/`: falta definir la herramienta y el destino.
- **RPO y RTO** (cuántos datos se aceptan perder y cuánto puede tardar volver): decisión de la organización.
- **Garage con un solo nodo** (`replication_factor = 1`): este respaldo es la única redundancia de los objetos.
- **Producción:** el despliegue (Dockerfiles, PLAN 4.1/4.2) no existe; el respaldo deberá adaptarse a donde corran
  PostgreSQL y Garage (`PG_EXEC`, `GARAGE_EXEC`).
