const { chromium } = require('playwright');
const { pool, decryptPassword } = require('../db');

const LOGIN_URL = 'https://polar-tecnicos.orange.es/?signin';

async function loginYRecolectar(browser, tecnico) {
  const page = await browser.newPage();
  try {
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle' });
    await page.fill('#usuario', tecnico.usuario);
    await page.fill('#inputNuevaPass', decryptPassword(tecnico.password_enc));
    await page.getByRole('button', { name: 'Enter' }).click();
    await page.waitForLoadState('networkidle');

    const bloqueado = await page.locator('text=/captcha|verificaci[oó]n|2FA/i').first().isVisible().catch(() => false);
    if (bloqueado) {
      throw new Error('Se ha encontrado un paso de verificación inesperado (2FA/captcha) — requiere revisión manual');
    }

    const ordenes = await extraerOrdenes(page);
    return { ok: true, ordenes };
  } finally {
    await page.close();
  }
}

// -----------------------------------------------------------------------
// PENDIENTE DE AJUSTAR: selectores genéricos provisionales. Ajustar en
// cuanto tengamos una captura/HTML real de la pantalla de listado de
// órdenes con sesión iniciada.
// -----------------------------------------------------------------------
async function extraerOrdenes(page) {
  const filas = await page.$$eval('table tbody tr, [class*="orden"], [class*="work-order"], li[class*="item"]', (els) =>
    els.map((el) => {
      const texto = el.innerText.trim();
      const idMatch = texto.match(/[A-Z0-9\-]{5,}/);
      return {
        orden_externa_id: idMatch ? idMatch[0] : texto.slice(0, 40),
        estado: null,
        datos: { texto_bruto: texto },
      };
    })
  );
  return filas;
}

async function compararYGuardar(tecnicoId, ordenesNuevas) {
  const client = await pool.connect();
  const cambios = [];
  try {
    await client.query('BEGIN');

    const { rows: existentes } = await client.query(
      'SELECT orden_externa_id, estado FROM ordenes_trabajo WHERE tecnico_id = $1 AND activa = TRUE',
      [tecnicoId]
    );
    const existentesMap = new Map(existentes.map((o) => [o.orden_externa_id, o.estado]));
    const idsNuevos = new Set(ordenesNuevas.map((o) => o.orden_externa_id));

    for (const orden of ordenesNuevas) {
      const estadoAnterior = existentesMap.get(orden.orden_externa_id);
      if (estadoAnterior === undefined) {
        await client.query(
          `INSERT INTO ordenes_trabajo (tecnico_id, orden_externa_id, estado, datos)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (tecnico_id, orden_externa_id)
           DO UPDATE SET estado = EXCLUDED.estado, datos = EXCLUDED.datos, ultima_vista = now(), activa = TRUE`,
          [tecnicoId, orden.orden_externa_id, orden.estado, orden.datos]
        );
        await client.query(
          `INSERT INTO historial_cambios (tecnico_id, orden_externa_id, tipo_cambio, estado_nuevo)
           VALUES ($1, $2, 'alta', $3)`,
          [tecnicoId, orden.orden_externa_id, orden.estado]
        );
        cambios.push({ tipo: 'alta', orden: orden.orden_externa_id });
      } else if (estadoAnterior !== orden.estado) {
        await client.query(
          `UPDATE ordenes_trabajo SET estado = $3, datos = $4, ultima_vista = now()
           WHERE tecnico_id = $1 AND orden_externa_id = $2`,
          [tecnicoId, orden.orden_externa_id, orden.estado, orden.datos]
        );
        await client.query(
          `INSERT INTO historial_cambios (tecnico_id, orden_externa_id, tipo_cambio, estado_anterior, estado_nuevo)
           VALUES ($1, $2, 'cambio_estado', $3, $4)`,
          [tecnicoId, orden.orden_externa_id, estadoAnterior, orden.estado]
        );
        cambios.push({ tipo: 'cambio_estado', orden: orden.orden_externa_id, de: estadoAnterior, a: orden.estado });
      } else {
        await client.query(
          'UPDATE ordenes_trabajo SET ultima_vista = now() WHERE tecnico_id = $1 AND orden_externa_id = $2',
          [tecnicoId, orden.orden_externa_id]
        );
      }
    }

    for (const [ordenExternaId] of existentesMap) {
      if (!idsNuevos.has(ordenExternaId)) {
        await client.query(
          'UPDATE ordenes_trabajo SET activa = FALSE, ultima_vista = now() WHERE tecnico_id = $1 AND orden_externa_id = $2',
          [tecnicoId, ordenExternaId]
        );
        await client.query(
          `INSERT INTO historial_cambios (tecnico_id, orden_externa_id, tipo_cambio, estado_anterior)
           VALUES ($1, $2, 'baja', $3)`,
          [tecnicoId, ordenExternaId, existentesMap.get(ordenExternaId)]
        );
        cambios.push({ tipo: 'baja', orden: ordenExternaId });
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return cambios;
}

async function ejecutarScraping() {
  const { rows: tecnicos } = await pool.query('SELECT * FROM tecnicos WHERE activo = TRUE ORDER BY id');
  const detalle = [];
  let ok = 0;
  let error = 0;

  if (tecnicos.length > 0) {
    const browser = await chromium.launch({ headless: true });
    try {
      for (const tecnico of tecnicos) {
        try {
          const { ordenes } = await loginYRecolectar(browser, tecnico);
          const cambios = await compararYGuardar(tecnico.id, ordenes);
          detalle.push({ tecnico: tecnico.usuario, ordenes: ordenes.length, cambios: cambios.length });
          ok++;
        } catch (err) {
          detalle.push({ tecnico: tecnico.usuario, error: err.message });
          error++;
        }
      }
    } finally {
      await browser.close();
    }
  }

  await pool.query(
    `INSERT INTO runs_log (finalizado_en, tecnicos_ok, tecnicos_error, detalle)
     VALUES (now(), $1, $2, $3)`,
    [ok, error, JSON.stringify(detalle)]
  );

  return { ok, error, detalle };
}

module.exports = { ejecutarScraping };
