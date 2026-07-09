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

app.post('/api/set', async (req, res) => {
  const { key, value } = req.body || {};
  if (!key) return res.status(400).json({ ok: false, error: 'Falta key' });
  await pool.query(
    'INSERT INTO kv_store (key, value, updated_at) VALUES ($1,$2,now()) ' +
    'ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()',
    [key, JSON.stringify(value ?? null)]
  );
  res.json({ ok: true });
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
