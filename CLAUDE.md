# Cómo trabajar en este repo

## Formato de respuesta

**Todo va en tabla.** Resultados de proyecciones, comparaciones, estados,
listas de cualquier cosa: tabla, no párrafos sueltos. El análisis en prosa va
*después* de la tabla, no en lugar de ella, y solo si agrega algo que la tabla
no dice.

Cuando se analiza una cartelera: **todos** los juegos en la tabla, incluidos
los que dan NO CONVIENE y los que no se pudieron proyectar (con el motivo).
Filtrar solo los ganadores esconde el tamaño real del filtro.

## Sobre las apuestas

- La cuota de referencia es **-130** (Star Sport / Lajara Sport). El equilibrio
  está en **56.52%**, no en 50%.
- Lo que se apuesta es la **confianza calibrada**, no la cruda. Si se muestra
  la cruda, se muestra al lado la calibrada.
- Un número positivo no es una recomendación. Antes de sugerir una apuesta:
  buscarle el contraargumento (muestra chica, factor no modelado como el
  parque, línea de la casa muy lejos del promedio reciente) y decirlo.
- Nunca inventar un dato faltante. Un hueco explícito es mejor que un número
  inventado.
- No escribir en `picks` sin que el usuario lo pida: registrar un pick es dejar
  constancia de lo que dijo el sistema, y es él quien decide.

## Datos

La base es la fuente de verdad; `supabase/migrations/` documenta qué se aplicó
y por qué. Antes de confiar en un número recién cargado, cruzarlo contra
`game_logs` (la API oficial de la MLB), como se hizo con la contaminación de
`picks`.
