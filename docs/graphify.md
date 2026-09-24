# Graphify: mapa del código para seguimiento y cambios

Graphify construye un grafo de conocimiento del repositorio (funciones, módulos, tablas SQL, dependencias y documentos). Sirve para ver **qué se ve afectado antes de cambiar algo** y para navegar el código sin abrir archivos a ciegas. Es una ayuda: la fuente de verdad sigue siendo el código, la SSD y las pruebas.

Alcance actual: extracción por análisis del código (AST) de TypeScript, TSX, JSON, Markdown, shell y **SQL de las migraciones** (58 nodos: tablas, índices y restricciones). 1415 nodos, 3354 aristas y 85 comunidades al 24 de septiembre de 2026.

## Instalación (una vez por equipo)

```bash
uv tool install --force "graphifyy[sql]==0.9.67"   # versión fijada; el extra sql indexa las migraciones
graphify install --platform claude                  # habilita la integración con Claude Code
graphify hook install                               # hooks locales post-commit y post-checkout
```

- La versión está fijada igual en el CI (`.github/workflows/ci.yml`). Al subirla, cambiarla en ambos sitios.
- `graphify hook install` también intenta crear un `.gitattributes` para `graph.json`; como el grafo no se versiona, **no** se incluye en Git.
- Si aparece «skill … is from graphify X» ejecutar de nuevo `graphify install --platform claude`.

## Uso local

```bash
npm run graph                                   # regenera el grafo (unos 3 s, sin LLM, sin claves, todo local)
graphify affected "hasActiveRole"               # qué se rompe si cambio esto (llamadas e imports inversos)
graphify explain "createAccountByAdmin"         # qué es y con qué se relaciona
graphify path "login" "hasActiveRole"           # camino más corto (añadir --undirected si no hay camino dirigido)
graphify god-nodes --top 10                     # los nodos más conectados (puntos de mayor riesgo)
graphify query "¿dónde se revocan las sesiones?"
```

**Nombres ambiguos.** Una tabla aparece en el esquema de TypeScript y en su migración SQL, así que `graphify explain "accounts"` pide desambiguar. Use el identificador completo del nodo que muestra el mensaje:

```bash
graphify affected "apps_api_src_db_schema_accounts"   # 43 dependientes de la tabla accounts
```

El resultado queda en `graphify-out/` (`GRAPH_REPORT.md`, `graph.json`, `graph.html`). No se versiona: cambia en cada commit y provocaría conflictos. Los hooks locales lo mantienen al día.

## Cuándo consultarlo

- **Antes de tocar autorización, importación, sesiones, esquema o certificados**: `graphify affected "<función o id de tabla>"` y revisar las pruebas de cada dependiente (SSD, sección 11.2).
- **Antes de cambiar una tabla**: el identificador de la tabla muestra qué servicios la usan; complementa (no reemplaza) la revisión de la migración.
- **Al cerrar una sesión** (SSD, sección 10.2): comparar `god-nodes` y el informe si hubo un cambio estructural, y anotarlo en la bitácora.
- **En una revisión de PR**: descargar el artefacto `graphify-<sha>` del job `graph` del CI.

## Qué NO entra

`.graphifyignore` excluye `*.xlsx`, `*:Zone.Identifier`, `node_modules`, `dist`, `.next`, `.next-e2e`, `test-results`, `playwright-report`, `storage` y `package-lock.json`. Nunca se indexan datos de empleados, nóminas ni salarios. Si se añade un tipo de archivo con datos reales, agregarlo ahí **antes** de ejecutar el grafo.

## Limitaciones y política

- **Sin extracción semántica con LLM.** `graphify extract`, `graphify label` y `/graphify` con proveedores externos enviarían contenido del repositorio a un tercero: **no usarlos** sin aprobación de Gestión Humana y seguridad. Por eso las comunidades se quedan con nombres genéricos.
- La extracción de SQL cubre estructura (tablas, índices, restricciones), no el detalle de columnas.
- Los grafos no distinguen bien un nombre repetido entre archivos: usar el identificador completo.
- El job `graph` del CI es informativo (`continue-on-error`).
