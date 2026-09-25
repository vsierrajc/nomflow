# 2026-09-25: almacenamiento de objetos con Garage

- Decisión: [ADR-003](../decisions/ADR-003-almacenamiento-objetos-garage.md). MinIO retirado; Garage v2.4.1 de un nodo.
- Alcance: certificados de retención y constancias de solicitudes de vacaciones van a objetos; permisos solo BD; volantes generados al descargar.
- Cifrado en la aplicación (Garage acepta SSE-S3 pero no cifra); perder `OBJECT_ENCRYPTION_KEY` deja los objetos ilegibles.
- Pruebas: storage (14), tax (10), vacation (15) y e2e contra Garage real; el CI levanta Garage en el job e2e.
- Incidente: un `docker volume prune -f` propio borró volúmenes anónimos sin uso de otros proyectos; NOMFLOW quedó intacto. Regla guardada en memoria.
- Pendiente: volumen huérfano `nomflow_minio-data` (borrado manual), rotación de clave de objetos.
