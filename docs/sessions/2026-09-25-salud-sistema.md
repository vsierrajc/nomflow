# 2026-09-25: salud del sistema y alertas

- Petición: monitorear el almacenamiento disponible para objetos y alertar sobre problemas críticos; reciben los administradores; umbrales administrables.
- Implementado: `apps/api/src/health/` (servicio, ciclo periódico, controlador), tablas `health_settings` y `health_alerts` (migración 0023), página `/admin/salud`, aviso en el layout de administración.
- Comprobaciones: espacio libre (API de administración de Garage: `GARAGE_ADMIN_ENDPOINT`, `GARAGE_ADMIN_TOKEN`), Garage accesible, latencia de PostgreSQL, errores de descarga en la auditoría (ventana configurable) y estado del correo.
- Avisos: correo solo al abrir, empeorar, repetir (crítico, cada `renotifyMin`) o resolver; si el correo falla se reintenta en el ciclo siguiente; con la BD caída se avisa desde memoria.
- Pruebas: 9 de API (umbrales, transiciones, repetición, resolución, fallo de correo, permisos) y 2 de navegador.
- Pendiente: CPU/memoria/disco del servidor de aplicación, otros canales (Teams, SMS), silenciar una alerta.
