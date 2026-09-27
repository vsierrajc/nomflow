# Fragmentos de CHANGELOG

Cada cambio visible añade **un archivo propio** aquí, en vez de editar `docs/CHANGELOG.md` directamente. Así dos PR en paralelo nunca chocan: cada uno toca un archivo distinto.

## Cómo añadir una entrada

Crea `docs/changelog.d/<AAAAMMDD>-<slug-corto>.md` con **una línea de texto**, tal como debe aparecer en el CHANGELOG (sin viñeta inicial, esa la pone el compilador). Por ejemplo:

```
docs/changelog.d/20260927-volante-sin-unidad.md
```
```
Volante de pago: la columna Hrs muestra solo el valor de CANT, sin la unidad del catálogo de conceptos.
```

## Cómo se integra a CHANGELOG.md

De vez en cuando (no en cada PR) se corre:

```bash
npm run changelog:compile
```

Esto añade cada fragmento como una línea nueva al final de `docs/CHANGELOG.md` (ordenados por nombre de archivo, o sea por fecha) y borra los fragmentos ya incorporados. Es un paso aparte, en su propio commit — nunca se hace dentro de un PR de una funcionalidad, precisamente para no reintroducir el choque que este patrón evita.

## Por qué

`docs/CHANGELOG.md` es un archivo de solo-agregar: todas las líneas nuevas caen en el mismo punto (el final), así que cuando dos ramas lo tocan en paralelo, Git no puede resolverlo solo y hay que fusionar a mano en cada integración. Con un archivo por entrada, ninguna rama de funcionalidad vuelve a tocar `CHANGELOG.md`, así que el choque desaparece salvo en el propio paso de compilación (que es un único commit, sin ramas en paralelo compitiendo).
