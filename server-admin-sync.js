/**
 * CASHAZO SERVER v2
 * Sincroniza localStorage del admin.html con Supabase (sin cambiar el HTML)
 * 
 * El admin.html mantiene EXACTAMENTE su funcionamiento:
 * - Usa localStorage para guardar accs y vendedores
 * - El servidor simplemente sincroniza eso a Supabase
 * - Si recargas, el servidor devuelve los datos
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ====== SUPABASE CONFIG ======
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ SUPABASE_URL y SUPABASE_KEY son requeridas en .env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ====== MIDDLEWARE ======
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ====== API ENDPOINTS ======

/**
 * GET /api/backup
 * Devuelve los datos guardados en Supabase (para que el admin los cargue al iniciar)
 */
app.get('/api/backup', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('backup')
      .select('*')
      .eq('id', 'main')
      .single();

    if (error && error.code !== 'PGRST116') {
      throw error;
    }

    if (!data) {
      return res.json({ accs: [], vendedores: {} });
    }

    res.json({
      accs: data.accs_data || [],
      vendedores: data.vendedores_data || {}
    });
  } catch (err) {
    console.error('❌ GET /api/backup:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/backup
 * Guarda los datos del admin en Supabase
 * El admin lo llama cada vez que guarda en localStorage
 */
app.post('/api/backup', async (req, res) => {
  try {
    const { accs, vendedores, config } = req.body;

    if (!accs || !vendedores) {
      return res.status(400).json({ error: 'accs y vendedores son requeridos' });
    }

    const backupData = {
      id: 'main',
      accs_data: accs,
      vendedores_data: vendedores,
      config_data: config || {},
      updated_at: new Date().toISOString()
    };

    const { error } = await supabase
      .from('backup')
      .upsert(backupData, { onConflict: 'id' });

    if (error) throw error;

    res.json({ success: true, message: 'Datos guardados en Supabase' });
  } catch (err) {
    console.error('❌ POST /api/backup:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/health
 * Verifica que el servidor está conectado a Supabase
 */
app.get('/api/health', async (req, res) => {
  try {
    const { error } = await supabase
      .from('backup')
      .select('count')
      .limit(1);

    const status = error ? 'disconnected' : 'connected';

    res.json({
      status: 'ok',
      supabase: status,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    res.json({
      status: 'error',
      supabase: 'error',
      error: err.message
    });
  }
});

/**
 * GET /
 * Sirve el admin.html
 */
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// ====== SERVIDOR ======
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔════════════════════════════════════════╗
║  CASHAZO Server (Supabase Sync)        ║
║  Escuchando en puerto :${PORT}            ║
║  Admin: http://localhost:${PORT}         ║
║  Supabase: ${SUPABASE_URL.substring(0, 30)}... ║
╚════════════════════════════════════════╝
  `);
});
