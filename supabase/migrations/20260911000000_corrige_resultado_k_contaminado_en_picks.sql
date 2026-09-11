-- Registro de la migración ya aplicada al proyecto. La base es la fuente de
-- verdad; este archivo existe para poder leer en el repo qué cambió y por qué.
--
-- ORIGEN: un documento externo (preparado en otra sesión de IA, para
-- discutir la evolución del proyecto hacia "MLBLab") advertía que "los picks
-- históricos existentes contienen errores de identificación de pitchers y
-- no deben utilizarse ciegamente como calibración válida". Esa advertencia
-- no se aceptó de palabra: se verificó cruzando picks.resultado_k contra
-- game_logs.k (el historial real cargado de la API oficial de la MLB) para
-- el mismo pitcher y la misma fecha.
--
-- RESULTADO DE LA VERIFICACIÓN — 14 picks con resultado_k cargado, todos del
-- 2026-08-25:
--
--   7 coincidían exactos (Will Warren, Jacob deGrom, Bryce Elder, Aaron
--     Nola, Clay Holmes, Michael King, Paul Skenes).
--   6 estaban mal — se corrigen acá:
--
--     pitcher           picks decía   real (game_logs)
--     Gavin Williams    6 K           3 K
--     Kyle Harrison     6 K           5 K
--     Max Scherzer      6 K           4 K
--     Taj Bradley       5 K           11 K
--     Payton Tolle      5 K           7 K
--     Jackson Jobe      5 K           4 K
--
--   1 sin poder verificar: Ian Seymour. No existe ninguna fila suya en
--     game_logs para el 2026-08-25 (se buscó por nombre exacto y por ILIKE
--     variantes) — queda SIN TOCAR a propósito. Un hueco sin resolver es
--     preferible a "corregirlo" con un número inventado; pendiente de
--     revisión manual contra la fuente original de ese pick.
--
-- Dos de las seis correcciones cambiaron el veredicto, no solo el número:
--
--   Kyle Harrison  EMPATE (6 K = línea 6) -> PERDIO (5 K, bajo línea)
--   Taj Bradley    PERDIO (5 K)           -> GANO (11 K)
--
-- `resultado` no se toca a mano en ningún UPDATE: lo recalcula el trigger
-- existente a partir de resultado_k, linea y pick — la regla que ya impone
-- el esquema (nunca se escribe a mano, ni por error, ver README).
--
-- POR QUÉ IMPORTA: calibracion_real() y reporteCalibracion() miden si las
-- confianzas declaradas se sostienen contra picks.resultado ya resuelto.
-- Con 6 de 14 resultados mal cargados, esa medición estaba corrupta para
-- los picks fuente_confianza=JUICIO. La corrección no cambia el código de
-- cálculo — cambia el dato de entrada que ese cálculo ya usaba mal.

update picks set resultado_k = 3 where pitcher = 'Gavin Williams' and fecha = '2026-08-25' and resultado_k = 6;
update picks set resultado_k = 5 where pitcher = 'Kyle Harrison' and fecha = '2026-08-25' and resultado_k = 6;
update picks set resultado_k = 4 where pitcher = 'Max Scherzer' and fecha = '2026-08-25' and resultado_k = 6;
update picks set resultado_k = 11 where pitcher = 'Taj Bradley' and fecha = '2026-08-25' and resultado_k = 5;
update picks set resultado_k = 7 where pitcher = 'Payton Tolle' and fecha = '2026-08-25' and resultado_k = 5;
update picks set resultado_k = 4 where pitcher = 'Jackson Jobe' and fecha = '2026-08-25' and resultado_k = 5;
