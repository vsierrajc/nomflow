# Graphify: mapa del código para seguimiento y cambios

Graphify construye un grafo de conocimiento del repositorio (funciones, módulos, dependencias y documentos). Sirve para ver **qué se ve afectado antes de cambiar algo** y para navegar el código sin abrir archivos a ciegas. Es una ayuda: la fuente de verdad sigue siendo el código, la SSD y las pruebas.

## Uso local
```bash
npm run graph                          # regenera el grafo (2 s, sin LLM, sin claves, todo local)
graphify affected "hasActiveRole"      # qué se rompe si cambio esto (llamadas e imports inversos)
graphify explain "createAccountByAdmin" # qué es y con qué se relaciona
graphify path "login" "hasActiveRole"  # camino más corto entre dos elementos
graphify god-nodes --top 10            # los nodos más conectados (puntos de mayor riesgo)
graphify query "¿dónde se revocan las sesiones?"
```
El resultado queda en `graphify-out/` (`GRAPH_REPORT.md`, `graph.json`, `graph.html`). No se versiona: cambia en cada commit y provocaría conflictos. Los hooks locales `post-commit` y `post-checkout` (`graphify hook install`) lo mantienen al día.

## Cuándo consultarlo
- **Antes de tocar autorización, importación, sesiones o certificados**: `graphify affected "<función>"` y revisar las pruebas de cada dependiente (SSD, sección 11.2).
- **Al cerrar una sesión** (SSD, sección 10.2): comparar `god-nodes` y el informe si hubo un cambio estructural, y anotarlo en la bitácora.
- **En una revisión de PR**: descargar el artefacto `graphify-<sha>` del job `graph` del CI.

## Qué NO entra
`.graphifyignore` excluye `*.xlsx`, `*:Zone.Identifier`, `node_modules`, `dist`, `.next`, `storage` y `package-lock.json`. Nunca se indexan datos de empleados, nóminas ni salarios. Si se añade un tipo de archivo con datos reales, agregarlo ahí **antes** de ejecutar el grafo.

## Limitaciones conocidas
- Los `.sql` de migraciones no se indexan (falta `tree_sitter_sql`; opcional: `pip install "graphifyy[sql]"`). El esquema está en `apps/api/src/db/schema.ts`.
- Solo se usa la extracción por AST. La extracción semántica con LLM (`graphify extract`) envía contenido a un proveedor externo: **no usarla** sobre este repositorio sin aprobación de Gestión Humana y seguridad.
- El job `graph` del CI es informativo (`continue-on-error`).
