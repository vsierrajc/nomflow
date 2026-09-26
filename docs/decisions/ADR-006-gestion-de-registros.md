# ADR-006: Gestión de registros (ver, exportar, enviar al histórico, depurar y vaciar)

- Estado: aceptada (2026-09-26). Se apoya en [ADR-003](ADR-003-almacenamiento-objetos-garage.md) (cifrado en la aplicación) y [ADR-004](ADR-004-archivo-historico-nube.md) (histórico en Google).

## Contexto

La auditoría (`audit_logs`) registra cada petición HTTP y los eventos de negocio, y crece sin límite; los archivos de registro de la aplicación (`.run/api.log`, `web.log`) también. El administrador necesita controlarlos: verlos, exportarlos, enviarlos al histórico en la nube, depurarlos e incluso vaciarlos.

## Decisiones

- **Página «Registros y depuración»** (Administración → Sistema, `/admin/registros`) con: resumen (totales, rango, espacio, meses), exportación, envío al histórico, depuración, política de retención, archivos de la aplicación y lista de copias.
- **Auditoría en la base:** se puede exportar (CSV o JSON Lines, por trozos, tope de 1.000.000 de filas) y filtrar por tipo (`HTTP`, `EVENTOS`, `TODO`) y fechas (hora de Bogotá).
- **Envío al histórico:** cada mes (o parte de él si supera 250.000 filas) se convierte en JSON Lines comprimido, se **cifra en la aplicación** (AES-256-GCM, la misma clave de objetos) y se sube al bucket del histórico; se relee y se compara el sha256. Queda una fila en `log_archives` (origen, rango, filas, tamaño, huella, cuántas se borraron) y se puede descargar y descifrar desde la misma página.
- **Depurar:** borra lo anterior a una fecha y de un tipo. Por omisión **copia antes** y solo borra exactamente las filas copiadas y verificadas (si la copia falla, no se borra nada). Borrar sin copia es una decisión explícita (aviso «no se puede recuperar»). Toda depuración exige **motivo (≥ 10 caracteres) y escribir BORRAR**.
- **Huellas intocables:** los registros de las propias operaciones (`AUDIT_PURGE`, `LOG_ARCHIVE`, `LOG_EXPORT`, `LOG_FILE_TRUNCATE`, `LOG_SETTINGS_UPDATE`) nunca se borran, ni siquiera al «borrar todo»: la depuración deja una fila `AUDIT_PURGE` con quién, cuándo, qué tipo, cuántas filas, si hubo copia y el motivo.
- **Política de retención** (`log_settings`): días de eventos (365 por omisión) y de peticiones HTTP (90), copiar antes de borrar y ejecución diaria automática (apagada por omisión, `LOGS_SCHEDULER=off` la desactiva); botón «Aplicar ahora».
- **Archivos de la aplicación:** solo los declarados en `LOG_FILES` (`nombre=ruta,…`, nombres `[A-Za-z0-9_-]`, sin rutas del usuario). Se pueden ver las últimas líneas (con filtro), descargar, enviar al histórico (máx. 100 MB) y **vaciar** (con copia previa opcional, motivo y confirmación). `scripts/stack.sh` abre la salida en modo **añadir** (`>>`) para que vaciar el archivo no deje huecos de ceros mientras el proceso sigue escribiendo.
- **Acceso:** solo administradores; cada exportación, copia, depuración y vaciado queda auditado.

## Consecuencias

- Lo que se borra sin copia no se recupera; la auditoría es evidencia (SSD): la política por omisión copia antes y conserva más los eventos que las peticiones.
- El histórico en la nube contiene datos personales (correos, identificaciones truncadas): va cifrado y su clave (`OBJECT_ENCRYPTION_KEY`) nunca sale del servidor; sin ella las copias son ilegibles.
- Las copias no se pueden «reimportar» a la tabla: se descargan y se consultan como archivo.
- Trampa: `.gitignore` excluye directorios llamados `logs/`; el módulo vive en `apps/api/src/registros/` y la ruta web en `/admin/registros`.
