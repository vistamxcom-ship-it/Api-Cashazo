const express = require('express');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ Faltan SUPABASE_URL / SUPABASE_KEY en las variables de entorno');
  process.exit(1);
}

// Se pasa 'ws' explícito para evitar el crash de WebSocket nativo en Node < 22
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  realtime: { transport: WebSocket }
});

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Desactivar caché SIEMPRE — evita que celulares muestren versiones viejas del admin
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

app.use(express.static(__dirname, { etag: false, lastModified: false }));

// Guardar — esto es lo que ya llama tu admin.html en cada cambio (persist.saveData -> fetch('/sync'))
app.post('/sync', async (req, res) => {
  try {
    const { accs, vendedores, cfg } = req.body;
    const { error } = await supabase.from('backup').upsert({
      id: 'main',
      accs_data: accs || [],
      vendedores_data: vendedores || {},
      config_data: cfg || {},
      updated_at: new Date().toISOString()
    }, { onConflict: 'id' });
    if (error) throw error;
    res.json({ success: true, mensaje: 'Guardado en Supabase' });
  } catch (err) {
    console.error('❌ POST /sync:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Cargar — lo usa el admin.html al iniciar y cada 15s para jalar cambios de otros dispositivos
app.get('/sync', async (req, res) => {
  try {
    const { data, error } = await supabase.from('backup').select('*').eq('id', 'main').single();
    if (error && error.code !== 'PGRST116') throw error;
    if (!data) return res.json({ accs: [], vendedores: {}, cfg: {} });
    res.json({
      accs: data.accs_data || [],
      vendedores: data.vendedores_data || {},
      cfg: data.config_data || {}
    });
  } catch (err) {
    console.error('❌ GET /sync:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/health', async (req, res) => {
  try {
    const { error } = await supabase.from('backup').select('count').limit(1);
    res.json({ status: 'ok', supabase: error ? 'disconnected' : 'connected', timestamp: new Date().toISOString() });
  } catch (err) {
    res.json({ status: 'error', supabase: 'error', error: err.message });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('✅ CASHAZO server + Supabase corriendo en 0.0.0.0:' + PORT);
});
