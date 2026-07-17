import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import * as H5P from '@lumieducation/h5p-server';
import { createClient } from '@supabase/supabase-js';
import jwt from 'jsonwebtoken';

const PORT = process.env.PORT || 3001;
const H5P_ROOT = process.env.H5P_ROOT || path.join(process.cwd(), 'h5p-storage');
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET || '';

// Log de variables al arrancar (sin exponer valores secretos)
console.log(`[Startup] PORT=${PORT}`);
console.log(`[Startup] H5P_ROOT=${H5P_ROOT}`);
console.log(`[Startup] SUPABASE_URL=${SUPABASE_URL ? SUPABASE_URL.substring(0, 30) + '...' : 'NO CONFIGURADO'}`);
console.log(`[Startup] FRONTEND_URL=${FRONTEND_URL}`);

const app = express();

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (
      origin === FRONTEND_URL ||
      origin.endsWith('.vercel.app') ||
      origin.includes('localhost') ||
      origin.includes('railway.app')
    ) return callback(null, true);
    callback(new Error(`CORS blocked: ${origin}`));
  },
  credentials: true,
}));
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ extended: true, limit: '500mb' }));

// ── HEALTH CHECK (disponible INMEDIATAMENTE, antes de inicializar H5P) ────────
let h5pStatus: 'initializing' | 'ready' | 'error' = 'initializing';
let h5pError = '';

app.get('/health', (_req, res) => {
  res.status(200).json({
    status: h5pStatus,
    port: PORT,
    h5pRoot: H5P_ROOT,
    supabase: !!SUPABASE_URL,
    timestamp: new Date().toISOString(),
    ...(h5pError ? { error: h5pError } : {}),
  });
});

// Ruta raíz — responde 200 para evitar 502
app.get('/', (_req, res) => {
  res.status(200).json({ service: 'Ingenia H5P Service', status: h5pStatus });
});

// ── SERVIDOR HTTP: se vincula ANTES que H5P se inicialice ─────────────────────
app.listen(Number(PORT), '0.0.0.0', () => {
  console.log(`[Ingenia H5P Service] ✅ Escuchando en 0.0.0.0:${PORT}`);
  // Inicializar H5P después de que el servidor ya está escuchando
  initAndMount().catch(err => {
    h5pStatus = 'error';
    h5pError = err.message;
    console.error('[H5P Init FATAL]', err.message);
    console.error('[H5P Init STACK]', err.stack);
  });
});

// ── MIME TYPES ────────────────────────────────────────────────────────────────
function getMime(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const map: Record<string, string> = {
    '.json': 'application/json', '.js': 'application/javascript',
    '.css': 'text/css', '.html': 'text/html', '.png': 'image/png',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.webm': 'video/webm',
    '.mp3': 'audio/mpeg', '.woff': 'font/woff', '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
  };
  return map[ext] || 'application/octet-stream';
}

// ── USUARIO H5P ───────────────────────────────────────────────────────────────
function getH5PUser(req: express.Request): any {
  const token = req.headers.authorization?.split(' ')[1];
  let userId = 'anonymous';
  let userName = 'Anonymous';
  let userEmail = 'anonymous@ingenia.lms';

  if (token && SUPABASE_JWT_SECRET) {
    try {
      const decoded: any = jwt.verify(token, SUPABASE_JWT_SECRET);
      userId = decoded.sub || 'anonymous';
      userEmail = decoded.email || userEmail;
      userName = decoded.user_metadata?.name || userEmail;
    } catch { /* Token inválido — continuar como anónimo */ }
  }

  return {
    id: userId, name: userName, email: userEmail, type: 'local',
    canInstallRecommended: false, canUpdateAndInstallLibraries: true,
    canCreateRestricted: false,
  };
}

// ── SUPABASE ──────────────────────────────────────────────────────────────────
let supabase: any = null;
try {
  let safeUrl = SUPABASE_URL || 'https://placeholder.supabase.co';
  if (safeUrl && !safeUrl.startsWith('http')) {
    safeUrl = 'https://' + safeUrl;
  }
  supabase = createClient(safeUrl, SUPABASE_SERVICE_KEY || 'placeholder');
} catch (e: any) {
  console.error('[Startup Error] No se pudo inicializar Supabase. Revisa la variable SUPABASE_URL:', e.message);
}

// ── SCRIPT postMessage para comunicar guardado al padre React ─────────────────
const POST_MESSAGE_SCRIPT = `
<script>
(function() {
  var tries = 0;
  var interval = setInterval(function() {
    tries++;
    if (tries > 120) { clearInterval(interval); return; }
    if (window.H5PEditor && window.H5PEditor.instances && window.H5PEditor.instances.length > 0) {
      clearInterval(interval);
      var editor = window.H5PEditor.instances[0];
      if (editor && editor.on) {
        editor.on('save', function(contentId) {
          window.parent.postMessage(JSON.stringify({
            action: 'h5p-saved',
            contentId: String(contentId || 'new')
          }), '*');
        });
      }
    }
  }, 500);
})();
</script>
`;

// ── INICIALIZACIÓN H5P + MONTAJE DE RUTAS ────────────────────────────────────
async function initAndMount() {
  console.log('[H5P] Iniciando inicialización...');

  // 1. Crear directorios en el volumen persistente
  for (const dir of ['libraries', 'content', 'tmp', 'config']) {
    fs.mkdirSync(path.join(H5P_ROOT, dir), { recursive: true });
  }

  // 2. Pre-crear config.json vacío si no existe
  const configJsonPath = path.join(H5P_ROOT, 'config', 'config.json');
  if (!fs.existsSync(configJsonPath)) {
    fs.writeFileSync(configJsonPath, '{}', 'utf-8');
    console.log('[H5P] config.json creado por primera vez.');
  }

  // 3. Configuración H5P
  const config = await new H5P.H5PConfig(
    new H5P.fsImplementations.JsonStorage(configJsonPath)
  ).load();

  config.baseUrl = process.env.H5P_BASE_URL || `http://localhost:${PORT}`;
  await config.save();
  console.log(`[H5P] Config cargada. baseUrl=${config.baseUrl}`);

  // 4. Almacenamientos en filesystem
  const libraryStorage = new H5P.fsImplementations.FileLibraryStorage(
    path.join(H5P_ROOT, 'libraries')
  );
  const contentStorage = new H5P.fsImplementations.FileContentStorage(
    path.join(H5P_ROOT, 'content')
  );
  const tempStorage = new H5P.fsImplementations.DirectoryTemporaryFileStorage(
    path.join(H5P_ROOT, 'tmp')
  );
  const kvStorage = new H5P.fsImplementations.InMemoryStorage();
  const cachedStorage = new H5P.cacheImplementations.CachedKeyValueStorage('kvcache', kvStorage);

  // 5. Editor y Player
  const h5pEditor = new H5P.H5PEditor(cachedStorage, config, libraryStorage, contentStorage, tempStorage);
  const h5pPlayer = new H5P.H5PPlayer(libraryStorage, contentStorage, config);
  console.log('[H5P] Editor y Player inicializados.');

  // 6. Archivos estáticos H5P
  app.use('/h5p/libraries', express.static(path.join(H5P_ROOT, 'libraries')));
  app.use('/h5p/content', express.static(path.join(H5P_ROOT, 'content')));

  try {
    const h5pPkgPath = path.dirname(require.resolve('@lumieducation/h5p-server/package.json'));
    const coreAssets = path.join(h5pPkgPath, 'build', 'assets');
    if (fs.existsSync(coreAssets)) {
      app.use('/h5p-core', express.static(coreAssets));
      console.log('[H5P] Assets del core montados en /h5p-core');
    }
  } catch { console.warn('[H5P] Core assets no encontrados.'); }

  // 7. Ruta: Editor H5P
  app.get('/h5p/editor{/:contentId}', async (req, res) => {
    try {
      const user = getH5PUser(req);
      const contentId = (req.params as any).contentId || undefined;
      const lang = (req.query.language as string) || 'es';
      const model = await (h5pEditor as any).render(contentId, lang, user);
      const rawHtml: string = typeof model === 'string' ? model : (model?.html || JSON.stringify(model));
      const finalHtml = rawHtml.includes('</body>')
        ? rawHtml.replace('</body>', POST_MESSAGE_SCRIPT + '</body>')
        : rawHtml + POST_MESSAGE_SCRIPT;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(finalHtml);
    } catch (err: any) {
      console.error('[Editor error]', err.message);
      res.status(500).send(`<html><body><p style="color:red">Error: ${err.message}</p></body></html>`);
    }
  });

  // 8. Ruta: Player H5P
  app.get('/h5p/play/:contentId', async (req, res) => {
    try {
      const user = getH5PUser(req);
      const model = await (h5pPlayer as any).render(req.params.contentId, user);
      const html: string = typeof model === 'string' ? model : (model?.html || JSON.stringify(model));
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(html);
    } catch (err: any) {
      console.error('[Player error]', err.message);
      res.status(500).send(`<html><body><p style="color:red">Error: ${err.message}</p></body></html>`);
    }
  });

  // 9. Rutas AJAX internas del editor H5P
  try {
    const H5PExpress = require('@lumieducation/h5p-express');
    const ajaxRouterFn = H5PExpress.h5pAjaxExpressRouter || H5PExpress.default?.h5pAjaxExpressRouter;
    
    // Buscar la ruta del core de H5P (igual que en la inicialización estática)
    const h5pPkgPath = path.dirname(require.resolve('@lumieducation/h5p-server/package.json'));
    const coreAssets = path.join(h5pPkgPath, 'build', 'assets');

    if (typeof ajaxRouterFn === 'function') {
      app.use('/h5p/ajax', ajaxRouterFn(
        h5pEditor,
        coreAssets, // h5pCorePath
        'es',       // languageOverride
        { getUser: async (req: any) => getH5PUser(req) } // options
      ));
      console.log('[H5P] Router AJAX montado.');
    }
  } catch (err: any) { console.warn('[H5P] Router AJAX no montado:', err.message); }

  // 10. API: Publicar contenido a Supabase Storage
  app.post('/api/publish', async (req, res) => {
    const { contentId, tenantId, activityId } = req.body;
    if (!contentId || !tenantId || !activityId) {
      return res.status(400).json({ error: 'Faltan parámetros: contentId, tenantId, activityId' });
    }
    try {
      const contentPath = path.join(H5P_ROOT, 'content', String(contentId));
      if (!fs.existsSync(contentPath)) {
        return res.status(404).json({ error: `Contenido ${contentId} no encontrado` });
      }
      const storagePrefix = `${tenantId}/h5p/${activityId}`;
      let uploadedCount = 0;
      const errors: string[] = [];

      const uploadDir = async (localPath: string, remotePrefix: string) => {
        const entries = fs.readdirSync(localPath, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(localPath, entry.name);
          const remoteKey = `${remotePrefix}/${entry.name}`;
          if (entry.isDirectory()) {
            await uploadDir(fullPath, remoteKey);
          } else {
            const buffer = fs.readFileSync(fullPath);
            const { error } = await supabase.storage
              .from('h5p-content')
              .upload(remoteKey, buffer, { upsert: true, contentType: getMime(entry.name) });
            if (error) errors.push(`${remoteKey}: ${error.message}`);
            else uploadedCount++;
          }
        }
      };

      await uploadDir(contentPath, storagePrefix);
      console.log(`[Publish] ${activityId}: ${uploadedCount} archivos subidos.`);

      return res.json({
        success: true, contentId,
        storageBaseUrl: `${SUPABASE_URL}/storage/v1/object/public/h5p-content/${storagePrefix}`,
        filesUploaded: uploadedCount,
        errors: errors.length > 0 ? errors : undefined,
      });
    } catch (err: any) {
      console.error('[Publish error]', err);
      return res.status(500).json({ error: err.message });
    }
  });

  h5pStatus = 'ready';
  console.log('[H5P] ✅ Todo listo. Servicio completamente operativo.');
}