require('dotenv').config();
const express = require('express');
const { pool, ensureSchema, encryptPassword } = require('./db');
const { ejecutarScraping } = require('./lib/scrapeCore');

const app = express();
app.use(express.urlencoded({ extended: true }));

// --- Autenticación básica del panel (usuario/clave propios de la herramienta) ---
app.use((req, res, next) => {
  if (req.path === '/api/run-scrape') return next(); // usa su propio token, no auth básica
  const user = process.env.PANEL_USER || 'admin';
  const pass = process.env.PANEL_PASSWORD;
  if (!pass) return next(); // si no se configura, no bloquea (útil en desarrollo)

  const header = req.headers.authorization || '';
  const [, encoded] = header.split(' ');
  const decoded = encoded ? Buffer.from(encoded, 'base64').toString() : '';
  const [u, p] = decoded.split(':');

  if (u === user && p === pass) return next();
  res.set('WWW-Authenticate', 'Basic realm="Polar Monitor"');
  return res.status(401).send('Autenticación requerida');
});

const layout = (title, body) => `<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8"><title>${title} — Polar Monitor</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font-family: system-ui, sans-serif; margin: 0; background: #f4f5f7; color: #1a1a1a; }
  header { background: #111; color: #fff; padding: 14px 24px; display: flex; gap: 20px; align-items: center; }
  header a { color: #ccc; text-decoration: none; font-size: 14px; }
  header a.active, header a:hover { color: #fff; font-weight: 600; }
  main { padding: 24px; max-width: 1100px; margin: 0 auto; }
  h1 { font-size: 20px; }
  table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #eee; font-size: 14px; }
  th { background: #fafafa; font-weight: 600; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 12px; font-weight: 600; }
  .badge.alta { background: #dcfce7; color: #166534; }
  .badge.baja { background: #fee2e2; color: #991b1b; }
  .badge.cambio_estado { background: #fef9c3; color: #854d0e; }
  form.filtros { margin-bottom: 16px; display: flex; gap: 10px; flex-wrap: wrap; }
  form.filtros select, form.filtros input { padding: 6px 8px; border-radius: 6px; border: 1px solid #ccc; }
  .card { background: #fff; border-radius: 8px; padding: 16px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  button { background: #111; color: #fff; border: none; padding: 8px 14px; border-radius: 6px; cursor: pointer; }
</style></head>
<body>
<header>
  <strong>Polar Monitor</strong>
  <a href="/">Panel</a>
  <a href="/historial">Histórico de cambios</a>
  <a href="/tecnicos">Técnicos</a>
</header>
<main>${body}</main>
</body></html>`;

app.get('/', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT t.nombre, t.usuario, o.orden_externa_id, o.estado, o.ultima_vista
    FROM ordenes_trabajo o
    JOIN tecnicos t ON t.id = o.tecnico_id
    WHERE o.activa = TRUE
    ORDER BY t.nombre, o.ultima_vista DESC
  `);

  const { rows: ultimaEjecucion } = await pool.query(
    'SELECT * FROM runs_log ORDER BY iniciado_en DESC LIMIT 1'
  );

  const porTecnico = {};
  for (const r of rows) {
    porTecnico[r.nombre] = porTecnico[r.nombre] || [];
    porTecnico[r.nombre].push(r);
  }

  const bloques = Object.entries(porTecnico).map(([nombre, ordenes]) => `
    <div class="card">
      <h2>${nombre} <span style="font-weight:400;color:#666;font-size:14px">(${ordenes.length} órdenes activas)</span></h2>
      <table>
        <thead><tr><th>Orden</th><th>Estado</th><th>Última vez vista</th></tr></thead>
        <tbody>
          ${ordenes.map(o => `<tr><td>${o.orden_externa_id}</td><td>${o.estado || '—'}</td><td>${new Date(o.ultima_vista).toLocaleString('es-ES')}</td></tr>`).join('')}
        </tbody>
      </table>
    </div>
  `).join('') || '<p>Todavía no hay órdenes recogidas. Espera a la primera ejecución horaria, o añade técnicos si aún no hay ninguno.</p>';

  const info = ultimaEjecucion[0]
    ? `Última ejecución: ${new Date(ultimaEjecucion[0].iniciado_en).toLocaleString('es-ES')} — ${ultimaEjecucion[0].tecnicos_ok} OK, ${ultimaEjecucion[0].tecnicos_error} con error`
    : 'Todavía no se ha ejecutado el scraper.';

  res.send(layout('Panel', `<h1>Órdenes activas por técnico</h1><p style="color:#666">${info}</p>${bloques}`));
});

app.get('/historial', async (req, res) => {
  const { tecnico, tipo } = req.query;
  const condiciones = [];
  const params = [];
  if (tecnico) { params.push(tecnico); condiciones.push(`t.nombre = $${params.length}`); }
  if (tipo) { params.push(tipo); condiciones.push(`h.tipo_cambio = $${params.length}`); }
  const where = condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '';

  const { rows } = await pool.query(`
    SELECT h.*, t.nombre AS tecnico_nombre
    FROM historial_cambios h
    JOIN tecnicos t ON t.id = h.tecnico_id
    ${where}
    ORDER BY h.detectado_en DESC
    LIMIT 300
  `, params);

  const { rows: tecnicos } = await pool.query('SELECT DISTINCT nombre FROM tecnicos ORDER BY nombre');

  const filas = rows.map(r => `
    <tr>
      <td>${new Date(r.detectado_en).toLocaleString('es-ES')}</td>
      <td>${r.tecnico_nombre}</td>
      <td>${r.orden_externa_id}</td>
      <td><span class="badge ${r.tipo_cambio}">${r.tipo_cambio.replace('_', ' ')}</span></td>
      <td>${r.estado_anterior || '—'} → ${r.estado_nuevo || '—'}</td>
    </tr>`).join('');

  res.send(layout('Histórico', `
    <h1>Histórico de cambios</h1>
    <form class="filtros" method="get">
      <select name="tecnico">
        <option value="">Todos los técnicos</option>
        ${tecnicos.map(t => `<option value="${t.nombre}" ${tecnico === t.nombre ? 'selected' : ''}>${t.nombre}</option>`).join('')}
      </select>
      <select name="tipo">
        <option value="">Todos los tipos</option>
        <option value="alta" ${tipo === 'alta' ? 'selected' : ''}>Altas</option>
        <option value="baja" ${tipo === 'baja' ? 'selected' : ''}>Bajas</option>
        <option value="cambio_estado" ${tipo === 'cambio_estado' ? 'selected' : ''}>Cambios de estado</option>
      </select>
      <button type="submit">Filtrar</button>
    </form>
    <table>
      <thead><tr><th>Fecha</th><th>Técnico</th><th>Orden</th><th>Tipo</th><th>Cambio</th></tr></thead>
      <tbody>${filas || '<tr><td colspan="5">Sin resultados</td></tr>'}</tbody>
    </table>
  `));
});

app.get('/tecnicos', async (req, res) => {
  const { rows } = await pool.query('SELECT id, nombre, usuario, activo FROM tecnicos ORDER BY nombre');
  const filas = rows.map(t => `
    <tr>
      <td>${t.nombre}</td>
      <td>${t.usuario}</td>
      <td>${t.activo ? 'Activo' : 'Inactivo'}</td>
      <td>
        <form method="post" action="/tecnicos/${t.id}/toggle" style="display:inline">
          <button type="submit">${t.activo ? 'Desactivar' : 'Activar'}</button>
        </form>
      </td>
    </tr>`).join('');

  res.send(layout('Técnicos', `
    <h1>Técnicos</h1>
    <div class="card">
      <table>
        <thead><tr><th>Nombre</th><th>Usuario</th><th>Estado</th><th></th></tr></thead>
        <tbody>${filas || '<tr><td colspan="4">No hay técnicos dados de alta</td></tr>'}</tbody>
      </table>
    </div>
    <div class="card">
      <h2>Añadir técnico</h2>
      <form method="post" action="/tecnicos" style="display:flex;gap:10px;flex-wrap:wrap;align-items:end">
        <div><label>Nombre<br><input name="nombre" required></label></div>
        <div><label>Usuario del portal<br><input name="usuario" required></label></div>
        <div><label>Contraseña del portal<br><input name="password" type="password" required></label></div>
        <button type="submit">Guardar</button>
      </form>
    </div>
  `));
});

app.post('/tecnicos', async (req, res) => {
  const { nombre, usuario, password } = req.body;
  if (!nombre || !usuario || !password) return res.status(400).send('Faltan campos');
  await pool.query(
    'INSERT INTO tecnicos (nombre, usuario, password_enc) VALUES ($1, $2, $3)',
    [nombre, usuario, encryptPassword(password)]
  );
  res.redirect('/tecnicos');
});

app.post('/tecnicos/:id/toggle', async (req, res) => {
  await pool.query('UPDATE tecnicos SET activo = NOT activo WHERE id = $1', [req.params.id]);
  res.redirect('/tecnicos');
});

// Ruta llamada cada hora desde GitHub Actions para disparar el scraping.
// Protegida por un token compartido (no requiere sesión de panel).
let scrapingEnCurso = false;
app.post('/api/run-scrape', express.json(), async (req, res) => {
  const token = req.headers['x-scrape-token'];
  if (!process.env.SCRAPE_TOKEN || token !== process.env.SCRAPE_TOKEN) {
    return res.status(401).json({ error: 'token inválido' });
  }
  if (scrapingEnCurso) {
    return res.status(409).json({ error: 'ya hay un scraping en curso' });
  }
  scrapingEnCurso = true;
  try {
    const resultado = await ejecutarScraping();
    res.json(resultado);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    scrapingEnCurso = false;
  }
});

const PORT = process.env.PORT || 3000;
ensureSchema()
  .then(() => app.listen(PORT, () => console.log(`Panel escuchando en puerto ${PORT}`)))
  .catch((err) => { console.error('Error al preparar la base de datos:', err); process.exit(1); });
