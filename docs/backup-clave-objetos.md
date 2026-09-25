# Respaldo de `OBJECT_ENCRYPTION_KEY`

Los certificados de retención y las constancias de vacaciones se guardan en Garage **cifrados por la aplicación** (AES-256-GCM). Sin esta clave los objetos son bytes ilegibles y no hay forma de recuperarlos. La clave solo existe en el `.env` del servidor (no está en git). Ver [ADR-003](decisions/ADR-003-almacenamiento-objetos-garage.md).

## Qué respaldar

- `OBJECT_ENCRYPTION_KEY` (una línea de texto, mínimo 32 caracteres).
- Opcional pero recomendado: copia del volumen de Garage (`nomflow_garage-data`, `nomflow_garage-meta`) junto con la clave; una sin la otra no sirve.

## Dónde guardarla

- **Fuera del servidor y de este repositorio**: gestor de claves de la organización o sobre sellado en custodia de dos personas de Gestión Humana/TI.
- Nunca en git, en chats, en bitácoras ni en correo. No ponerla en el mismo disco que Garage.
- Anotar quién la custodia y la fecha de la copia.

## Cómo copiarla sin imprimirla en pantalla

```bash
grep '^OBJECT_ENCRYPTION_KEY=' .env | cut -d= -f2- | wl-copy   # o pegar directo en el gestor de claves
```

## Cómo comprobar que la copia sirve (cada vez que cambie y una vez al trimestre)

1. Con la clave de la copia, en un entorno de prueba con el mismo Garage restaurado, descargar un certificado o una constancia por la API.
2. Si la descarga responde 200 y el PDF abre, la copia es válida. Si responde 500 con auditoría `HASH_MISMATCH` o falla el descifrado, la copia no corresponde.

## Restaurar

1. Restaurar los volúmenes de Garage.
2. Poner la clave respaldada en `OBJECT_ENCRYPTION_KEY` del `.env`.
3. `./iniciar_app.sh` y probar una descarga.

## Qué pasa si se pierde

- Los certificados se regeneran reimportando el origen (retenciones).
- Las constancias de vacaciones se regeneran desde la base de datos.
- Hasta entonces las descargas de esos documentos fallan; los datos en PostgreSQL no se afectan.

## Cambiar la clave

No cambiar `OBJECT_ENCRYPTION_KEY` sin re-cifrar antes: deja ilegibles los objetos existentes. La rotación con identificador de clave está pendiente (ver `docs/HANDOFF.md`).
