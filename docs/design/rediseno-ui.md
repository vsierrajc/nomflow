# Rediseño de la interfaz web (ESS-UX-001)

Cumple la guía [DisenhoUIX.md](DisenhoUIX.md). Este documento resume qué se auditó, qué se decidió, qué quedó implementado y qué es solo diseño futuro. La SSD y las reglas de negocio prevalecen sobre cualquier decisión visual.

## 1. Estado real frente al diagnóstico de la guía

La guía se escribió sobre una copia anterior del repositorio. Al comprobar el estado actual:

| Capacidad | Diagnóstico de la guía | Estado real al rediseñar |
| --- | --- | --- |
| Acceso, activación, cambio de clave, inicio | Implementados | Implementados |
| Volantes de pago | Backlog | **Implementados** (importación, PDF, descarga, acceso administrativo con motivo) |
| Administración | Backlog | **Implementada** (empresas y logo, catálogos, conceptos, empleados, cuentas y roles, importaciones, nómina, auditoría) |
| Certificados, vacaciones, permisos, ZIP, festivos | Backlog | Backlog: **no aparecen como acciones operativas** |

## 2. Auditoría de la interfaz anterior

| Hallazgo | Efecto |
| --- | --- |
| Un único ancho de 520 px para todo | Los administradores trabajaban con tablas en una columna estrecha; los empleados no tenían un espacio de trabajo. |
| Inicio = una tarjeta con la lista técnica de roles (`AREA_MANAGER`...) | El empleado no sabía qué podía hacer; el jefe de área veía un código y no su alcance. |
| Errores de formulario en una sola alerta arriba | Quien usa lector de pantalla o un teléfono no sabía qué campo corregir. |
| Sin enlace para saltar navegación ni título por página | Más pulsaciones de tabulador y contexto perdido al cambiar de pantalla. |
| Estados de carga como texto suelto; sin estado vacío explicativo | Incertidumbre sobre si algo falló o simplemente no había datos. |
| Tokens de color aislados; foco y contraste sin verificar en oscuro | Riesgo de contraste insuficiente. |
| Identificadores de campo repetidos entre diálogos y filtros | La etiqueta de un diálogo enfocaba un campo de otro (detectado por las pruebas). |

## 3. Sistema visual

Todo el estilo está en `apps/web/app/globals.css` como **tokens semánticos** (fondo, superficie, texto, texto secundario, borde, identidad, acción, foco, información, éxito, advertencia, error). El modo oscuro solo redefine tokens. Sin fuentes remotas ni dependencias nuevas.

- **Color:** identidad `#174A73`, acción `#0B5CAD`, fondo `#F5F7FA`, texto `#16202A` (la propuesta de la guía, validada). Nunca se comunica un estado solo con color: alertas con icono y prefijo accesible («Error:», «Listo:»), etiquetas con texto, requisitos con «Cumplido»/«Pendiente».
- **Tipografía:** pila `system-ui, Segoe UI, Roboto`; base 16 px; escala en `rem` (14, 16, 18, 20, 24, 30 px) para respetar la ampliación de texto.
- **Espacio:** múltiplos de 4 px en `rem`. Controles de 44 px de alto; 36 px en acciones de tabla.
- **Anchos:** acceso 28 rem, formularios 38 rem, aplicación 72 rem, administración 80 rem.
- **Foco:** anillo de 3 px con desplazamiento, color propio por modo.
- **Movimiento:** sin animaciones salvo el indicador de carga, que se detiene con `prefers-reduced-motion`.

### Contraste verificado (WCAG 2.2 AA)

| Par | Mínimo | Claro | Oscuro |
| --- | --- | --- | --- |
| Texto principal | 4.5:1 | 16.48:1 | 13.97:1 |
| Texto secundario | 4.5:1 | 7.42:1 | 8.13:1 |
| Texto secundario sobre fondo | 4.5:1 | 6.91:1 | 9.15:1 |
| Texto en cabecera | 4.5:1 | 9.28:1 | 13.00:1 |
| Texto de botón principal | 4.5:1 | 6.67:1 | 8.50:1 |
| Enlace | 4.5:1 | 6.67:1 | 8.17:1 |
| Mensaje informativo | 4.5:1 | 9.61:1 | 9.31:1 |
| Mensaje de éxito | 4.5:1 | 7.92:1 | 9.55:1 |
| Mensaje de advertencia | 4.5:1 | 8.59:1 | 10.34:1 |
| Mensaje de error | 4.5:1 | 8.02:1 | 9.48:1 |
| Borde de campo | 3:1 | 4.35:1 | 5.28:1 |
| Anillo de foco | 3:1 | 5.02:1 | 9.86:1 |
| Borde de error | 3:1 | 6.57:1 | 7.19:1 |
Además, las pruebas de navegador ejecutan axe (WCAG 2 A y AA, incluido color-contrast) en modo claro y oscuro sobre acceso y activación con errores, inicio, volantes, cuenta y administración.

## 4. Componentes reutilizables

`components/ui.tsx`: `Field` (etiqueta, ayuda y error asociados con `aria-describedby`, `aria-invalid`), `PasswordField` (mostrar/ocultar con `aria-pressed`), `Alert` (icono + prefijo accesible + `role`), `Spinner`, `Loading`, `EmptyState`, `SubmitButton` (estado ocupado, sin envíos duplicados), `Requirements` (requisitos de clave en vivo).
`components/shells.tsx`: `AuthFrame`/`AuthCard` (columna enfocada), `AppShell` (cabecera con navegación por rol, menú plegable en móvil, enlace «Saltar al contenido», cierre de sesión).
`components/admin-ui.tsx` e `import-panel.tsx` se conservan y heredan los tokens.

Estructura de rutas: `app/(public)/` (login, activar) y `app/(app)/` (inicio, volantes, cuenta, admin) con un único `ProfileProvider` por grupo. Las URL no cambian. Los títulos se declaran con la API de metadatos de Next (llegan en el HTML inicial).

## 5. Pantallas implementadas

| Pantalla | Cambios |
| --- | --- |
| Acceso | Marca, título, ayuda, validación junto a cada campo, foco al primer error y a la clave tras un fallo, mensaje único que no revela si la cuenta existe, botón desactivado al enviar, mostrar/ocultar clave, `autocomplete` conservado. |
| Activación | Dos grupos («Verifique su identidad», «Cree su clave nueva»), ayuda sobre la procedencia de la clave temporal y del código, requisitos de clave en vivo, errores junto a su campo, reenvío con estado y respuesta neutra. |
| Cambio de clave | Dentro del espacio de trabajo; clave actual, nueva y confirmación con requisitos; confirma que las otras sesiones se cerraron. |
| Inicio | Saludo, tarjetas de tareas **reales** (volantes con conteo real, cambiar clave, administración solo si aplica), datos de la cuenta y roles en lenguaje comprensible con alcance y vigencia; nota honesta de que los flujos de aprobación aún no existen. |
| Volantes | Modos explicados, filtro de año si hay varios, lista adaptable, estados de carga/vacío/error con reintento. |
| Administración | Mismo marco y tokens; navegación lateral que pasa a rejilla en móvil. |

No cambió ninguna lógica de sesión, CSRF ni autorización, ni ningún contrato con la API.

## 6. Verificación (criterios de la guía, sección 7)

- 320 px sin desplazamiento horizontal en acceso, activación (también con errores), inicio, volantes, cuenta y cuatro pantallas de administración.
- Texto al 200 % en acceso, inicio y activación sin desbordes y con el botón principal dentro de la ventana.
- Teclado: orden lógico, «Saltar al contenido» primero, foco visible, formularios completables sin ratón.
- Etiquetas, ayuda y errores asociados; alertas anunciadas (`role="alert"`/`status`).
- Contraste AA en modo claro y oscuro (tabla y axe).
- `npm run format:check && lint && typecheck && build && test && audit:deps` y `npm run test:e2e` (81 pruebas) en verde.

## 7. Evidencia visual

Capturas con datos sintéticos en `docs/design/evidence/`:

| Archivo | Muestra |
| --- | --- |
| `acceso-claro-escritorio.png` | Acceso, modo claro, escritorio |
| `acceso-errores-claro-320.png` | Acceso con errores de campo a 320 px |
| `acceso-oscuro-movil.png` | Acceso, modo oscuro, móvil |
| `activacion-claro-escritorio.png` | Activación con requisitos en vivo |
| `activacion-oscuro-320.png` | Activación con errores, oscuro, 320 px |
| `inicio-claro-escritorio.png` | Espacio de trabajo del empleado |
| `inicio-oscuro-movil.png` | Inicio en móvil, oscuro |
| `menu-oscuro-movil.png` | Menú plegable abierto |
| `volantes-claro-movil.png` | Volantes en móvil |
| `cuenta-oscuro-escritorio.png` | Cambio de clave con requisitos |
| `administracion-claro-escritorio.png` | Resumen administrativo |

Las capturas ayudaron a detectar dos defectos que las pruebas no veían (botón «Menú» azul sobre azul; requisito de clave marcado como cumplido antes de escribir la temporal), ya corregidos.

## 8. Arquitectura de información futura (propuestas, NO implementadas)

Ninguna de estas vistas existe ni aparece como acción en la interfaz. Cada una depende de servicios y reglas de la SSD.

| Espacio | Tarea principal | Información y estados | Permiso visible | Dependencia |
| --- | --- | --- | --- | --- |
| Mis documentos | Localizar y descargar documentos autorizados (certificados tributarios, laborales, constancias) | Tipo, período, fecha, disponibilidad; vacío explicativo; error con reintento; descarga con nombre del documento entregado | Empleado (propios) | Servicio documental, ESS-TAX-001, ESS-CERT-* y política de descarga |
| Solicitudes | Crear y seguir certificados, vacaciones y permisos | Tipo, fechas, motivo, etapa, responsable, historial, siguiente paso; borrador, enviada, devuelta, aprobada, rechazada | Empleado (propias) | ESS-LEAVE-*, ESS-PERM-001, ESS-HOL-001, ESS-CERT-* y sus endpoints |
| Aprobaciones | Revisar y decidir solicitudes de su alcance | Cola por antigüedad, detalle, trazabilidad, decisión con motivo, confirmación y firma | Jefe de área (su área), aprobador final, aprobador de certificados | Rol por área ya existente; falta el flujo de solicitudes, firmas y endpoints |
| Volantes (mejoras) | Filtrar por período con búsqueda | Estado de generación | Empleado | Volumen real de nómina; hoy basta el filtro de año |
| Administración (mejoras) | Bandejas de trabajo (importaciones pendientes, cuentas por activar) | Contadores accionables | Administrador | Datos reales cargados |

Para cada módulo futuro definir los estados de carga, vacío, error, éxito y acceso denegado, además de filtros y paginación cuando el volumen lo exija; una descarga debe indicar qué documento se entregó y no guardar datos sensibles en el navegador más tiempo del necesario.

## 9. Limitaciones

- No hay conmutador manual de tema: se sigue la preferencia del sistema.
- El menú móvil no atrapa el foco (es un menú plegable, no un diálogo).
- Las tablas administrativas siguen siendo regiones desplazables en pantallas estrechas; no se convirtieron en tarjetas.
- No se probaron lectores de pantalla reales (NVDA, VoiceOver, TalkBack); la verificación es automática (axe) más revisión de semántica.
- Solo se probó Chromium.
