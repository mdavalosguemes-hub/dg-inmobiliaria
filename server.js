// ============================================================
// Servidor DG Inmobiliaria
// - Guarda TODOS los datos de la app en una base de datos
//   Postgres real (Neon), separada del servidor que corre acá.
// - Sirve también la página inmobiliaria.html.
// ============================================================
const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const XLSX = require('xlsx');

// Datos base (la "foto" original de propiedades/propietarios/inquilinos con la
// que arrancó la app). Los cambios reales viven en Neon (prop_overrides, etc.)
// y se combinan con esto, igual que hace el navegador.
const BASE_DATA = JSON.parse(fs.readFileSync(path.join(__dirname, 'base-data.json'), 'utf8'));

// Mismos conceptos que usa el formulario de Recibos en la web.
const CONCEPTOS_RECIBO = ['Alquiler','Gastos administrativos','Punitorios','Municipal (TGI)','Inmobiliario (API)','Aguas Provinciales','Luz (EPE)','Gas (Litoral Gas)','Expensas','Seguro','Otro','Honorarios','Sellado','Averiguaciones'];

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('Falta la variable de entorno DATABASE_URL (el connection string de Neon).');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS kv_store (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS counters (
      key TEXT PRIMARY KEY,
      value INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS released_numbers (
      key TEXT NOT NULL,
      number INTEGER NOT NULL,
      PRIMARY KEY (key, number)
    );
    CREATE TABLE IF NOT EXISTS mp_pendientes (
      id TEXT PRIMARY KEY,
      fecha DATE,
      tipo TEXT,
      monto NUMERIC,
      descripcion TEXT,
      entidad TEXT,
      medio_sugerido TEXT,
      cuenta_contraparte_id TEXT,
      carpeta_sugerida TEXT,
      estado TEXT NOT NULL DEFAULT 'pendiente',
      raw JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE mp_pendientes ADD COLUMN IF NOT EXISTS cuenta_contraparte_id TEXT;
    ALTER TABLE mp_pendientes ADD COLUMN IF NOT EXISTS carpeta_sugerida TEXT;
    CREATE TABLE IF NOT EXISTS mp_cuentas_conocidas (
      id_cuenta_mp TEXT PRIMARY KEY,
      tipo TEXT NOT NULL,
      nombre TEXT,
      carpeta TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS mp_sync_estado (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS users (
      email TEXT PRIMARY KEY,
      name TEXT,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Usuarios por defecto (para poder entrar la primera vez)
  const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM users');
  if (rows[0].c === 0) {
    const DEFAULT_USERS = [
      { email: 'admin@dginmo.com', name: 'Admin', password: 'dginmo2024', role: 'admin' },
      { email: 'martin@dginmo.com', name: 'Martín', password: 'alvarito22', role: 'admin' },
      { email: 'mdavalosguemes@gmail.com', name: 'Martín', password: 'alvarito22', role: 'admin' },
      { email: 'mmdguemes@gmail.com', name: 'Martín', password: 'alvarito22', role: 'admin' },
    ];
    for (const u of DEFAULT_USERS) {
      await pool.query(
        'INSERT INTO users (email, name, password_hash, role) VALUES ($1,$2,$3,$4) ON CONFLICT (email) DO NOTHING',
        [u.email, u.name, bcrypt.hashSync(u.password, 10), u.role]
      );
    }
    console.log('Usuarios por defecto creados:', DEFAULT_USERS.map(u => u.email).join(', '));
  }

  // Importar seed-data.json solo si la base está vacía (primera vez)
  const seedPath = path.join(__dirname, 'seed-data.json');
  if (fs.existsSync(seedPath)) {
    const { rows: kvCount } = await pool.query('SELECT COUNT(*)::int AS c FROM kv_store');
    if (kvCount[0].c === 0) {
      try {
        const raw = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
        const datos = raw.datos || raw;
        for (const [key, value] of Object.entries(datos)) {
          await pool.query(
            'INSERT INTO kv_store (key, value, updated_at) VALUES ($1,$2,now()) ' +
            'ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()',
            [key, JSON.stringify(value)]
          );
        }
        console.log(`Backup inicial importado desde seed-data.json (${Object.keys(datos).length} colecciones).`);
      } catch (e) {
        console.warn('No se pudo importar seed-data.json:', e.message);
      }
    }
  }
}

// ============================================================
const app = express();
app.use(cors());
app.use(express.json({ limit: '25mb' }));

app.get('/api/get', async (req, res) => {
  const { key } = req.query;
  if (!key) return res.status(400).json({ ok: false, error: 'Falta key' });
  const { rows } = await pool.query('SELECT value FROM kv_store WHERE key = $1', [key]);
  res.json({ value: rows[0] ? rows[0].value : null });
});

// ============================================================
// FUSIÓN INTELIGENTE (registro por registro) para evitar pérdida de datos
// cuando dos personas guardan casi al mismo tiempo desde PCs distintas.
//
// Antes: cada guardado reemplazaba la colección ENTERA en la base de datos.
// Si una PC tenía una copia un poco vieja (por ejemplo, sin el último recibo
// que acababa de cargar la otra PC) y guardaba cualquier cosa, esa lista
// vieja pisaba y borraba lo que la otra PC había guardado recién.
//
// Ahora: para colecciones que son un array de objetos con "id" (recibos,
// liquidaciones, caja, ajustes, etc.), antes de guardar se compara registro
// por registro contra lo que ya hay en la base:
//   - Un registro que está en la base pero no llegó en este guardado -> se
//     conserva (nunca se pierde solo porque el otro lado no lo tenía).
//   - Un mismo registro (mismo "id") editado en las dos PCs -> gana el que
//     tenga la marca de tiempo (_updatedAt) más nueva.
//   - Los borrados son "borrados suaves" (el registro llega con
//     _deleted:true): así un borrado real no se puede "revivir" solo porque
//     la otra PC todavía tenía la versión vieja sin ese borrado.
// ============================================================
function esColeccionFusionable(value) {
  return Array.isArray(value) && value.every(x => x && typeof x === 'object' && !Array.isArray(x) && 'id' in x);
}

function fusionarPorId(existentes, entrantes) {
  const mapa = new Map();
  for (const rec of existentes) {
    if (rec && rec.id !== undefined && rec.id !== null) mapa.set(String(rec.id), rec);
  }
  for (const rec of entrantes) {
    if (!rec || rec.id === undefined || rec.id === null) continue;
    const k = String(rec.id);
    const previo = mapa.get(k);
    const tsPrevio = (previo && previo._updatedAt) ? previo._updatedAt : 0;
    const tsEntrante = rec._updatedAt ? rec._updatedAt : 0;
    // Si el entrante es más nuevo (o el registro es nuevo), se queda con el
    // entrante. Si el que ya estaba guardado es más nuevo (lo actualizó la
    // otra PC mientras tanto), se conserva el que ya estaba.
    if (!previo || tsEntrante >= tsPrevio) mapa.set(k, rec);
  }
  return Array.from(mapa.values());
}

// Listas simples de valores (no objetos), ej. prop_deleted: un array de IDs
// borrados. No tienen "id" propio para fusionar por registro, así que se
// combinan por UNIÓN: cualquier valor que ya estuviera en el servidor o que
// venga en este guardado, queda. Así, una PC con una lista más vieja/corta
// nunca puede "revivir" un borrado que ya había hecho la otra PC.
function esArrayDePrimitivos(value) {
  return Array.isArray(value) && value.every(x => x === null || typeof x !== 'object');
}
function fusionarPorUnion(existentes, entrantes) {
  const set = new Set([...(Array.isArray(existentes) ? existentes : []), ...(Array.isArray(entrantes) ? entrantes : [])].map(String));
  return Array.from(set);
}

// Fusión profunda GENÉRICA para otros objetos anidados tipo diccionario que
// también corrían el mismo riesgo (ej. prop_overrides/owner_overrides/
// tenant_overrides: id -> {campos de esa propiedad/propietario/inquilino}).
// Cualquier id que ya existía y no vino en este guardado se conserva.
function fusionarObjetoProfundo(existente, entrante) {
  if (!esObjetoPlano(entrante)) return entrante; // valor final (numero/texto/etc): gana el entrante
  const base = esObjetoPlano(existente) ? existente : {};
  const resultado = Object.assign({}, base);
  for (const [k, v] of Object.entries(entrante)) {
    resultado[k] = fusionarObjetoProfundo(base[k], v);
  }
  return resultado;
}

// ============================================================
// NUMERACIÓN ATÓMICA (ej. números de recibo por mes)
// Antes: cada PC calculaba "el próximo número" mirando su propia copia de
// los datos -> si dos personas abrían "Nuevo Recibo" casi al mismo tiempo,
// las dos calculaban el mismo número y se pisaban.
// Ahora: el servidor lleva un contador POR PREFIJO (ej. "2026-09-") en la
// base de datos, y lo incrementa de forma atómica (una sola consulta SQL
// que no puede ejecutarse "a medias" ni pisarse entre dos pedidos
// simultáneos), así que nunca puede haber dos números iguales.
//
// Además, cuando se borra un recibo, su número se guarda en
// "released_numbers" (una bolsa de huecos reutilizables). Al pedir un
// número nuevo, PRIMERO se busca ahí el más chico disponible (también de
// forma atómica, con SELECT ... FOR UPDATE SKIP LOCKED, para que dos
// pedidos simultáneos nunca se lleven el mismo hueco) y recién si no hay
// ninguno liberado se sigue con el correlativo de siempre. Así, borrar un
// recibo y crear uno nuevo reutiliza el número, sin dejar saltos.
// ============================================================
app.post('/api/next-number', async (req, res) => {
  const { prefix, seedFrom } = req.body || {};
  if (!prefix) return res.status(400).json({ ok: false, error: 'Falta prefix' });
  const key = 'recibo:' + prefix;

  // 1) ¿Hay algún número liberado (de un recibo borrado) esperando? Se toma
  // el más chico, de forma atómica.
  const liberado = await pool.query(
    `WITH picked AS (
       SELECT number FROM released_numbers
       WHERE key = $1
       ORDER BY number
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     DELETE FROM released_numbers
     WHERE key = $1 AND number IN (SELECT number FROM picked)
     RETURNING number`,
    [key]
  );
  if (liberado.rows.length > 0) {
    return res.json({ ok: true, next: liberado.rows[0].number });
  }

  // 2) No hay ninguno liberado: sigue el correlativo de siempre.
  const semilla = Number.isInteger(seedFrom) ? seedFrom : 0;
  const { rows } = await pool.query(
    `INSERT INTO counters (key, value) VALUES ($1, $2 + 1)
     ON CONFLICT (key) DO UPDATE SET value = GREATEST(counters.value, $2) + 1
     RETURNING value`,
    [key, semilla]
  );
  res.json({ ok: true, next: rows[0].value });
});

// Libera un número (por ejemplo, al borrar un recibo) para que el próximo
// /api/next-number lo pueda volver a entregar.
app.post('/api/release-number', async (req, res) => {
  const { prefix, number } = req.body || {};
  if (!prefix || !Number.isInteger(number)) {
    return res.status(400).json({ ok: false, error: 'Faltan prefix/number' });
  }
  const key = 'recibo:' + prefix;
  await pool.query(
    'INSERT INTO released_numbers (key, number) VALUES ($1,$2) ON CONFLICT DO NOTHING',
    [key, number]
  );
  res.json({ ok: true });
});

// Diagnóstico: ver el estado real del contador y la bolsa de liberados para
// un prefijo (ej. GET /api/debug-counter?prefix=2026-09-), sin tocar nada.
app.get('/api/debug-counter', async (req, res) => {
  const { prefix } = req.query;
  if (!prefix) return res.status(400).json({ ok: false, error: 'Falta prefix' });
  const key = 'recibo:' + prefix;
  const { rows: c } = await pool.query('SELECT value FROM counters WHERE key = $1', [key]);
  const { rows: r } = await pool.query('SELECT number FROM released_numbers WHERE key = $1 ORDER BY number', [key]);
  res.json({
    ok: true,
    key,
    contador_actual: c[0] ? c[0].value : null,
    proximo_si_no_hay_liberados: c[0] ? c[0].value + 1 : 1,
    liberados_disponibles: r.map(x => x.number)
  });
});

// "Reclama" un número que se escribió a mano (en vez de pedírselo al
// servidor con /api/next-number): lo saca de la bolsa de liberados si
// estaba ahí (para que no se lo vuelva a ofrecer a otro recibo), y sube el
// contador si hace falta, para que el próximo automático siga desde ahí.
app.post('/api/claim-number', async (req, res) => {
  const { prefix, number } = req.body || {};
  if (!prefix || !Number.isInteger(number)) {
    return res.status(400).json({ ok: false, error: 'Faltan prefix/number' });
  }
  const key = 'recibo:' + prefix;
  await pool.query('DELETE FROM released_numbers WHERE key = $1 AND number = $2', [key, number]);
  await pool.query(
    `INSERT INTO counters (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = GREATEST(counters.value, $2)`,
    [key, number]
  );
  res.json({ ok: true });
});

// ============================================================
// FUSIÓN PROFUNDA para "valores_historicos" (carpeta -> año -> mes -> valor)
// Esta colección NO es un array con "id", así que no la cubre la fusión de
// arriba -> hasta ahora se pisaba entera con cada guardado, exactamente
// como pasaba antes con recibos/liquidaciones. Acá se fusiona celda por
// celda: si el valor que llega para una celda está vacío/ausente pero el
// servidor ya tenía uno cargado, se conserva el que ya estaba (nunca se
// pierde un valor histórico ya cargado solo porque otra PC tenía una copia
// vieja/incompleta). Si el valor que llega SÍ trae algo, se usa ese
// (se asume que es una edición real y más reciente).
// ============================================================
function esObjetoPlano(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
function esVacio(v) {
  return v === undefined || v === null || v === '';
}
function fusionarValoresHistoricos(existente, entrante) {
  if (!esObjetoPlano(entrante)) return existente;
  if (!esObjetoPlano(existente)) return entrante;
  const resultado = { ...existente };
  for (const carpeta of Object.keys(entrante)) {
    const aniosEntrante = entrante[carpeta];
    if (!esObjetoPlano(aniosEntrante)) continue;
    resultado[carpeta] = { ...(esObjetoPlano(resultado[carpeta]) ? resultado[carpeta] : {}) };
    for (const anio of Object.keys(aniosEntrante)) {
      const mesesEntrante = aniosEntrante[anio];
      if (!esObjetoPlano(mesesEntrante)) continue;
      resultado[carpeta][anio] = { ...(esObjetoPlano(resultado[carpeta][anio]) ? resultado[carpeta][anio] : {}) };
      for (const mes of Object.keys(mesesEntrante)) {
        const valorEntrante  = mesesEntrante[mes];
        const valorExistente = resultado[carpeta][anio][mes];
        if (esVacio(valorEntrante) && !esVacio(valorExistente)) continue; // conservar lo que ya había
        resultado[carpeta][anio][mes] = valorEntrante;
      }
    }
  }
  return resultado;
}

// Guarda un valor en kv_store aplicando la misma fusión segura que usa
// /api/set (por id, por objeto anidado, o por unión simple, según
// corresponda), y devuelve el valor final ya fusionado. Se usa tanto desde
// el endpoint /api/set como internamente (ej. al aprobar un movimiento de
// Mercado Pago hacia Caja), para que ambos caminos sean igual de seguros.
async function guardarConFusion(key, value) {
  let valorFinal = value;
  const CLAVES_OBJETO_FUSIONABLE = ['prop_overrides', 'owner_overrides', 'tenant_overrides'];
  const CLAVES_UNION_SIMPLE = ['prop_deleted'];
  if (esColeccionFusionable(value)) {
    const { rows } = await pool.query('SELECT value FROM kv_store WHERE key = $1', [key]);
    const existentes = Array.isArray(rows[0] && rows[0].value) ? rows[0].value : [];
    valorFinal = fusionarPorId(existentes, value);
  } else if (key === 'valores_historicos') {
    const { rows } = await pool.query('SELECT value FROM kv_store WHERE key = $1', [key]);
    const existente = esObjetoPlano(rows[0] && rows[0].value) ? rows[0].value : {};
    valorFinal = fusionarValoresHistoricos(existente, value);
  } else if (CLAVES_OBJETO_FUSIONABLE.includes(key) && esObjetoPlano(value)) {
    const { rows } = await pool.query('SELECT value FROM kv_store WHERE key = $1', [key]);
    const existente = esObjetoPlano(rows[0] && rows[0].value) ? rows[0].value : {};
    valorFinal = fusionarObjetoProfundo(existente, value);
  } else if (CLAVES_UNION_SIMPLE.includes(key) && esArrayDePrimitivos(value)) {
    const { rows } = await pool.query('SELECT value FROM kv_store WHERE key = $1', [key]);
    const existentes = Array.isArray(rows[0] && rows[0].value) ? rows[0].value : [];
    valorFinal = fusionarPorUnion(existentes, value);
  }
  await pool.query(
    'INSERT INTO kv_store (key, value, updated_at) VALUES ($1,$2,now()) ' +
    'ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()',
    [key, JSON.stringify(valorFinal ?? null)]
  );
  return valorFinal;
}

app.post('/api/set', async (req, res) => {
  const { key, value } = req.body || {};
  if (!key) return res.status(400).json({ ok: false, error: 'Falta key' });
  const valorFinal = await guardarConFusion(key, value);
  // Devolvemos el valor final (ya fusionado) para que el navegador que guardó
  // pueda actualizar su copia local con cualquier registro que haya sumado
  // la fusión (por ejemplo, algo que había cargado la otra PC).
  res.json({ ok: true, value: valorFinal });
});

app.get('/api/all', async (req, res) => {
  const { rows } = await pool.query('SELECT key, value FROM kv_store');
  const data = {};
  for (const r of rows) data[r.key] = r.value;
  res.json({ ok: true, data });
});

// Importación masiva (usada al restaurar un backup .json desde la web)
app.post('/api/import', async (req, res) => {
  const { data } = req.body || {};
  if (!data || typeof data !== 'object') return res.status(400).json({ ok: false, error: 'Falta data' });
  for (const [key, value] of Object.entries(data)) {
    await pool.query(
      'INSERT INTO kv_store (key, value, updated_at) VALUES ($1,$2,now()) ' +
      'ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()',
      [key, JSON.stringify(value)]
    );
  }
  res.json({ ok: true, imported: Object.keys(data).length });
});

app.get('/api/backup', async (req, res) => {
  const { rows } = await pool.query('SELECT key, value FROM kv_store');
  const data = {};
  for (const r of rows) data[r.key] = r.value;
  res.json({ ok: true, data, file: 'backup_dg_inmo_' + new Date().toISOString().slice(0, 10) + '.json' });
});

// ============================================================
// EXPORTACIONES AUTOMÁTICAS (Propiedades mensual, Recibos semanal)
// Reconstruyen los mismos datos que ve la web (base + overrides guardados
// en Neon) y arman un Excel, para que una tarea programada en la PC del
// usuario pueda descargarlos solos, sin abrir el navegador.
// ============================================================
async function getKv(key, fallback) {
  const { rows } = await pool.query('SELECT value FROM kv_store WHERE key = $1', [key]);
  return rows[0] ? rows[0].value : fallback;
}

async function getMergedProps() {
  const overrides = await getKv('prop_overrides', {});
  const additions = await getKv('prop_additions', []);
  const deleted = new Set((await getKv('prop_deleted', [])).map(String));
  const base = BASE_DATA.INIT_PROPS.map((p, i) => {
    const id = 'p_' + i;
    return Object.assign({}, p, { id }, overrides[id] || {});
  }).filter(p => !deleted.has(String(p.id)));
  return base.concat(additions);
}

async function getMergedOwners() {
  const overrides = await getKv('owner_overrides', {});
  const additions = await getKv('owner_additions', []);
  const base = BASE_DATA.INIT_OWNERS.map(o => {
    const id = String(o.id || '').startsWith('o_') ? o.id : ('o_' + o.id);
    return Object.assign({}, o, { id }, overrides[id] || {});
  });
  return base.concat(additions);
}

function getOwnerNameFor(carpeta, owners) {
  for (const o of owners) {
    const cs = (o.carpetas || '').split(',').map(c => c.trim());
    if (cs.includes(String(carpeta))) return `${o.nombre || ''} ${o.apellido || ''}`.trim();
  }
  return '-';
}

// Convierte fechas guardadas en cualquier formato a un objeto Date real
// (para que Excel las reconozca como fecha), o '' si no hay/och es inválida.
function excelDate(v) {
  if (!v) return '';
  try {
    const clean = String(v).split('T')[0].split(' ')[0];
    let d;
    if (clean.includes('/')) {
      const [day, mon, yr] = clean.split('/');
      d = new Date(`${yr}-${mon.padStart(2, '0')}-${day.padStart(2, '0')}T00:00:00`);
    } else {
      d = new Date(clean + 'T00:00:00');
    }
    return isNaN(d) ? '' : d;
  } catch { return ''; }
}
function excelNum(v) {
  if (v === undefined || v === null || v === '') return '';
  const n = parseFloat(v);
  return isNaN(n) ? '' : n;
}

function sendXlsx(res, rows, filename) {
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Datos');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buf);
}

// GET /api/export/propiedades.xlsx  -> mismas columnas y orden que la pestaña Propiedades
app.get('/api/export/propiedades.xlsx', async (req, res) => {
  try {
    const props = (await getMergedProps()).filter(p => p.carpeta && p.carpeta !== '-');
    const owners = await getMergedOwners();
    const rows = props.map(p => ({
      'Carpeta': p.carpeta || '',
      'Dirección': p.direccion || '',
      'Tipo': p.tipo || '',
      'Inquilino': p.nombre_inq ? `${p.nombre_inq} ${p.apellido_inq || ''}`.trim() : '',
      'Estado': p.estado || '',
      'Alquiler actual': excelNum(p.alquiler),
      'Comisión': excelNum(p.comision),
      'Gs. Admin.': excelNum(p.gastos),
      'F. Inicio': excelDate(p.fecha_inicio),
      'Monto Inicial': excelNum(p.monto_inicial),
      'Ajuste': p.ajuste || '',
      'Próx. ajuste': excelDate(p.prox_act),
      'Fin contrato': excelDate(p.fecha_fin),
      'Propietario': getOwnerNameFor(p.carpeta, owners),
      'Observaciones': p.observaciones || ''
    }));
    sendXlsx(res, rows, 'Propiedades.xlsx');
  } catch (e) {
    console.error('Error exportando propiedades:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/export/recibos.xlsx?desde=YYYY-MM-DD&hasta=YYYY-MM-DD
// Sin parámetros, exporta TODOS los recibos. Con desde/hasta, filtra por fecha
// (para el archivo semanal).
app.get('/api/export/recibos.xlsx', async (req, res) => {
  try {
    let data = await getKv('recibo_data', []);
    data = data.filter(r => !r._deleted);
    const { desde, hasta } = req.query;
    if (desde) data = data.filter(r => r.fecha && r.fecha >= desde);
    if (hasta) data = data.filter(r => r.fecha && r.fecha <= hasta);
    const rows = data.map(r => {
      const row = {
        'Nro Recibo': r.numero || '',
        'Fecha': excelDate(r.fecha),
        'Carpeta': r.carpeta || '',
        'Locatario': r.locatario || '',
        'Domicilio': r.domicilio || '',
        'Período general': r.periodo || ''
      };
      CONCEPTOS_RECIBO.forEach(c => {
        row[c + ' - Período'] = (r.periodos && r.periodos[c]) ? r.periodos[c] : '';
        row[c + ' - Valor'] = (r.conceptos && r.conceptos[c]) ? excelNum(r.conceptos[c]) : '';
      });
      row['TOTAL'] = excelNum(r.total);
      return row;
    });
    const filename = (desde || hasta) ? `Recibos_${desde || 'inicio'}_a_${hasta || 'hoy'}.xlsx` : 'Recibos_Todos.xlsx';
    sendXlsx(res, rows, filename);
  } catch (e) {
    console.error('Error exportando recibos:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/export/backup.json -> backup completo, en el mismo formato que usa
// la web para "Importar backup" (por si algún día hay que restaurar desde acá).
app.get('/api/export/backup.json', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT key, value FROM kv_store');
    const datos = {};
    for (const r of rows) datos[r.key] = r.value;
    const backup = { version: 3, fecha: new Date().toISOString(), datos };
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="backup.json"');
    res.send(JSON.stringify(backup));
  } catch (e) {
    console.error('Error exportando backup:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---- Usuarios / login ----
app.get('/api/users', async (req, res) => {
  const { rows } = await pool.query('SELECT email, name, role, created_at FROM users ORDER BY created_at');
  res.json({ ok: true, users: rows });
});

app.get('/api/login', async (req, res) => {
  const { email, password } = req.query;
  if (!email || !password) return res.status(400).json({ ok: false, error: 'Faltan datos' });
  const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [String(email).toLowerCase()]);
  const user = rows[0];
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.json({ ok: false, error: 'Email o contraseña incorrectos' });
  }
  res.json({ ok: true, user: { name: user.name, role: user.role, email: user.email } });
});

app.post('/api/users/save', async (req, res) => {
  const { email, name, password, role } = req.body || {};
  if (!email) return res.status(400).json({ ok: false, error: 'Falta email' });
  const emailLc = String(email).toLowerCase();
  const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [emailLc]);
  const existing = rows[0];
  if (existing) {
    const newHash = password ? bcrypt.hashSync(password, 10) : existing.password_hash;
    await pool.query(
      'UPDATE users SET name=$1, password_hash=$2, role=$3 WHERE email=$4',
      [name || existing.name, newHash, role || existing.role, emailLc]
    );
  } else {
    if (!password) return res.status(400).json({ ok: false, error: 'Falta contraseña' });
    await pool.query(
      'INSERT INTO users (email, name, password_hash, role) VALUES ($1,$2,$3,$4)',
      [emailLc, name || '', bcrypt.hashSync(password, 10), role || 'user']
    );
  }
  res.json({ ok: true });
});

// ============================================================
// INTEGRACIÓN CON MERCADO PAGO (opcional)
// - Se activa SOLO si existe la variable de entorno MP_ACCESS_TOKEN en
//   Render. Si no está configurada, todo este bloque queda inactivo y el
//   resto del sistema sigue funcionando exactamente igual que siempre
//   (interruptor de apagado real: basta con borrar esa variable).
// - No carga nada directo a Caja: cada movimiento que trae de Mercado Pago
//   queda guardado en "mp_pendientes" hasta que alguien lo revisa y lo
//   aprueba manualmente desde la web (evita mezclar Reservas u otros
//   movimientos que no correspondan con la Caja real).
// ============================================================
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || '';
const MP_SYNC_INTERVALO_MS = 5 * 60 * 1000; // cada 5 minutos

async function mpObtenerEstado(key, fallback) {
  const { rows } = await pool.query('SELECT value FROM mp_sync_estado WHERE key = $1', [key]);
  return rows[0] ? rows[0].value : fallback;
}
async function mpGuardarEstado(key, value) {
  await pool.query(
    'INSERT INTO mp_sync_estado (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
    [key, value]
  );
}

// El id de la cuenta propia de Mercado Pago (para saber si un pago fue a
// favor o en contra: si el "collector" es esta cuenta -> Ingreso, si el
// "payer" es esta cuenta -> Egreso). Se pide una sola vez y se cachea en
// memoria, ya que no cambia.
let _mpMiCuentaId = null;
async function mpObtenerMiCuentaId() {
  if (_mpMiCuentaId) return _mpMiCuentaId;
  try {
    const resp = await fetch('https://api.mercadopago.com/users/me', {
      headers: { Authorization: 'Bearer ' + MP_ACCESS_TOKEN }
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    _mpMiCuentaId = data && data.id ? String(data.id) : null;
    return _mpMiCuentaId;
  } catch (e) {
    console.error('No se pudo obtener la cuenta propia de Mercado Pago:', e);
    return null;
  }
}

async function sincronizarMercadoPago() {
  if (!MP_ACCESS_TOKEN) return { ok: false, motivo: 'Sin MP_ACCESS_TOKEN configurado (integración apagada)' };
  try {
    const ahora = new Date();
    const desdeStr = await mpObtenerEstado('ultima_fecha_sincronizada', null);
    // Primera vez: traer solo los últimos 2 días, para no importar años de historial de una.
    const desde = desdeStr ? new Date(desdeStr) : new Date(ahora.getTime() - 2 * 24 * 60 * 60 * 1000);
    const miCuentaId = await mpObtenerMiCuentaId();

    const url = new URL('https://api.mercadopago.com/v1/payments/search');
    url.searchParams.set('sort', 'date_created');
    url.searchParams.set('criteria', 'asc');
    url.searchParams.set('range', 'date_created');
    url.searchParams.set('begin_date', desde.toISOString());
    url.searchParams.set('end_date', ahora.toISOString());
    url.searchParams.set('limit', '50');

    const resp = await fetch(url, { headers: { Authorization: 'Bearer ' + MP_ACCESS_TOKEN } });
    if (!resp.ok) {
      const textoError = await resp.text().catch(() => '');
      console.error('Mercado Pago respondió con error:', resp.status, textoError);
      return { ok: false, motivo: 'Mercado Pago respondió ' + resp.status };
    }
    const data = await resp.json();
    const pagos = (data && data.results) || [];

    let nuevos = 0;
    for (const p of pagos) {
      const id = String(p.id);
      const monto = Math.abs(parseFloat(p.transaction_amount) || 0);
      // Mercado Pago no siempre manda estos datos con la misma forma: a veces
      // vienen como objeto anidado (payer.id / collector.id) y a veces como
      // campo plano (payer_id / collector_id). Se contemplan las dos.
      const collectorId = (p.collector && p.collector.id != null) ? String(p.collector.id)
                         : (p.collector_id != null ? String(p.collector_id) : null);
      const payerId = (p.payer && p.payer.id != null) ? String(p.payer.id)
                     : (p.payer_id != null ? String(p.payer_id) : null);

      // Se compara contra la propia cuenta: si el que COBRA es esta cuenta,
      // es un Ingreso; si el que PAGA es esta cuenta, es un Egreso. Solo si
      // no se puede determinar (falta el dato o no coincide con ninguno de
      // los dos), se usa el signo del monto como último recurso.
      let tipoSugerido, cuentaContraparteId;
      if (miCuentaId && collectorId === miCuentaId) {
        tipoSugerido = 'ingreso'; cuentaContraparteId = payerId;
      } else if (miCuentaId && payerId === miCuentaId) {
        tipoSugerido = 'egreso'; cuentaContraparteId = collectorId;
      } else {
        tipoSugerido = (parseFloat(p.transaction_amount) || 0) >= 0 ? 'ingreso' : 'egreso';
        cuentaContraparteId = (tipoSugerido === 'ingreso') ? payerId : collectorId;
      }

      // Si esa cuenta ya fue identificada antes (por el usuario, en un
      // movimiento anterior), se completa sola la carpeta y el nombre.
      let entidad = '';
      let carpetaSugerida = '';
      let descripcion = p.description || p.operation_type || 'Movimiento de Mercado Pago';
      if (cuentaContraparteId) {
        const { rows: conocidas } = await pool.query(
          'SELECT * FROM mp_cuentas_conocidas WHERE id_cuenta_mp = $1', [cuentaContraparteId]
        );
        if (conocidas[0]) {
          entidad = conocidas[0].nombre || '';
          carpetaSugerida = conocidas[0].carpeta || '';
          descripcion = conocidas[0].tipo === 'otro' ? (conocidas[0].nombre || descripcion) : descripcion;
        }
      }

      await pool.query(
        `INSERT INTO mp_pendientes (id, fecha, tipo, monto, descripcion, entidad, medio_sugerido, cuenta_contraparte_id, carpeta_sugerida, raw)
         VALUES ($1,$2,$3,$4,$5,$6,'Transferencia',$7,$8,$9)
         ON CONFLICT (id) DO NOTHING`,
        [
          id,
          (p.date_created || ahora.toISOString()).slice(0, 10),
          tipoSugerido,
          monto,
          descripcion,
          entidad,
          cuentaContraparteId,
          carpetaSugerida,
          JSON.stringify(p)
        ]
      );
      nuevos++;
    }
    await mpGuardarEstado('ultima_fecha_sincronizada', ahora.toISOString());
    return { ok: true, revisados: pagos.length, nuevos };
  } catch (e) {
    console.error('Error sincronizando con Mercado Pago:', e);
    return { ok: false, motivo: e.message };
  }
}

// Sincroniza sola cada 5 minutos (si hay token configurado)
if (MP_ACCESS_TOKEN) {
  setInterval(sincronizarMercadoPago, MP_SYNC_INTERVALO_MS);
  setTimeout(sincronizarMercadoPago, 10000); // una primera pasada al arrancar el servidor
}

// GET /api/mp/estado -> si la integración está activa o no, y el resultado
// del último intento (para poder mostrar algo claro en la web)
app.get('/api/mp/estado', (req, res) => {
  res.json({ ok: true, activo: !!MP_ACCESS_TOKEN });
});

// POST /api/mp/sincronizar-ahora -> dispara una sincronización manual (para
// probar sin esperar los 5 minutos, o para forzar un refresco)
app.post('/api/mp/sincronizar-ahora', async (req, res) => {
  const resultado = await sincronizarMercadoPago();
  res.json(resultado);
});

// GET /api/mp/pendientes -> lista de movimientos todavía sin revisar
app.get('/api/mp/pendientes', async (req, res) => {
  const { rows } = await pool.query(
    "SELECT id, fecha, tipo, monto, descripcion, entidad, medio_sugerido, cuenta_contraparte_id, carpeta_sugerida FROM mp_pendientes WHERE estado = 'pendiente' ORDER BY fecha DESC, created_at DESC"
  );
  res.json({ ok: true, pendientes: rows });
});

// GET /api/mp/cuentas-conocidas -> cuentas de Mercado Pago que ya se
// identificaron antes (para mostrarlas si hace falta, o para no volver a
// preguntar por la misma cuenta)
app.get('/api/mp/cuentas-conocidas', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM mp_cuentas_conocidas ORDER BY created_at DESC');
  res.json({ ok: true, cuentas: rows });
});

// POST /api/mp/cuentas-conocidas -> guarda a qué inquilino, propietario u
// otra persona corresponde una cuenta de Mercado Pago, y actualiza con esos
// datos cualquier movimiento pendiente que ya hubiera llegado de esa misma
// cuenta (para que no haga falta identificarla dos veces).
app.post('/api/mp/cuentas-conocidas', async (req, res) => {
  const { id_cuenta_mp, tipo, nombre, carpeta } = req.body || {};
  if (!id_cuenta_mp || !tipo) return res.status(400).json({ ok: false, error: 'Faltan datos (id_cuenta_mp, tipo)' });
  await pool.query(
    `INSERT INTO mp_cuentas_conocidas (id_cuenta_mp, tipo, nombre, carpeta) VALUES ($1,$2,$3,$4)
     ON CONFLICT (id_cuenta_mp) DO UPDATE SET tipo = EXCLUDED.tipo, nombre = EXCLUDED.nombre, carpeta = EXCLUDED.carpeta`,
    [String(id_cuenta_mp), tipo, nombre || '', carpeta || '']
  );
  await pool.query(
    `UPDATE mp_pendientes SET entidad = $2, carpeta_sugerida = $3
     WHERE cuenta_contraparte_id = $1 AND estado = 'pendiente'`,
    [String(id_cuenta_mp), nombre || '', carpeta || '']
  );
  res.json({ ok: true });
});

// POST /api/mp/descartar -> lo marca como descartado (nunca entra a Caja)
app.post('/api/mp/descartar', async (req, res) => {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ ok: false, error: 'Falta id' });
  await pool.query("UPDATE mp_pendientes SET estado = 'descartado' WHERE id = $1", [String(id)]);
  res.json({ ok: true });
});

// POST /api/mp/aprobar -> confirma los datos (el usuario puede haberlos
// corregido: tipo, medio, concepto, carpeta, monto, obs) y recién ahí crea
// el movimiento real en Caja, usando la misma fusión segura de siempre.
app.post('/api/mp/aprobar', async (req, res) => {
  const { id, tipo, concepto, carpeta, monto, obs } = req.body || {};
  if (!id) return res.status(400).json({ ok: false, error: 'Falta id' });
  const { rows } = await pool.query('SELECT * FROM mp_pendientes WHERE id = $1', [String(id)]);
  const pendiente = rows[0];
  if (!pendiente) return res.status(404).json({ ok: false, error: 'No se encontr\u00f3 ese movimiento pendiente' });

  const { rows: cajaRows } = await pool.query("SELECT value FROM kv_store WHERE key = 'caja_data'");
  const cajaActual = Array.isArray(cajaRows[0] && cajaRows[0].value) ? cajaRows[0].value : [];
  const movimiento = {
    id: 'MP_' + pendiente.id,
    tipo: tipo || pendiente.tipo,
    fecha: pendiente.fecha instanceof Date ? pendiente.fecha.toISOString().slice(0, 10) : String(pendiente.fecha).slice(0, 10),
    // Un movimiento de Mercado Pago SIEMPRE es Transferencia (nunca puede
    // ser Efectivo): se ignora a propósito cualquier "medio" que llegue en
    // el pedido, para que esto no dependa de lo que mande el navegador.
    medio: 'Transferencia',
    concepto: concepto || pendiente.descripcion || 'Mercado Pago',
    carpeta: carpeta || pendiente.carpeta_sugerida || '',
    monto: monto !== undefined ? parseFloat(monto) : parseFloat(pendiente.monto),
    obs: (pendiente.entidad ? pendiente.entidad + ' \u00b7 ' : '') + (obs ? obs + ' \u00b7 ' : '') + 'Importado de Mercado Pago',
    origenMercadoPagoId: pendiente.id,
    _updatedAt: Date.now()
  };
  await guardarConFusion('caja_data', [...cajaActual, movimiento]);
  await pool.query("UPDATE mp_pendientes SET estado = 'aprobado' WHERE id = $1", [String(id)]);
  res.json({ ok: true, movimiento });
});

// ---- Servir la web (inmobiliaria.html) ----
app.use(express.static(__dirname));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'inmobiliaria.html'));
});

const PORT = process.env.PORT || 8765;
initSchema()
  .then(() => {
    app.listen(PORT, () => console.log(`Servidor DG Inmobiliaria escuchando en el puerto ${PORT}`));
  })
  .catch((e) => {
    console.error('Error inicializando la base de datos:', e);
    process.exit(1);
  });
