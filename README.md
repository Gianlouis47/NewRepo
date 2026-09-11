# StrikeoutLab

Sistema determinista de análisis de props de ponches (strikeouts) de
lanzadores MLB, para apuestas en banca física dominicana (Star Sport,
Lajara Sport). **Sin app.** Es Supabase + este repo, usado en vivo desde
una sesión de Claude Code: se pregunta en el chat ("Skubal 6.5 contra ARI,
¿conviene?") y se llama directo a la calculadora en Postgres.

Hubo dos apps (una nativa con Expo, una web con Vite) y las dos se
abandonaron — cada capa de UI agregaba bugs propios (teclado, estado que se
borraba al cambiar de pestaña, despliegues) sin sumar nada a lo que ya hacía
la base de datos sola. La lógica de las dos sigue en el historial de git si
hace falta retomarla; no se necesita para usar el sistema.

**El sistema calcula, no adivina.** No predice ponches por intuición —
proyecta con Poisson + log5 + regresión a la media sobre datos reales, y
audita si las confianzas asignadas (por vos o por la IA) se sostienen
contra los resultados reales. Si la calibración muestra que no se
sostienen, ese es un resultado válido del sistema, no un fallo del código.

## Arquitectura

```
packages/core/       # Lógica pura (TypeScript), espejo de las funciones de
                      # Postgres para poder testear sin base de datos: tasas,
                      # reglas de empate, calibración, parlay, proyección.
                      # 117 tests (vitest). Si tocás una función acá, tocá
                      # su equivalente en supabase/migrations — las dos
                      # tienen que dar el mismo número.
supabase/
  migrations/         # Registro de los cambios de esquema. La BASE es la
                      # fuente de verdad; estos archivos documentan qué se
                      # aplicó y por qué, no se re-ejecutan para levantar
                      # el proyecto.
  functions/
    chat/             # Edge Function principal: la IA (NVIDIA NIM) lee
                      # fotos y texto, llama a la calculadora de Postgres
                      # y responde. Es lo que se llamaría desde un cliente
                      # si alguna vez vuelve a haber uno.
    analizar-pitcher/ # Tasa CALCULADA real + opinión JUICIO de la IA,
                      # informada por el historial de calibración.
    analizar-foto/    # Lee un ticket/captura con visión IA.
docs/framework/       # Criterio cualitativo (sharp/sindicato) que sigue la
                      # IA — el "manual" detrás de fuente_confianza=JUICIO.
```

**Por qué Supabase:** Postgres administrado con Auth, Storage y Edge
Functions incluidos, alcanzable desde donde se construyó esto (Neon estaba
bloqueado por política de red del entorno de desarrollo).

**Proyecto Supabase:** `strikeoutlab` (`xuebtkafypivqygyqgcv`, región
`us-east-1`).

## Cómo se usa

No hay pantalla que abrir. Dos caminos:

1. **Desde una sesión de Claude Code con el MCP de Supabase conectado**:
   pedís el análisis en lenguaje natural y la sesión llama a las funciones
   de abajo directo contra la base, o reproduce el mismo cálculo con
   `packages/core` si hace falta explicarlo paso a paso.
2. **Desde el editor SQL de Supabase**, llamando las funciones a mano:

```sql
select proyectar_ponches('Skubal', 6.5, 'ARI', null, 'TEMPORADA', -130, 'PROYECCION');
select historial_lanzador('Skubal', 6.5, 'TEMPORADA', null);
select evaluar_parlay(array[0.62, 0.59, 0.57], -130, 100, null, 5, 'PROYECCION');
select calibracion_real('PROYECCION');
```

El chat de IA (`supabase/functions/chat`) sigue desplegado como Edge
Function y se le puede pegar directo con `curl` o `supabase functions
invoke` si se quiere probar el flujo de foto + IA sin escribir SQL a mano.

## Quién puede entrar

RLS está activo en las siete tablas de datos, con una **lista blanca**
(`usuarios_permitidos`) — estar autenticado en Supabase Auth no alcanza,
hay que estar en esa tabla. Se agrega gente desde el editor SQL:

```sql
insert into usuarios_permitidos (user_id, nota)
select id, 'para qué' from auth.users where email = 'correo@ejemplo.com';
```

Esto quedó así porque la app web estuvo brevemente pública en una URL de
Vercel; con "Supabase + repo solamente" ya no hace falta una URL pública,
pero la lista blanca se queda — es la protección real, no la publishable
key (que está diseñada para ser pública).

## Modelo de datos (Postgres)

- **`picks`** — un registro por pick. `resultado` (`GANO`/`PERDIO`/`EMPATE`)
  se deriva automáticamente por un trigger a partir de `resultado_k`,
  `linea` y `pick` — **nunca se puede escribir a mano, ni por error**. Un
  empate en línea entera nunca colapsa en `GANO` ni `PERDIO`.
  - **Ojo con calibrar sobre picks viejos:** varios `resultado_k` cargados
    antes de tener el historial real llegaron mal (ver
    `20260911000000_corrige_resultado_k_contaminado_en_picks.sql` — 6 de 14
    picks del 25 de agosto tenían el resultado equivocado, verificado
    contra `game_logs`). Antes de confiar en una calibración con pocos
    picks, vale la pena cruzarla contra `game_logs` igual que se hizo ahí.
- **`game_logs`** — historial real de salidas de cada lanzador (`ip` en
  notación de béisbol: 5.1 = 5 entradas y 1 out), cargado de la API oficial
  de la MLB. 3.658 salidas de 224 abridores, temporada 2026 completa.
- **`team_k`** — ponches/PA por equipo y ventana (`TEMPORADA` /
  `ULTIMOS_14`), para comparar por tasa y no por total.
- **`equipo_stats_split`** — K% del equipo rival por mano del lanzador
  (`RHP`/`LHP`) y ventana — el dato que más mueve una proyección después
  del propio lanzador.
- **`equipos_mlb`** / **`equipos_alias`** — traduce abreviaturas de la MLB
  (`AZ`, `CWS`) a las canónicas del esquema (`ARI`, `CHW`). Sin esto,
  cualquier juego de esos dos equipos no encontraba al rival.
- **`pitcher_stats_snapshot`** — K%, WHIP, IP por salida, whiff%/SwStr%,
  regresados a la media según el tamaño de muestra.
- **`learning_log`** — bitácora de aprendizaje del framework cualitativo.
- **`analisis_fotos`** — lo que la IA de visión extrae de cada foto.
- **`usuarios_permitidos`** — la lista blanca de arriba.

## La calculadora: `proyectar_ponches`

Método estándar de sabermetría, no inventado:

1. **log5** combina la tasa de ponche del lanzador con la del rival,
   relativas al promedio de liga.
2. **Bateadores enfrentados** de la duración esperada de la salida:
   `BF ≈ IP × (3 + WHIP)`.
3. **Poisson** pasa de "K esperados" a probabilidad de superar la línea.
4. **Regresión a la media (Bayes empírico)** empuja cada stat hacia un
   ancla en proporción al tamaño de muestra — un relevista con 2 bateadores
   enfrentados y 1 K no tiene 50% de K%, tiene ruido.

La implementación en Postgres (fuente de verdad) y la copia en TypeScript
(`packages/core/src/proyeccion.ts`, para testear sin base de datos) tienen
que dar el mismo número — si se toca una, se toca la otra.

**Backtest walk-forward** (8.336 predicciones, solo con datos anteriores a
cada fecha): en la zona de decisión (52-66% declarado, 2.965 apuestas) el
modelo declaró 58.78% y la realidad fue 58.72% — sobreconfianza de +0.06
puntos. El motor de probabilidad está calibrado; eso no dice que el modelo
completo en vivo (que además usa K% del rival y split por mano) tenga
ventaja contra las líneas reales de Star Sport — son cosas distintas.

## La IA y NVIDIA NIM

Las tres Edge Functions llaman a NVIDIA NIM (`integrate.api.nvidia.com`),
no a un modelo propio ni a otro proveedor:

- `chat`: cascada de modelos de razonamiento (`NVIDIA_MODELOS_TEXTO`,
  lista separada por comas, default
  `nvidia/nemotron-3-super-120b-a12b,minimaxai/minimax-m3,deepseek-ai/deepseek-v4-pro-0813`)
  y de visión (`NVIDIA_MODELOS_VISION`).
- `analizar-pitcher` / `analizar-foto`: un modelo fijo cada uno
  (`NVIDIA_MODEL_TEXTO` / `NVIDIA_MODEL_VISION`).

La IA **no inventa números**: calcula la calculadora en Postgres, la IA
busca, interpreta y da juicio cualitativo (`fuente_confianza = JUICIO`,
siempre distinguible de `CALCULADA`). En cada llamada se le pasa el
historial real de calibración como contexto — eso es el "aprendizaje": no
hay reentrenamiento de pesos.

`NVIDIA_API_KEY` vive únicamente como secret de las Edge Functions —
nunca en el repo. Configurala desde el dashboard de Supabase (Edge
Functions → Secrets) o con la CLI:

```bash
supabase secrets set NVIDIA_API_KEY=tu_key --project-ref xuebtkafypivqygyqgcv
```

## Instalar y correr los tests de `packages/core`

```bash
npm install
npm test    # 117 tests, lógica pura de cálculo y calibración
npm run build --workspace packages/core
```

## Reglas de negocio

- Un resultado igual a una línea entera es `EMPATE`, un estado propio,
  nunca colapsado en `GANO` ni `PERDIO` — aplicado por trigger en Postgres.
- Con menos de 5 salidas, `tasaSuperacionLinea` avisa que la muestra es
  insuficiente. Con menos de 20 picks en una banda de confianza,
  `reporteCalibracion` marca `muestraInsuficiente: true`.
- Nunca se estima ni se rellena un dato faltante — un hueco explícito es
  preferible a un número inventado (ver el caso de Ian Seymour en la
  migración de corrección de `picks`).
- `probabilidadParlay` asume independencia entre patas (documentado en su
  código); `detectarCorrelacionMismoJuego` marca cuándo dos patas vienen
  del mismo enfrentamiento.
- Al -130 el equilibrio es 56.52% (`1/(1+100/130)`) — el número contra el
  que se compara todo, no el 50%.

## Qué NO hace este sistema

- No predice ponches — proyecta con un modelo explícito y audita si las
  confianzas (propias o de la IA) se sostienen.
- No genera confianzas "de la nada" sin poder auditarlas después —
  `fuente_confianza` (`CALCULADA` vs `JUICIO`) siempre queda registrado.
- No garantiza ganancias. Las casas cobran comisión en cada línea, y esa
  ventaja se multiplica en parlays.
- No tiene interfaz. Si hace falta una para otra persona, es una decisión
  nueva, no una que este repo ya tomó.

## `docs/framework/`

16 documentos de referencia (no código): el criterio cualitativo
sharp/sindicato, específico de Star Sport, que la IA sigue para llegar a
un veredicto y una confianza `JUICIO`. `00_marco_transversal.md` es el
marco compartido; cada archivo numerado agrega su enfoque (props de
pitcher, matchup de lineup, Statcast, mercado/EV, sharp action, códigos y
reglas de Star Sport, bankroll físico, etc.).
