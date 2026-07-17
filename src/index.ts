import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import * as H5P from '@lumieducation/h5p-server';
import { createClient } from '@supabase/supabase-js';
import jwt from 'jsonwebtoken';

const app = express();
const PORT = process.env.PORT || 3001;
const H5P_ROOT = process.env.H5P_ROOT || path.join(process.cwd(), 'h5p-storage');
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET || '';

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (
      origin === FRONTEND_URL ||
      origin.endsWith('.vercel.app') ||
      origin.includes('localhost')
    ) return callback(null, true);
    callback(new Error(`CORS blocked: ${origin}`));
  },
  credentials: true,
}));
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ extended: true, limit: '500mb' }));

// ── USUARIO H5P (usa `any` para evitar cambios de tipado entre versiones) ─────
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
    } catch {
      // Token inválido — continuar como anónimo
    }
  }

  return {
    id: userId,
    name: userName,
    email: userEmail,
    type: 'local',
    canInstallRecommended: false,
    canUpdateAndInstallLibraries: true,
    canCreateRestricted: false,
  };
}

// ── SUPABASE (server-side con service role para escritura en Storage) ─────────
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ── MIME TYPES ────────────────────────────────────────────────────────────────
function getMime(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const map: Record<string, string> = {
    '.json': 'application/json',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.html': 'text/html',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mp3': 'audio/mpeg',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
  };
  return map[ext] || 'application/octet-stream';
}

// ── INICIALIZACIÓN H5P ────────────────────────────────────────────────────────
async function initH5P() {
// Crear directorios necesarios en el volumen persistente de Railway
  for (const dir of ['libraries', 'content', 'tmp', 'config']) {
    fs.mkdirSync(path.join(H5P_ROOT, dir), { recursive: true });
  }

  // Pre-crear config.json vacío si no existe — JsonStorage requiere que el archivo exista
  const configJsonPath = path.join(H5P_ROOT, 'config', 'config.json');
  if (!fs.existsSync(configJsonPath)) {
    fs.writeFileSync(configJsonPath, '{}', 'utf-8');
    console.log('[H5P] config.json creado en:', configJsonPath);
  }

  // Configuración H5P almacenada en JSON en el volumen persistente
  const config = await new H5P.H5PConfig(
    new H5P.fsImplementations.JsonStorage(configJsonPath)
  ).load();

  // Única propiedad que necesitamos configurar externamente
  config.baseUrl = process.env.H5P_BASE_URL || `http://localhost:${PORT}`;
  await config.save();

  // Almacenamientos en filesystem (Railway persistent volume en /app/h5p-storage)
  const libraryStorage = new H5P.fsImplementations.FileLibraryStorage(
    path.join(H5P_ROOT, 'libraries')
  );
  const contentStorage = new H5P.fsImplementations.FileContentStorage(
    path.join(H5P_ROOT, 'content')
  );
  const tempStorage = new H5P.fsImplementations.DirectoryTemporaryFileStorage(
    path.join(H5P_ROOT, 'tmp')
  );

  // Cache en memoria (se pierde al reiniciar, es solo caché de rendimiento)
  const kvStorage = new H5P.fsImplementations.InMemoryStorage();
  const cachedStorage = new H5P.cacheImplementations.CachedKeyValueStorage(
    'kvcache',
    kvStorage
  );

  // Editor y Player H5P
  const h5pEditor = new H5P.H5PEditor(
    cachedStorage,
    config,
    libraryStorage,
    contentStorage,
    tempStorage
  );

  const h5pPlayer = new H5P.H5PPlayer(
    libraryStorage,
    contentStorage,
    config
  );

  return { config, h5pEditor, h5pPlayer };
}

// ── SCRIPT QUE SE INYECTA EN EL EDITOR PARA COMUNICAR EL GUARDADO ────────────
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

// ── SERVIDOR ──────────────────────────────────────────────────────────────────
async function main() {
  const { h5pEditor, h5pPlayer } = await initH5P();

  // Archivos estáticos del contenido y librerías H5P
  app.use('/h5p/libraries', express.static(path.join(H5P_ROOT, 'libraries')));
  app.use('/h5p/content', express.static(path.join(H5P_ROOT, 'content')));

  // Assets del core de H5P (JS/CSS del editor y reproductor)
  try {
    const h5pPkgPath = path.dirname(
      require.resolve('@lumieducation/h5p-server/package.json')
    );
    const coreAssets = path.join(h5pPkgPath, 'build', 'assets');
    if (fs.existsSync(coreAssets)) {
      app.use('/h5p-core', express.static(coreAssets));
    }
  } catch {
    console.warn('[h5p-core] No se encontraron los assets del core de H5P.');
  }

  // ── Ruta: Editor H5P (cargado en iframe desde React) ──
  app.get('/h5p/editor{/:contentId}', async (req, res) => {
    try {
      const user = getH5PUser(req);
      const contentId = (req.params as any).contentId || undefined;
      const lang = (req.query.language as string) || 'es';
      const model = await (h5pEditor as any).render(contentId, lang, user);
      const rawHtml: string =
        typeof model === 'string'
          ? model
          : model?.html || JSON.stringify(model);
      const finalHtml = rawHtml.includes('</body>')
        ? rawHtml.replace('</body>', POST_MESSAGE_SCRIPT + '</body>')
        : rawHtml + POST_MESSAGE_SCRIPT;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(finalHtml);
    } catch (err: any) {
      console.error('[editor]', err.message);
      res.status(500).send(
        `<html><body><p style="color:red;font-family:sans-serif">
         Error al cargar el editor H5P:<br><code>${err.message}</code></p></body></html>`
      );
    }
  });

  // ── Ruta: Player H5P (alternativa para preview en iframe) ──
  app.get('/h5p/play/:contentId', async (req, res) => {
    try {
      const user = getH5PUser(req);
      const model = await (h5pPlayer as any).render(req.params.contentId, user);
      const html: string =
        typeof model === 'string' ? model : model?.html || JSON.stringify(model);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(html);
    } catch (err: any) {
      console.error('[player]', err.message);
      res.status(500).send(
        `<html><body><p style="color:red">Error: ${err.message}</p></body></html>`
      );
    }
  });

  // ── Rutas AJAX internas del editor H5P ──
  // h5p-express maneja todas las subidas de archivos, librerías y contenido
  try {
    const H5PExpress = require('@lumieducation/h5p-express');
    const ajaxRouterFn =
      H5PExpress.h5pAjaxExpressRouter ||
      H5PExpress.default?.h5pAjaxExpressRouter;

    if (typeof ajaxRouterFn === 'function') {
      app.use(
        '/h5p/ajax',
        ajaxRouterFn(h5pEditor, {
          getUser: async (req: any) => getH5PUser(req),
        })
      );
      console.log('[h5p-express] Router AJAX montado en /h5p/ajax');
    } else {
      console.warn('[h5p-express] h5pAjaxExpressRouter no encontrado, el editor puede tener funcionalidad limitada.');
    }
  } catch (err: any) {
    console.warn('[h5p-express] No se pudo montar el router AJAX:', err.message);
  }

  // ── API: Publicar contenido H5P a Supabase Storage ──
  // React llama a este endpoint después de que el docente guarda en el editor
  app.post('/api/publish', async (req, res) => {
    const { contentId, tenantId, activityId } = req.body as {
      contentId: string;
      tenantId: string;
      activityId: string;
    };

    if (!contentId || !tenantId || !activityId) {
      return res
        .status(400)
        .json({ error: 'Faltan parámetros: contentId, tenantId, activityId' });
    }

    try {
      const contentPath = path.join(H5P_ROOT, 'content', String(contentId));
      if (!fs.existsSync(contentPath)) {
        return res
          .status(404)
          .json({ error: `Contenido ${contentId} no encontrado en el servidor H5P` });
      }

      const storagePrefix = `${tenantId}/h5p/${activityId}`;
      let uploadedCount = 0;
      const errors: string[] = [];

      // Sube recursivamente todos los archivos del contenido H5P
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
              .upload(remoteKey, buffer, {
                upsert: true,
                contentType: getMime(entry.name),
              });
            if (error) {
              errors.push(`${remoteKey}: ${error.message}`);
            } else {
              uploadedCount++;
            }
          }
        }
      };

      await uploadDir(contentPath, storagePrefix);

      // También subir las librerías que usa este contenido
      const h5pJsonPath = path.join(contentPath, 'h5p.json');
      if (fs.existsSync(h5pJsonPath)) {
        try {
          const h5pMeta = JSON.parse(fs.readFileSync(h5pJsonPath, 'utf-8'));
          const deps: string[] = (h5pMeta.preloadedDependencies || []).map(
            (d: any) => `${d.machineName}-${d.majorVersion}.${d.minorVersion}`
          );
          for (const libName of deps) {
            const libPath = path.join(H5P_ROOT, 'libraries', libName);
            if (fs.existsSync(libPath)) {
              await uploadDir(libPath, `${storagePrefix}/libraries/${libName}`);
            }
          }
        } catch {
          // Si no podemos leer las dependencias, continuar sin ellas
        }
      }

      const publicBaseUrl = `${SUPABASE_URL}/storage/v1/object/public/h5p-content/${storagePrefix}`;

      console.log(`[publish] ${activityId}: ${uploadedCount} archivos subidos a Supabase Storage`);

      return res.json({
        success: true,
        contentId,
        storageBaseUrl: publicBaseUrl,
        filesUploaded: uploadedCount,
        errors: errors.length > 0 ? errors : undefined,
      });
    } catch (err: any) {
      console.error('[publish error]', err);
      return res.status(500).json({ error: err.message });
    }
  });

  // ── Health check ──
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      h5pRoot: H5P_ROOT,
      supabaseConfigured: !!SUPABASE_URL,
    });
  });

  app.listen(PORT, () => {
    console.log(`[Ingenia H5P Service] Puerto ${PORT} | Storage: ${H5P_ROOT}`);
    console.log(`[Ingenia H5P Service] Editor: http://localhost:${PORT}/h5p/editor`);
    console.log(`[Ingenia H5P Service] Health: http://localhost:${PORT}/health`);
  });
}

main().catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});