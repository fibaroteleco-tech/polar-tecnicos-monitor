const { Pool } = require('pg');
const crypto = require('crypto');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('render.com')
    ? { rejectUnauthorized: false }
    : false,
});

// --- Cifrado simple de contraseñas de técnicos (AES-256-GCM) ---
// ENCRYPTION_KEY debe ser una cadena hex de 32 bytes (64 caracteres).
function getKey() {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error('ENCRYPTION_KEY no configurada correctamente (deben ser 64 caracteres hex / 32 bytes)');
  }
  return Buffer.from(hex, 'hex');
}

function encryptPassword(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function decryptPassword(stored) {
  const buf = Buffer.from(stored, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tecnicos (
      id SERIAL PRIMARY KEY,
      nombre TEXT NOT NULL,
      usuario TEXT NOT NULL UNIQUE,
      password_enc TEXT NOT NULL,
      activo BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS ordenes_trabajo (
      id SERIAL PRIMARY KEY,
      tecnico_id INTEGER NOT NULL REFERENCES tecnicos(id) ON DELETE CASCADE,
      orden_externa_id TEXT NOT NULL,
      estado TEXT,
      datos JSONB NOT NULL DEFAULT '{}'::jsonb,
      primera_vista TIMESTAMPTZ NOT NULL DEFAULT now(),
      ultima_vista TIMESTAMPTZ NOT NULL DEFAULT now(),
      activa BOOLEAN NOT NULL DEFAULT TRUE,
      UNIQUE(tecnico_id, orden_externa_id)
    );

    CREATE TABLE IF NOT EXISTS historial_cambios (
      id SERIAL PRIMARY KEY,
      tecnico_id INTEGER NOT NULL REFERENCES tecnicos(id) ON DELETE CASCADE,
      orden_externa_id TEXT NOT NULL,
      tipo_cambio TEXT NOT NULL CHECK (tipo_cambio IN ('alta','baja','cambio_estado')),
      estado_anterior TEXT,
      estado_nuevo TEXT,
      detectado_en TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS runs_log (
      id SERIAL PRIMARY KEY,
      iniciado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
      finalizado_en TIMESTAMPTZ,
      tecnicos_ok INTEGER NOT NULL DEFAULT 0,
      tecnicos_error INTEGER NOT NULL DEFAULT 0,
      detalle JSONB NOT NULL DEFAULT '[]'::jsonb
    );

    CREATE INDEX IF NOT EXISTS idx_historial_detectado ON historial_cambios(detectado_en DESC);
    CREATE INDEX IF NOT EXISTS idx_ordenes_tecnico ON ordenes_trabajo(tecnico_id);
  `);
}

module.exports = { pool, ensureSchema, encryptPassword, decryptPassword };
