# Sesión: 2026-09-24 - portada de la pantalla de ingreso
- Responsable / agente: Claude Code
- Objetivo: darle a `/login` aspecto de portal (landing) sin cambiar colores ni estilo
- Rama: feat/landing-ingreso desde main
- Cambios: `LoginLanding` y `AuthFrame` (detecta `/login`) en `components/shells.tsx`; estilos `.landing-*` en `globals.css` con los tokens existentes; `login/page.tsx` usa la portada
- Decisiones: el sitio de referencia (portal de otra empresa) se dibuja con JavaScript y no entregó estructura; se usó el patrón habitual (panel de marca + tarjeta). Los servicios que aún no existen se rotulan «próximamente» (no se muestran como operativos); en teléfono el panel se compacta y no repite la lista
- Pruebas y evidencia: 40 pruebas de navegador de acceso e interfaz (accesibilidad, 320 px, texto al 200 %, teclado, modo oscuro); capturas de escritorio, teléfono y modo oscuro revisadas
- Estado final: hecho
