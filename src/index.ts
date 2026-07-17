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
    if (origin === FRONTEND_URL || origin.endsWith('.vercel.app') || origin.includes('localhost')) {
      return callback(null, true);
    }
    callback(new Error(`CORS blocked: ${origin}`));
  },
  credentials: true,
}));
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ extended: true, limit: '500mb' }));

// ── MIDDLEWARE: Validar JWT de Supabase ────────────────────────────────────────
function getH5PUser(req: express.Request): H5P.IUser {
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
      // Token inválido o expirado — se permite como anónimo (el editor aún funciona)
    }
  }

  return {
    id: userId,
    name: userName,
    email: userEmail,
    type: 'local' as H5P.UserType,
    canInstallRecommended: false,
    canUpdateAndInstallLibraries: true,
    canCreateRestricted: false,
  };
}

// ── SUPABASE CLIENT (server-side con service role) ────────────────────────────
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ── INICIALIZACIÓN H5P ────────────────────────────────────────────────────────
async function initH5P() {
  // Crear directorios necesarios
  const dirs = ['libraries', 'content', 'tmp', 'config', 'keyvalue', 'lock'];
  for (const dir of dirs) {
    fs.mkdirSync(path.join(H5P_ROOT, dir), { recursive: true });
  }

  // Configuración H5P
  const config = await new H5P.H5PConfig(
    new H5P.fsImplementations.JsonStorage(path.join(H5P_ROOT, 'config', 'config.json'))
  ).load();

  config.baseUrl = process.env.H5P_BASE_URL || `http://localhost:${PORT}`;
  config.ajaxPath = '/h5p/ajax/';
  config.librariesPath = '/h5p/libraries/';
  config.contentFilesPath = '/h5p/content/';
  config.maxFileSize = 300 * 1024 * 1024; // 300MB
  config.maxTotalSize = 500 * 1024 * 1024; // 500MB
  await config.save();

  // Almacenamiento en filesystem (Railway persistent volume)
  const libraryStorage = new H5P.fsImplementations.FileLibraryStorage(
    path.join(H5P_ROOT, 'libraries')
  );
  const contentStorage = new H5P.fsImplementations.FileContentStorage(
    path.join(H5P_ROOT, 'content')
  );
  const tempStorage = new H5P.fsImplementations.DirectoryTemporaryFileStorage(
    path.join(H5P_ROOT, 'tmp')
  );
  const keyValueStorage = new H5P.fsImplementations.DirectoryKeyValueStorage(
    path.join(H5P_ROOT, 'keyvalue')
  );
  const cachedStorage = new H5P.cacheImplementations.CachedKeyValueStorage(
    'kvcache', keyValueStorage
  );

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

  return { config, h5pEditor, h5pPlayer, contentStorage };
}

// ── SERVIDOR ──────────────────────────────────────────────────────────────────
async function main() {
  const { h5pEditor, h5pPlayer, contentStorage } = await initH5P();

  // ── Archivos estáticos de H5P (bibliotecas y contenido) ──
  app.use('/h5p/libraries', express.static(path.join(H5P_ROOT, 'libraries')));
  app.use('/h5p/content', express.static(path.join(H5P_ROOT, 'content')));
  app.use('/h5p/core', express.static(
    path.join(process.cwd(), 'node_modules/@lumieducation/h5p-server/build/assets/h5p-core')
  ));
  app.use('/h5p/editor-core', express.static(
    path.join(process.cwd(), 'node_modules/@lumieducation/h5p-server/build/assets/h5p-editor')
  ));

  // ── RUTA: Página del Editor H5P (cargada en iframe desde React) ──
  app.get('/h5p/editor/:contentId?', async (req, res) => {
    try {
      const user = getH5PUser(req);
      const contentId = req.params.contentId || undefined;
      const lang = (req.query.language as string) || 'es';
      const model = await h5pEditor.render(contentId as any, lang, user);
      res.send(model.html);
    } catch (err: any) {
      console.error('[editor render error]', err.message);
      res.status(500).send(`<p>Error al cargar el editor H5P: ${err.message}</p>`);
    }
  });

  // ── RUTA: Página del Player H5P (cargada en iframe desde React) ──
  app.get('/h5p/play/:contentId', async (req, res) => {
    try {
      const user = getH5PUser(req);
      const model = await h5pPlayer.render(req.params.contentId, user);
      res.send(model.html);
    } catch (err: any) {
      console.error('[player render error]', err.message);
      res.status(500).send(`<p>Error al reproducir H5P: ${err.message}</p>`);
    }
  });

  // ── RUTAS AJAX de H5P (requeridas por el editor internamente) ──
  const { h5pAjaxExpressRouter, libraryAdministrationExpressRouter } = await import('@lumieducation/h5p-express');

  app.use(
    '/h5p/ajax',
    h5pAjaxExpressRouter(
      h5pEditor,
      express.Router(),
      { getUser: async (req) => getH5PUser(req) }
    )
  );

  app.use('/h5p/libraries-admin', libraryAdministrationExpressRouter(h5pEditor, express.Router(), {
    getUser: async (req) => getH5PUser(req),
  }));

  // ── API: Publicar contenido a Supabase Storage (llamada desde React al guardar) ──
  app.post('/api/publish', async (req, res) => {
    const { contentId, tenantId, activityId } = req.body as {
      contentId: string;
      tenantId: string;
      activityId: string;
    };

    if (!contentId || !tenantId || !activityId) {
      return res.status(400).json({ error: 'Faltan parámetros: contentId, tenantId, activityId' });
    }

    try {
      const contentPath = path.join(H5P_ROOT, 'content', contentId);
      if (!fs.existsSync(contentPath)) {
        return res.status(404).json({ error: `Contenido ${contentId} no encontrado en el servidor H5P` });
      }

      const storagePrefix = `${tenantId}/h5p/${activityId}`;
      let uploadedCount = 0;

      // Función recursiva para subir todos los archivos del contenido
      const uploadDirectory = async (localPath: string, remotePrefix: string) => {
        const entries = fs.readdirSync(localPath, { withFileTypes: true });
        for (const entry of entries) {
          const fullLocalPath = path.join(localPath, entry.name);
          const remoteKey = `${remotePrefix}/${entry.name}`;
          if (entry.isDirectory()) {
            await uploadDirectory(fullLocalPath, remoteKey);
          } else {
            const fileBuffer = fs.readFileSync(fullLocalPath);
            const mimeType = getMimeType(entry.name);
            const { error } = await supabase.storage
              .from('h5p-content')
              .upload(remoteKey, fileBuffer, { upsert: true, contentType: mimeType });
            if (error) {
              console.error(`[upload error] ${remoteKey}:`, error.message);
            } else {
              uploadedCount++;
            }
          }
        }
      };

      await uploadDirectory(contentPath, storagePrefix);

      // También subir los archivos de las bibliotecas que usa este contenido
      const h5pJsonPath = path.join(contentPath, 'h5p.json');
      if (fs.existsSync(h5pJsonPath)) {
        const h5pJson = JSON.parse(fs.readFileSync(h5pJsonPath, 'utf-8'));
        const deps: string[] = [];
        if (h5pJson.preloadedDependencies) {
          for (const dep of h5pJson.preloadedDependencies) {
            deps.push(`${dep.machineName}-${dep.majorVersion}.${dep.minorVersion}`);
          }
        }
        // Subir cada librería requerida
        for (const libName of deps) {
          const libPath = path.join(H5P_ROOT, 'libraries', libName);
          if (fs.existsSync(libPath)) {
            await uploadDirectory(libPath, `${storagePrefix}/libraries/${libName}`);
          }
        }
      }

      const publicBaseUrl = `${SUPABASE_URL}/storage/v1/object/public/h5p-content/${storagePrefix}`;

      res.json({
        success: true,
        contentId,
        storageBaseUrl: publicBaseUrl,
        filesUploaded: uploadedCount,
      });
    } catch (err: any) {
      console.error('[publish error]', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── API: Health check ──
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  app.listen(PORT, () => {
    console.log(`[Ingenia H5P Service] Puerto: ${PORT}`);
    console.log(`[Ingenia H5P Service] Storage: ${H5P_ROOT}`);
    console.log(`[Ingenia H5P Service] Frontend permitido: ${FRONTEND_URL}`);
  });
}

function getMimeType(filename: string): string {
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
    '.mp3': 'audio/mpeg',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
  };
  return map[ext] || 'application/octet-stream';
}

main().catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});