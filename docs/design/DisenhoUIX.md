# NOMFLOW — especificación de rediseño UI/UX

**Fecha:** 24 de septiembre de 2026  
**Base revisada:** `nomflow-main.zip`  
**Alcance:** experiencia web de autogestión de empleados y arquitectura visual de módulos futuros.

## 1. Propósito

NOMFLOW permite a los empleados gestionar documentos y trámites laborales, incluidos volantes de pago, certificados, vacaciones y permisos. Los jefes de área y otros aprobadores atienden solicitudes dentro de su competencia; Gestión Humana y administración mantienen las operaciones autorizadas. El diseño debe hacer comprensible qué puede hacer cada persona, qué solicitudes requieren su acción y cuál es el estado de cada trámite.

Esta especificación distingue la experiencia implementada de la planeada. No autoriza crear datos ficticios, endpoints, permisos o procesos de aprobación ajenos a la especificación funcional.

## 2. Diagnóstico del repositorio

El frontend usa Next.js 16, React 19 y CSS global, con páginas en `apps/web/app` y componentes básicos en `apps/web/components/ui.tsx`.

| Área | Estado observado | Implicación de diseño |
| --- | --- | --- |
| Acceso | `/login` ofrece correo, clave y enlace de activación | Mejorar jerarquía, ayuda, validación y estados sin cambiar el contrato de autenticación. |
| Activación | `/activar` solicita correo, clave temporal, código y nueva clave | Agrupar el proceso en pasos comprensibles, conservar reenvío y mensajes de privacidad. |
| Cuenta | `/cuenta/clave` permite cambiar la clave | Mantener un formulario focalizado y comunicar el cierre de otras sesiones. |
| Inicio | `/` presenta nombre, correo y lista de roles en una tarjeta | Transformarlo en un espacio de trabajo para tareas existentes; traducir roles técnicos a lenguaje útil. |
| Componentes | `Field`, `Alert` y `Card` cubren lo básico | Extender variantes y estados de forma reutilizable sin añadir dependencias por estética. |
| Diseño | Un mismo ancho máximo de 520 px para todas las páginas, tokens limitados y modo oscuro | Conservar ancho compacto para formularios; crear contenedores y retículas apropiados para el panel autenticado. |

Según `docs/STATUS.md`, la versión está en pre-lanzamiento. Volantes, certificados, ZIP, vacaciones, festivos y permisos figuran en backlog. La interfaz no debe ofrecer acciones que aparenten funcionar hasta que sus servicios y autorizaciones estén implementados.

## 3. Principios de experiencia

1. **Tareas antes que estructura técnica:** mostrar «Mis solicitudes», «Pendientes por aprobar» o «Mi cuenta» cuando proceda, en lugar de convertir códigos de rol en navegación.
2. **Permisos verificables:** las opciones visibles corresponden a capacidades reales y la API sigue validando autorización; ocultar un control no sustituye una comprobación del servidor.
3. **Estado explícito:** cada trámite debe mostrar fecha, etapa, responsable o siguiente acción cuando esos datos existan.
4. **Privacidad:** no exponer importes salariales en vistas compartidas, notificaciones genéricas, registros de interfaz o ejemplos de desarrollo.
5. **Claridad móvil:** las tareas frecuentes se pueden completar con una mano y sin desplazamiento horizontal accidental.
6. **Accesibilidad:** navegación por teclado, foco visible, etiquetas asociadas, mensajes anunciados y contraste suficiente.

## 4. Sistema visual propuesto

### 4.1 Color

Definir tokens semánticos, no colores aislados por pantalla: fondo, superficie, texto, texto secundario, borde, acción principal, acción secundaria, foco, información, éxito, advertencia y error. Propuesta inicial para modo claro: azul profundo `#174A73` como identidad, azul de acción `#0B5CAD`, fondo neutro `#F5F7FA`, superficies blancas y texto `#16202A`. Ajustar tonos finales tras comprobar contraste en botones, enlaces y mensajes. El color de estado siempre debe acompañarse de texto o icono con nombre accesible. Mantener el modo oscuro mediante los mismos tokens semánticos y verificarlo por separado.

### 4.2 Tipografía y espacio

- Fuente de interfaz: pila `system-ui`, `Segoe UI`, Roboto y sans-serif, o una fuente corporativa autorizada; no depender de una fuente remota para operar.
- Texto principal de 16 px como base; etiquetas habituales de al menos 14 px; metadatos secundarios solo cuando sigan siendo legibles.
- Escala consistente de títulos, interlineado y pesos; evitar mayúsculas sostenidas en textos largos.
- Espaciado basado en incrementos de 4 u 8 px, con agrupación visual clara entre campos, secciones y acciones.
- Controles táctiles cómodos, foco visible y suficiente espacio entre acciones de distinto riesgo.

### 4.3 Distribución y componentes

- Acceso, activación y cambio de clave: columna focalizada, ancho legible, contexto breve y acción principal inequívoca.
- Inicio autenticado: contenedor más ancho, encabezado y navegación adecuados al rol; en móvil, secciones apiladas y prioridades visibles al inicio.
- Componentes reutilizables: encabezado, navegación, tarjeta de tarea, campo con ayuda y error, alerta, estado vacío, indicador de carga, etiqueta de estado, confirmación y tabla o lista adaptable.
- Evitar paneles decorativos o métricas inventadas; cada bloque debe ayudar a iniciar o continuar una tarea.

## 5. Pantallas actuales: cambios implementables

### Acceso

Presentar marca NOMFLOW, título «Ingresar», campos claros y botón principal. Indicar el error de autenticación sin revelar si existe una cuenta. Mantener el enlace de activación y los atributos `autocomplete`. Deshabilitar el botón mientras se envía, conservar el foco útil y anunciar errores con `role="alert"`.

### Activación

Explicar la procedencia de la clave temporal y del código. Agrupar datos de identidad/verificación y creación de clave visualmente, sin convertirlos en pasos técnicos que dependan de nuevos endpoints. Mostrar requisitos de clave junto al campo, error de confirmación junto a su campo y estado claro durante el reenvío. Mantener la respuesta neutra del reenvío para no revelar cuentas.

### Cambio de clave

Ordenar clave actual, nueva y confirmación; mostrar ayuda concreta y errores cercanos a los campos. Confirmar que otras sesiones se cerraron tras el éxito. Mantener la comprobación y el token CSRF existentes.

### Inicio autenticado

Separar saludo, contexto de cuenta y acciones disponibles. Presentar los roles asignados en lenguaje comprensible, con alcance de empresa o área cuando aplique. Por ahora, priorizar «Mi cuenta» y las capacidades realmente conectadas. Los módulos pendientes pueden documentarse en diseños o especificaciones, pero no aparecer como botones operativos ni prometer consulta de volantes todavía inexistente.

## 6. Arquitectura de información futura

| Espacio | Usuario y tarea principal | Información y estados previstos | Dependencia |
| --- | --- | --- | --- |
| Mis documentos | Empleado: localizar y descargar documentos autorizados | Tipo, período, fecha, disponibilidad, error y descarga; vacío explicativo | Servicio documental, autorización y política de descarga. |
| Volantes de pago | Empleado: filtrar por período y consultar su volante | Período y liquidación, estado de generación y descarga segura | Procedimientos, API y controles de acceso a datos salariales. |
| Solicitudes | Empleado: crear y seguir certificados, vacaciones o permisos | Tipo, fechas, motivo cuando proceda, etapa, historial y siguiente paso | Modelos y flujos definidos en la SSD. |
| Aprobaciones | Jefe de área o aprobador: revisar y decidir solicitudes de su alcance | Cola, detalle, trazabilidad, decisión y confirmación | Roles por área, reglas de aprobación y endpoints. |
| Administración | Gestión Humana y administración: gestionar operaciones autorizadas | Usuarios, catálogos e importaciones según capacidades efectivas | API disponible y permisos por operación. |

Para cada módulo futuro definir estados de carga, vacío, error, éxito y acceso denegado, además de fechas, filtros y paginación cuando los volúmenes reales lo exijan. Una descarga debe indicar con claridad qué documento se entregó; no almacenar datos sensibles en el navegador más tiempo del necesario.

## 7. Criterios de aceptación

- Las rutas actuales conservan sus flujos y contratos con la API; no cambian la lógica de sesión, CSRF ni autorización.
- La navegación y las acciones corresponden a funcionalidad existente y al rol efectivo.
- Las pantallas funcionan a 320 px y en escritorio sin recortes ni desplazamiento horizontal injustificado.
- Se puede completar cada formulario con teclado; el foco es visible y sigue un orden lógico.
- Los campos tienen etiquetas, ayuda y errores asociados; los avisos se anuncian correctamente.
- Texto y controles cumplen objetivos de contraste WCAG AA en ambos modos; la interfaz sigue siendo usable con ampliación de texto del 200 %.
- Carga, errores de red, validación y éxito tienen textos específicos y acciones de recuperación cuando corresponda.
- La implementación pasa los controles de formato, lint, tipos, build y pruebas exigidos por `CLAUDE.md`, con la base de pruebas indicada allí; nunca se ejecutan pruebas destructivas sobre la base de desarrollo.
- La entrega separa lo implementado de los diseños de módulos pendientes e incluye capturas o evidencia visual en móvil y escritorio.

## 8. Secuencia recomendada

1. Leer `CLAUDE.md`, SSD, `docs/STATUS.md` y última bitácora; revisar Graphify según la guía del repositorio.
2. Auditar pantallas actuales, navegación, accesibilidad y componentes.
3. Definir tokens y componentes base; rediseñar acceso, activación y cambio de clave.
4. Rediseñar el inicio autenticado según roles y capacidades efectivas.
5. Comprobar escritorio, móvil, modo oscuro, teclado, errores y flujos existentes.
6. Documentar diseños futuros por módulo como trabajo pendiente, con dependencias de API y reglas de negocio.
7. Ejecutar los controles obligatorios en la rama de incidencia y entregar resultados y limitaciones.

## 9. Prompt listo para implementar

> Actúa como diseñador senior de producto y desarrollador frontend. Analiza el repositorio de NOMFLOW antes de modificarlo. Es una aplicación de autogestión para empleados: consulta y trámite de documentos, volantes de pago, certificados, vacaciones y permisos, con flujos de aprobación según el rol.
>
> Objetivo: mejorar profesionalmente la interfaz en jerarquía visual, colores, tipografía, distribución, navegación, formularios, estados y adaptación a móvil, sin alterar las reglas de negocio ni presentar como operativas funciones que aún no existen.
>
> 1. Lee `CLAUDE.md`, `docs/requirements/NOMFLOW_SSD.md`, `docs/STATUS.md`, la última bitácora de `docs/sessions/` y el código de `apps/web`. Respeta las instrucciones del repositorio y separa explícitamente las capacidades implementadas de las que están en backlog.
> 2. Haz una auditoría breve de la interfaz actual. Identifica problemas concretos en `app/page.tsx`, las páginas de acceso y activación, `components/ui.tsx` y `app/globals.css`. Explica el efecto de cada problema sobre empleados, aprobadores y administradores.
> 3. Define un sistema visual coherente para una aplicación empresarial de recursos humanos: paleta con tokens para modo claro y oscuro, escala tipográfica, espaciado, anchos de contenido, superficies, botones, campos, alertas y estados de foco. Prioriza legibilidad, contraste y una apariencia sobria, moderna y cálida.
> 4. Rediseña las pantallas existentes. Conserva una composición enfocada para acceso, activación y cambio de clave. Convierte la página inicial autenticada en un espacio de trabajo claro, con identidad del usuario, roles comprensibles y accesos únicamente a funciones realmente disponibles. No uses la lista técnica de roles como único contenido principal.
> 5. Diseña la arquitectura de información futura para «Mis documentos», «Volantes de pago», «Solicitudes», «Aprobaciones» y «Administración», indicando qué vistas son propuestas y cuáles pueden implementarse ahora. Para cada flujo futuro, especifica tarea principal, información necesaria, estados vacío/cargando/error/éxito y permisos visibles por rol. No inventes endpoints ni datos salariales.
> 6. Mejora la experiencia de formularios: etiquetas claras, ayuda contextual, validación junto al campo, mensajes accionables, indicadores de envío y prevención de envíos duplicados. Mantén las protecciones de sesión, CSRF y autorización existentes.
> 7. Implementa primero el rediseño de las pantallas y componentes actuales en la rama de trabajo correspondiente. Haz que funcionen con teclado y lector de pantalla y que se adapten a móvil, tableta y escritorio. Conserva las pruebas existentes y agrega verificaciones solo cuando cubran un comportamiento nuevo o un riesgo real.
> 8. Entrega un resumen con hallazgos, decisiones de diseño, archivos modificados, evidencia visual, resultados de las comprobaciones requeridas por el repositorio y una lista separada de mejoras que dependen de funcionalidades todavía pendientes. No marques esas mejoras como implementadas.

## 10. Límites y fuente de verdad

Este documento es una guía de diseño basada en el repositorio recibido, no una sustitución de `NOMFLOW_SSD.md`. Ante diferencias funcionales, la SSD y las reglas de negocio vigentes prevalecen. Antes de implementar, comprobar el estado actualizado del repositorio, las ramas y los endpoints; el diagnóstico corresponde a la copia del 24 de septiembre de 2026.
