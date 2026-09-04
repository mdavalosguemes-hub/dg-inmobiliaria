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

app.post('/api/set', async (req, res) => {
  const { key, value } = req.body || {};
  if (!key) return res.status(400).json({ ok: false, error: 'Falta key' });

  let valorFinal = value;
  if (esColeccionFusionable(value)) {
    const { rows } = await pool.query('SELECT value FROM kv_store WHERE key = $1', [key]);
    const existentes = Array.isArray(rows[0] && rows[0].value) ? rows[0].value : [];
    valorFinal = fusionarPorId(existentes, value);
  }

  await pool.query(
    'INSERT INTO kv_store (key, value, updated_at) VALUES ($1,$2,now()) ' +
    'ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()',
    [key, JSON.stringify(valorFinal ?? null)]
  );
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
