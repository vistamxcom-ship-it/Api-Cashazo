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

// ============================================================================
// 🚀 OPTIMIZACIÓN: CACHE EN MEMORIA DEL SERVER (evita queries duplicadas)
// ============================================================================
const serverCache = {
  data: null,
  lastUpdate: 0,
  CACHE_TTL: 5000  // 5 segundos (mucho menos que los 60s del client)
};

function isCacheValid() {
  return serverCache.data && (Date.now() - serverCache.lastUpdate) < serverCache.CACHE_TTL;
}

function setCache(data) {
  serverCache.data = data;
  serverCache.lastUpdate = Date.now();
}

function clearCache() {
  serverCache.data = null;
  serverCache.lastUpdate = 0;
}

// ============================================================================
// POST /sync — Guardar TODOS los datos en Supabase
// ============================================================================
app.post('/sync', async (req, res) => {
  try {
    const { accs, vendedores, cfg, redes } = req.body;
    
    console.log('📥 POST /sync recibido:', {
      accs_count: Array.isArray(accs) ? accs.length : 0,
      redes_count: Array.isArray(redes) ? redes.length : 0,
      vendedores_count: Object.keys(vendedores || {}).length,
      timestamp: new Date().toISOString()
    });
    
    // Validar que al menos accs sea un array
    if (!Array.isArray(accs)) {
      console.warn('⚠️ accs no es array:', typeof accs);
      return res.status(400).json({ success: false, error: 'accs debe ser un array' });
    }
    
    // UPSERT a Supabase — siempre sobrescribe lo viejo con lo nuevo
    const { data, error } = await supabase
      .from('backup')
      .upsert(
        {
          id: 'main',
          accs_data: JSON.stringify(accs),
          vendedores_data: JSON.stringify(vendedores || {}),
          config_data: JSON.stringify(cfg || {}),
          redes_data: JSON.stringify(redes || []),
          updated_at: new Date().toISOString()
        },
        { onConflict: 'id' }
      )
      .select();
    
    if (error) {
      console.error('❌ Error en UPSERT:', error.message);
      return res.status(500).json({ 
        success: false, 
        error: error.message,
        details: error.details 
      });
    }
    
    // 🚀 OPTIMIZACIÓN: Actualizar cache en memoria después de guardar
    setCache({ accs, vendedores, cfg, redes });
    
    console.log('✅ Datos guardados en Supabase + cache actualizado');
    return res.json({ 
      success: true, 
      mensaje: 'Guardado en Supabase',
      guardado: {
        accs: accs.length,
        redes: (redes || []).length,
        timestamp: new Date().toISOString()
      }
    });
    
  } catch (err) {
    console.error('❌ POST /sync error:', err.message);
    return res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

// ============================================================================
// GET /sync — Traer datos con SMART CACHE (no siempre jala de Supabase)
// ============================================================================
// 🚀 CAMBIO CRÍTICO: Si el cache está fresco (<5s), devolver desde memoria
// Si está viejo, jalar de Supabase una sola vez
app.get('/sync', async (req, res) => {
  try {
    // ✅ OPTIMIZACIÓN #1: Si cache está fresco, usarlo
    if (isCacheValid()) {
      console.log('⚡ Cache HIT — devolviendo desde memoria (sin query Supabase)');
      return res.json({
        accs: serverCache.data.accs,
        vendedores: serverCache.data.vendedores,
        cfg: serverCache.data.cfg,
        redes: serverCache.data.redes,
        source: 'memory-cache',
        timestamp: new Date().toISOString()
      });
    }
    
    // ✅ OPTIMIZACIÓN #2: Si cache expiró, jalar de Supabase pero solo UNA VEZ
    console.log('🔄 Cache MISS — consultando Supabase...');
    
    const { data, error } = await supabase
      .from('backup')
      .select('*')
      .eq('id', 'main')
      .single();
    
    // Si no existe aún, devolver estructura vacía
    if (error && error.code === 'PGRST116') {
      console.log('ℹ️ No hay datos en Supabase aún, devolviendo vacío');
      const emptyData = { 
        accs: [], 
        vendedores: {}, 
        cfg: {}, 
        redes: []
      };
      setCache(emptyData);
      return res.json({ 
        ...emptyData,
        source: 'empty',
        timestamp: new Date().toISOString()
      });
    }
    
    if (error) {
      console.error('❌ Error en GET /sync:', error.message);
      return res.status(500).json({ error: error.message });
    }
    
    if (!data) {
      const emptyData = { 
        accs: [], 
        vendedores: {}, 
        cfg: {}, 
        redes: []
      };
      setCache(emptyData);
      return res.json({ 
        ...emptyData,
        source: 'empty',
        timestamp: new Date().toISOString()
      });
    }
    
    // ✅ OPTIMIZACIÓN #3: Parsear datos (mismo parsing que antes)
    let accsData = [];
    let vendedoresData = {};
    let configData = {};
    let redesData = [];
    
    try {
      accsData = typeof data.accs_data === 'string' 
        ? JSON.parse(data.accs_data) 
        : (data.accs_data || []);
    } catch(e) {
      console.warn('⚠️ Error parseando accs_data:', e.message);
      accsData = [];
    }
    
    try {
      vendedoresData = typeof data.vendedores_data === 'string'
        ? JSON.parse(data.vendedores_data)
        : (data.vendedores_data || {});
    } catch(e) {
      console.warn('⚠️ Error parseando vendedores_data:', e.message);
      vendedoresData = {};
    }
    
    try {
      configData = typeof data.config_data === 'string'
        ? JSON.parse(data.config_data)
        : (data.config_data || {});
    } catch(e) {
      console.warn('⚠️ Error parseando config_data:', e.message);
      configData = {};
    }
    
    try {
      redesData = typeof data.redes_data === 'string'
        ? JSON.parse(data.redes_data)
        : (data.redes_data || []);
    } catch(e) {
      console.warn('⚠️ Error parseando redes_data:', e.message);
      redesData = [];
    }
    
    // 🚀 OPTIMIZACIÓN #4: Guardar en cache después de jalar de Supabase
    const cacheData = { accs: accsData, vendedores: vendedoresData, cfg: configData, redes: redesData };
    setCache(cacheData);
    
    console.log('✅ Datos traídos de Supabase + cacheados:', {
      accs: Array.isArray(accsData) ? accsData.length : 0,
      redes: Array.isArray(redesData) ? redesData.length : 0,
      timestamp: new Date().toISOString()
    });
    
    return res.json({
      accs: accsData,
      vendedores: vendedoresData,
      cfg: configData,
      redes: redesData,
      updated_at: data.updated_at,
      source: 'supabase-fresh',
      timestamp: new Date().toISOString()
    });
    
  } catch (err) {
    console.error('❌ GET /sync error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// GET /api/health — Verificar salud del servidor
// ============================================================================
// 🚀 CAMBIO: health NO jala de Supabase cada vez (era otro request duplicado)
app.get('/api/health', async (req, res) => {
  try {
    // Simplificado: no hace SELECT a Supabase siempre
    // Solo hace ping si lo requiere explícitamente con ?check=supabase
    const checkSupabase = req.query.check === 'supabase';
    
    let supabaseStatus = 'unknown';
    
    if (checkSupabase) {
      try {
        const { error } = await supabase
          .from('backup')
          .select('count')
          .limit(1);
        supabaseStatus = error ? 'disconnected' : 'connected';
      } catch (err) {
        supabaseStatus = 'error';
      }
    }
    
    return res.json({
      status: 'ok',
      supabase: supabaseStatus,
      cacheStatus: isCacheValid() ? 'valid' : 'expired',
      timestamp: new Date().toISOString(),
      uptime: process.uptime()
    });
    
  } catch (err) {
    return res.json({
      status: 'error',
      error: err.message,
      timestamp: new Date().toISOString()
    });
  }
});

// ============================================================================
// GET / — Servir admin.html
// ============================================================================
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// ============================================================================
// INICIAR SERVIDOR
// ============================================================================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔════════════════════════════════════════╗
║   ✅ CASHAZO SERVER (OPTIMIZADO)       ║
║  URL: http://0.0.0.0:${PORT}                   
║  Supabase: ${SUPABASE_URL ? '🟢 Conectado' : '🔴 Error'}              
║  Memory Cache: 5s TTL                  
║  Admin: http://localhost:${PORT}               
╚════════════════════════════════════════╝
  `);
});
