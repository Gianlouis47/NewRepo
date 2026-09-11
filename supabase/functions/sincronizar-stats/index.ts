// Sincroniza stats reales de MLB Stats API (oficial, gratis, sin key) y
// Baseball Savant (Statcast, gratis, sin key) hacia la base de datos.
//
// Uso:
//   GET ?modo=equipos   -> team_k (TEMPORADA) para los 30 equipos, un fetch por equipo.
//   GET ?modo=splits    -> equipo_stats_split.k_pct (RHP/LHP) para los 30 equipos, dos
//                          fetches por equipo (stats=statSplits&sitCodes=vr|vl -- OJO,
//                          no alcanza con stats=season&sitCodes=, ese combo ignora el
//                          split y devuelve el total de temporada).
//   GET ?modo=pitchers  -> pitcher_stats_snapshot para TODOS los lanzadores con al
//                          menos 1 aparicion en la temporada (playerPool=all evita el
//                          filtro "Qualified" que deja afuera a la mayoria de un roster).
//                          Dos fetches en total (leaderboard MLB + CSV de Savant para
//                          whiff_pct), no uno por jugador -- si no, no entra en el
//                          tiempo limite de una Edge Function.
//   GET ?modo=salidas&offset=0&limite=60
//                       -> agrega a game_logs las salidas nuevas (por game_pk) de los
//                          abridores ya identificados (es_abridor=true en el snapshot
//                          mas reciente), en tandas -- 230 abridores x 1 fetch cada uno
//                          no entra en una sola invocacion, por eso pagina.
//   GET ?modo=pitcher&nombre=Fulano
//                       -> compatibilidad con el modo viejo, un lanzador a la vez.
//
// Lo que NO se puede traer gratis por esta via (queda pendiente de carga manual):
// csw_pct, swstr_pct y chase_pct de pitcher_stats_snapshot -- el leaderboard de Savant
// acepta esos nombres de columna pero los devuelve vacios para todos los lanzadores.
// swing_pct y chase_pct de equipo_stats_split tambien (son metricas de Statcast, no de
// MLB Stats API, y Savant no tiene un leaderboard team-level con split de mano).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const ua = { "User-Agent": "Mozilla/5.0 (compatible; StrikeoutLabBot/1.0)" };
const TEMPORADA = "2026";

// El MLB Stats API usa abreviaciones propias distintas a las que ya
// se usan en la tabla `picks` de la app; se normalizan aqui.
const ALIAS_EQUIPO: Record<string, string> = { AZ: "ARI", CWS: "CHW" };
function normalizarEquipo(abrev: string): string {
  return ALIAS_EQUIPO[abrev] ?? abrev;
}

// "161.1" (notacion de beisbol: entradas.outs) -> 161 + 1/3, decimal real.
function ipRealDecimal(ipTexto: string): number {
  const [entradas, outs] = ipTexto.split(".");
  const base = Number(entradas) || 0;
  const fraccion = outs === "1" ? 1 / 3 : outs === "2" ? 2 / 3 : 0;
  return base + fraccion;
}

function parseCsvLine(linea: string): string[] {
  const campos: string[] = [];
  let actual = "";
  let dentroComillas = false;
  for (const c of linea) {
    if (c === '"') dentroComillas = !dentroComillas;
    else if (c === "," && !dentroComillas) {
      campos.push(actual);
      actual = "";
    } else actual += c;
  }
  campos.push(actual);
  return campos;
}

async function buscarPitcherPorNombre(nombre: string) {
  const resp = await fetch(`https://statsapi.mlb.com/api/v1/sports/1/players?season=${TEMPORADA}`, { headers: ua });
  const datos = await resp.json();
  const buscado = nombre.trim().toLowerCase();
  const persona = (datos.people ?? []).find((p: any) => (p.fullName ?? "").toLowerCase() === buscado);
  return persona ? { id: persona.id as number, nombreCompleto: persona.fullName as string } : null;
}

async function statsTemporadaPitcher(id: number) {
  const resp = await fetch(
    `https://statsapi.mlb.com/api/v1/people?personIds=${id}&hydrate=stats(type=[season],group=[pitching],season=${TEMPORADA})`,
    { headers: ua },
  );
  const datos = await resp.json();
  const stat = datos.people?.[0]?.stats?.[0]?.splits?.[0]?.stat;
  if (!stat) return null;
  const bf = stat.battersFaced ?? 0;
  const k = stat.strikeOuts ?? 0;
  return {
    k_pct: bf > 0 ? Number(((k / bf) * 100).toFixed(1)) : null,
    k_9: stat.strikeoutsPer9Inn ? Number(stat.strikeoutsPer9Inn) : null,
    whip: stat.whip ? Number(stat.whip) : null,
    ip: stat.inningsPitched ? Number(stat.inningsPitched) : null,
  };
}

async function whiffPctSavant(id: number) {
  const url =
    `https://baseballsavant.mlb.com/leaderboard/custom?year=${TEMPORADA}&type=pitcher&filter=&min=1` +
    `&selections=whiff_percent&chart=false&x=whiff_percent&y=whiff_percent&r=no&chartType=beeswarm` +
    `&sort=whiff_percent&sortDir=desc&csv=true`;
  const resp = await fetch(url, { headers: ua });
  const texto = await resp.text();
  const lineas = texto.split("\n").filter((l) => l.trim().length > 0);
  for (let i = 1; i < lineas.length; i++) {
    const campos = parseCsvLine(lineas[i]);
    if (Number(campos[1]) === id) {
      return campos[3] ? Number(campos[3]) : null;
    }
  }
  return null;
}

async function sincronizarEquipos(supabase: ReturnType<typeof createClient>) {
  const respEquipos = await fetch(`https://statsapi.mlb.com/api/v1/teams?sportId=1&season=${TEMPORADA}`, { headers: ua });
  const datosEquipos = await respEquipos.json();
  const hoy = new Date().toISOString().slice(0, 10);
  const resultados = [];
  for (const equipo of datosEquipos.teams ?? []) {
    try {
      const respStats = await fetch(
        `https://statsapi.mlb.com/api/v1/teams/${equipo.id}/stats?stats=season&group=hitting&season=${TEMPORADA}`,
        { headers: ua },
      );
      const datosStats = await respStats.json();
      const stat = datosStats.stats?.[0]?.splits?.[0]?.stat;
      if (!stat) {
        resultados.push({ equipo: equipo.abbreviation, ok: false, error: "sin stats" });
        continue;
      }
      const { error } = await supabase.from("team_k").upsert(
        {
          equipo: normalizarEquipo(equipo.abbreviation),
          ventana: "TEMPORADA",
          k: stat.strikeOuts,
          pa: stat.plateAppearances,
          fecha_corte: hoy,
        },
        { onConflict: "equipo,ventana,fecha_corte" },
      );
      resultados.push({ equipo: normalizarEquipo(equipo.abbreviation), ok: !error, error: error?.message });
    } catch (e) {
      resultados.push({ equipo: equipo.abbreviation, ok: false, error: (e as Error).message });
    }
  }
  return resultados;
}

// K% del equipo rival por mano del lanzador. La clave es stats=statSplits (NO
// stats=season) combinado con sitCodes=vr/vl -- se probo primero con stats=season y
// devolvia el total de temporada igual con o sin sitCodes, sin aplicar ningun split.
async function sincronizarSplits(supabase: ReturnType<typeof createClient>) {
  const respEquipos = await fetch(`https://statsapi.mlb.com/api/v1/teams?sportId=1&season=${TEMPORADA}`, { headers: ua });
  const datosEquipos = await respEquipos.json();
  const hoy = new Date().toISOString().slice(0, 10);
  const filas = [];
  const errores = [];
  for (const equipo of datosEquipos.teams ?? []) {
    for (const [sitCode, vsMano] of [["vl", "LHP"], ["vr", "RHP"]] as const) {
      try {
        const resp = await fetch(
          `https://statsapi.mlb.com/api/v1/teams/${equipo.id}/stats?stats=statSplits&group=hitting&season=${TEMPORADA}&sitCodes=${sitCode}`,
          { headers: ua },
        );
        const datos = await resp.json();
        const stat = datos.stats?.[0]?.splits?.[0]?.stat;
        if (!stat) {
          errores.push({ equipo: equipo.abbreviation, vs_mano: vsMano, error: "sin stats" });
          continue;
        }
        const bf = stat.plateAppearances ?? 0;
        filas.push({
          equipo: normalizarEquipo(equipo.abbreviation),
          ventana: "TEMPORADA",
          vs_mano: vsMano,
          k_pct: bf > 0 ? Number(((stat.strikeOuts / bf) * 100).toFixed(1)) : null,
          fecha_corte: hoy,
          fuente: "MLB Stats API (automatico, stats=statSplits)",
        });
      } catch (e) {
        errores.push({ equipo: equipo.abbreviation, vs_mano: vsMano, error: (e as Error).message });
      }
    }
  }
  const { error } = await supabase
    .from("equipo_stats_split")
    .upsert(filas, { onConflict: "equipo,ventana,vs_mano,fecha_corte" });
  return { total: filas.length, guardado: !error, error: error?.message, errores };
}

async function sincronizarPitcher(supabase: ReturnType<typeof createClient>, nombre: string) {
  const persona = await buscarPitcherPorNombre(nombre);
  if (!persona) return { error: `No se encontro a "${nombre}" en el roster ${TEMPORADA} de MLB. Revisa el nombre exacto (con acentos, tal como aparece oficialmente).` };

  const [stats, whiff_pct] = await Promise.all([statsTemporadaPitcher(persona.id), whiffPctSavant(persona.id)]);
  if (!stats) return { error: `${persona.nombreCompleto} no tiene stats de pitcheo registradas en ${TEMPORADA} todavia.` };

  const hoy = new Date().toISOString().slice(0, 10);
  const { error } = await supabase.from("pitcher_stats_snapshot").upsert(
    {
      pitcher: persona.nombreCompleto,
      fecha_corte: hoy,
      k_pct: stats.k_pct,
      whiff_pct,
      k_9: stats.k_9,
      whip: stats.whip,
      ip: stats.ip,
      fuente: "MLB Stats API + Baseball Savant (automatico)",
    },
    { onConflict: "pitcher,fecha_corte" },
  );

  return { pitcher: persona.nombreCompleto, id: persona.id, ...stats, whiff_pct, guardado: !error, error: error?.message };
}

// Todos los lanzadores con >=1 aparicion en la temporada, en dos fetches (no uno por
// jugador): el leaderboard de MLB Stats API con playerPool=all, y el CSV de whiff% de
// Baseball Savant. Reemplaza la fila del dia (fecha_corte=hoy) por lanzador.
async function sincronizarTodosLosPitchers(supabase: ReturnType<typeof createClient>) {
  const [respMlb, respSavant, respEquipos] = await Promise.all([
    fetch(
      `https://statsapi.mlb.com/api/v1/stats?stats=season&group=pitching&season=${TEMPORADA}&sportId=1&limit=3000&gameType=R&playerPool=all`,
      { headers: ua },
    ),
    fetch(
      `https://baseballsavant.mlb.com/leaderboard/custom?year=${TEMPORADA}&type=pitcher&filter=&min=1` +
        `&selections=whiff_percent&chart=false&x=whiff_percent&y=whiff_percent&r=no&chartType=beeswarm` +
        `&sort=whiff_percent&sortDir=desc&csv=true`,
      { headers: ua },
    ),
    fetch(`https://statsapi.mlb.com/api/v1/teams?sportId=1&season=${TEMPORADA}`, { headers: ua }),
  ]);

  const datosMlb = await respMlb.json();
  const textoSavant = await respSavant.text();
  const datosEquipos = await respEquipos.json();

  const equipoPorId = new Map<number, string>(
    (datosEquipos.teams ?? []).map((e: any) => [e.id, normalizarEquipo(e.abbreviation)]),
  );

  const whiffPorId = new Map<number, number>();
  const lineasSavant = textoSavant.split("\n").filter((l) => l.trim().length > 0);
  for (let i = 1; i < lineasSavant.length; i++) {
    const campos = parseCsvLine(lineasSavant[i]);
    const id = Number(campos[1]);
    if (id && campos[3]) whiffPorId.set(id, Number(campos[3]));
  }

  const splits = datosMlb.stats?.[0]?.splits ?? [];
  // Un lanzador cambiado de equipo a mitad de temporada puede salir dos veces; nos
  // quedamos con el registro de mas apariciones (el mas representativo).
  const porNombre = new Map<string, any>();
  for (const s of splits) {
    const previo = porNombre.get(s.player?.fullName);
    if (!previo || (s.stat?.gamesPitched ?? 0) > (previo.stat?.gamesPitched ?? 0)) {
      porNombre.set(s.player?.fullName, s);
    }
  }

  const hoy = new Date().toISOString().slice(0, 10);
  const filas = [];
  for (const s of porNombre.values()) {
    const stat = s.stat ?? {};
    const bf = stat.battersFaced ?? 0;
    const k = stat.strikeOuts ?? 0;
    const starts = stat.gamesStarted ?? 0;
    const apariciones = stat.gamesPitched ?? 0;
    const ipTexto = stat.inningsPitched;
    const ipReal = ipTexto ? ipRealDecimal(ipTexto) : null;
    filas.push({
      pitcher: s.player?.fullName,
      fecha_corte: hoy,
      k_pct: bf > 0 ? Number(((k / bf) * 100).toFixed(1)) : null,
      whiff_pct: whiffPorId.get(s.player?.id) ?? null,
      k_9: stat.strikeoutsPer9Inn ? Number(stat.strikeoutsPer9Inn) : null,
      whip: stat.whip ? Number(stat.whip) : null,
      ip: ipTexto ? Number(ipTexto) : null,
      ip_por_salida: ipReal != null
        ? Number((ipReal / (starts > 0 ? starts : apariciones || 1)).toFixed(2))
        : null,
      salidas: apariciones,
      es_abridor: apariciones > 0 && starts / apariciones >= 0.5,
      equipo: equipoPorId.get(s.team?.id) ?? null,
      mlb_id: s.player?.id ?? null,
      fuente: "MLB Stats API + Baseball Savant (automatico, sin filtro Qualified)",
    });
  }

  const { error } = await supabase.from("pitcher_stats_snapshot").upsert(filas, { onConflict: "pitcher,fecha_corte" });
  return { total: filas.length, con_whiff: filas.filter((f) => f.whiff_pct != null).length, guardado: !error, error: error?.message };
}

// Agrega a game_logs las salidas nuevas de los abridores ya identificados, en tandas
// de `limite` (una por fetch cada una), para no pasarse del tiempo de una invocacion.
async function sincronizarSalidas(supabase: ReturnType<typeof createClient>, offset: number, limite: number) {
  const { data: abridores, error: errorAbridores } = await supabase
    .from("pitcher_stats_snapshot")
    .select("pitcher, mlb_id")
    .eq("es_abridor", true)
    .not("mlb_id", "is", null)
    .order("fecha_corte", { ascending: false })
    .limit(5000);
  if (errorAbridores) return { error: errorAbridores.message };

  const vistos = new Set<number>();
  const unicos = (abridores ?? []).filter((a) => {
    if (!a.mlb_id || vistos.has(a.mlb_id)) return false;
    vistos.add(a.mlb_id);
    return true;
  });
  const tanda = unicos.slice(offset, offset + limite);

  const { data: equiposData } = await supabase.from("equipos_mlb").select("mlb_id, abreviatura");
  const equipoPorId = new Map<number, string>((equiposData ?? []).map((e: any) => [e.mlb_id, e.abreviatura]));

  const filas = [];
  const errores = [];
  for (const a of tanda) {
    try {
      const resp = await fetch(
        `https://statsapi.mlb.com/api/v1/people/${a.mlb_id}/stats?stats=gameLog&group=pitching&season=${TEMPORADA}`,
        { headers: ua },
      );
      const datos = await resp.json();
      for (const g of datos.stats?.[0]?.splits ?? []) {
        filas.push({
          pitcher: g.player?.fullName ?? a.pitcher,
          fecha: g.date,
          rival: equipoPorId.get(g.opponent?.id) ?? g.opponent?.name,
          ip: g.stat?.inningsPitched ? Number(g.stat.inningsPitched) : null,
          k: g.stat?.strikeOuts ?? null,
          bb: g.stat?.baseOnBalls ?? null,
          pitcheos: g.stat?.numberOfPitches ?? null,
          es_local: g.isHome ?? null,
          game_pk: g.game?.gamePk ?? null,
        });
      }
    } catch (e) {
      errores.push({ pitcher: a.pitcher, error: (e as Error).message });
    }
  }

  // game_logs deduplica por game_pk con un indice unico PARCIAL (WHERE game_pk IS NOT
  // NULL); un upsert() de supabase-js no puede mandar ese WHERE como arbitro de ON
  // CONFLICT, asi que el insert real lo hace esta funcion de Postgres (ver migracion
  // funcion_insertar_salidas_game_logs).
  const { data: insertadas, error } = await supabase.rpc("insertar_salidas_game_logs", { filas });

  return {
    procesados: tanda.length,
    siguiente_offset: offset + limite < unicos.length ? offset + limite : null,
    total_abridores: unicos.length,
    filas_intentadas: filas.length,
    filas_nuevas_insertadas: insertadas,
    guardado: !error,
    error: error?.message,
    errores_por_pitcher: errores,
  };
}

Deno.serve(async (req: Request) => {
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const url = new URL(req.url);
  const modo = url.searchParams.get("modo");

  if (modo === "equipos") {
    const resultados = await sincronizarEquipos(supabase);
    return new Response(JSON.stringify({ resultados }, null, 2), { headers: { "Content-Type": "application/json" } });
  }

  if (modo === "splits") {
    const resultado = await sincronizarSplits(supabase);
    return new Response(JSON.stringify(resultado, null, 2), { headers: { "Content-Type": "application/json" } });
  }

  if (modo === "pitchers") {
    const resultado = await sincronizarTodosLosPitchers(supabase);
    return new Response(JSON.stringify(resultado, null, 2), { headers: { "Content-Type": "application/json" } });
  }

  if (modo === "salidas") {
    const offset = Number(url.searchParams.get("offset") ?? "0");
    const limite = Number(url.searchParams.get("limite") ?? "60");
    const resultado = await sincronizarSalidas(supabase, offset, limite);
    return new Response(JSON.stringify(resultado, null, 2), { headers: { "Content-Type": "application/json" } });
  }

  if (modo === "pitcher") {
    const nombre = url.searchParams.get("nombre");
    if (!nombre) return new Response(JSON.stringify({ error: "falta ?nombre=" }), { status: 400 });
    const resultado = await sincronizarPitcher(supabase, nombre);
    return new Response(JSON.stringify(resultado, null, 2), { headers: { "Content-Type": "application/json" } });
  }

  return new Response(
    JSON.stringify({ error: "usa ?modo=equipos, ?modo=splits, ?modo=pitchers, ?modo=salidas&offset=0&limite=60, o ?modo=pitcher&nombre=Nombre+Completo" }),
    { status: 400, headers: { "Content-Type": "application/json" } },
  );
});
