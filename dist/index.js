"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const H5P = __importStar(require("@lumieducation/h5p-server"));
const supabase_js_1 = require("@supabase/supabase-js");
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const multer_1 = __importDefault(require("multer"));
const extract_zip_1 = __importDefault(require("extract-zip"));
const crypto_1 = __importDefault(require("crypto"));
const upload = (0, multer_1.default)({
    storage: multer_1.default.memoryStorage(),
    limits: { fileSize: 250 * 1024 * 1024 } // 250 MB
});
const PORT = process.env.PORT || 3001;
const H5P_ROOT = process.env.H5P_ROOT || path_1.default.join(process.cwd(), 'h5p-storage');
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET || '';
// Log de variables al arrancar (sin exponer valores secretos)
console.log(`[Startup] PORT=${PORT}`);
console.log(`[Startup] H5P_ROOT=${H5P_ROOT}`);
console.log(`[Startup] SUPABASE_URL=${SUPABASE_URL ? SUPABASE_URL.substring(0, 30) + '...' : 'NO CONFIGURADO'}`);
console.log(`[Startup] FRONTEND_URL=${FRONTEND_URL}`);
const app = (0, express_1.default)();
// ── CORS ──────────────────────────────────────────────────────────────────────
app.use((0, cors_1.default)({
    origin: (origin, callback) => {
        if (!origin)
            return callback(null, true);
        if (origin === FRONTEND_URL ||
            origin.endsWith('.vercel.app') ||
            origin.includes('localhost') ||
            origin.includes('railway.app'))
            return callback(null, true);
        callback(new Error(`CORS blocked: ${origin}`));
    },
    credentials: true,
}));
app.use(express_1.default.json({ limit: '500mb' }));
app.use(express_1.default.urlencoded({ extended: true, limit: '500mb' }));
// Middleware to inject user for all H5P routes
app.use((req, res, next) => {
    req.user = getH5PUser(req);
    next();
});
// ── HEALTH CHECK (disponible INMEDIATAMENTE, antes de inicializar H5P) ────────
let h5pStatus = 'initializing';
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
// ── ENDPOINT PARA SUBIR ARCHIVOS DIRECTO A SUPABASE ────────
app.post('/upload', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            res.status(400).json({ error: 'No file provided' });
            return;
        }
        if (!supabase || !SUPABASE_URL) {
            res.status(500).json({ error: 'Supabase no está configurado en el backend' });
            return;
        }
        const folder = req.headers['x-upload-folder'] || 'uploads';
        const tenantId = req.headers['x-upload-tenant'] || 'shared';
        // Use the actual original filename from multer
        const originalName = req.file.originalname;
        // Ensure the bucket exists
        const { data: buckets } = await supabase.storage.listBuckets();
        const bucketExists = buckets?.find((b) => b.name === folder);
        if (!bucketExists) {
            await supabase.storage.createBucket(folder, { public: true });
            console.log(`[Upload] Created public bucket: ${folder}`);
        }
        const ext = path_1.default.extname(originalName) || '.bin';
        // UUID random string for safe filename
        const uuid = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
        const key = `${tenantId}/${uuid}${ext}`;
        const { data, error } = await supabase.storage.from(folder).upload(key, req.file.buffer, {
            contentType: req.file.mimetype,
            upsert: true
        });
        if (error) {
            console.error('[Upload Error]', error);
            res.status(500).json({ error: error.message });
            return;
        }
        const { data: publicUrlData } = supabase.storage.from(folder).getPublicUrl(key);
        res.status(200).json({
            url: publicUrlData.publicUrl,
            key,
            size: req.file.size,
            type: req.file.mimetype,
            name: originalName
        });
    }
    catch (error) {
        console.error('[Upload Fatal]', error);
        res.status(500).json({ error: error.message || 'Internal error' });
    }
});
// ── ENDPOINT PARA SUBIR Y DESCOMPRIMIR SCORM EN SERVIDOR ──
app.post('/upload-scorm', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            res.status(400).json({ error: 'No file provided' });
            return;
        }
        const scormId = crypto_1.default.randomUUID();
        const scormDir = path_1.default.join(H5P_ROOT, 'scorm', 'content', scormId);
        // Create temp zip file
        const tempZipPath = path_1.default.join(H5P_ROOT, 'tmp', `${scormId}.zip`);
        fs_1.default.mkdirSync(path_1.default.join(H5P_ROOT, 'tmp'), { recursive: true });
        fs_1.default.writeFileSync(tempZipPath, req.file.buffer);
        // Extract zip
        await (0, extract_zip_1.default)(tempZipPath, { dir: scormDir });
        fs_1.default.unlinkSync(tempZipPath);
        // Find imsmanifest.xml or entry point
        let entryPoint = 'index.html';
        const manifestPath = path_1.default.join(scormDir, 'imsmanifest.xml');
        const upperManifestPath = path_1.default.join(scormDir, 'IMSMANIFEST.XML');
        if (fs_1.default.existsSync(manifestPath) || fs_1.default.existsSync(upperManifestPath)) {
            const manifestFile = fs_1.default.existsSync(manifestPath) ? manifestPath : upperManifestPath;
            const manifestXml = fs_1.default.readFileSync(manifestFile, 'utf-8');
            const resourceMatch = manifestXml.match(/<resource[^>]*href=["']([^"']+)["'][^>]*scormtype=["']sco["']/i);
            if (resourceMatch && resourceMatch[1]) {
                entryPoint = resourceMatch[1];
            }
            else {
                const fallbackMatch = manifestXml.match(/<resource[^>]*href=["']([^"']+)["']/i);
                if (fallbackMatch && fallbackMatch[1]) {
                    entryPoint = fallbackMatch[1];
                }
            }
        }
        res.status(200).json({
            scormId,
            entryPoint,
            size: req.file.size,
            name: req.file.originalname
        });
    }
    catch (error) {
        console.error('[Upload SCORM Fatal]', error);
        res.status(500).json({ error: error.message || 'Internal error' });
    }
});
// ── SERVIR CONTENIDO SCORM ESTÁTICO ──
app.use('/scorm/content', express_1.default.static(path_1.default.join(H5P_ROOT, 'scorm', 'content')));
// ── REPRODUCTOR SCORM CON API INYECTADA ──
app.get('/scorm/play/:id', (req, res) => {
    const scormId = req.params.id;
    const entryPoint = req.query.entry || 'index.html';
    const iframeSrc = `/scorm/content/${scormId}/${entryPoint}`;
    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>SCORM Player</title>
  <style>
    body, html { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: #fff; }
    iframe { width: 100%; height: 100%; border: none; }
  </style>
  <script>
    var scormData = {};
    window.API = {
      LMSInitialize: function() { return "true"; },
      LMSGetValue: function(key) { return scormData[key] || ""; },
      LMSSetValue: function(key, value) { scormData[key] = value; return "true"; },
      LMSCommit: function() { 
        window.parent.postMessage({ type: 'scorm-score', scormData: scormData }, '*'); 
        return "true"; 
      },
      LMSFinish: function() { 
        window.parent.postMessage({ type: 'scorm-score', scormData: scormData }, '*'); 
        return "true"; 
      },
      LMSGetLastError: function() { return "0"; },
      LMSGetErrorString: function() { return ""; },
      LMSGetDiagnostic: function() { return ""; }
    };
    window.API_1484_11 = window.API; // SCORM 2004 fallback
  </script>
</head>
<body>
  <iframe src="${iframeSrc}" allowfullscreen="true" allow="microphone; camera"></iframe>
</body>
</html>
  `;
    res.send(html);
});
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
function getMime(filename) {
    const ext = path_1.default.extname(filename).toLowerCase();
    const map = {
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
function getH5PUser(req) {
    const token = req.headers.authorization?.split(' ')[1];
    let userId = 'anonymous';
    let userName = 'Anonymous';
    let userEmail = 'anonymous@ingenia.lms';
    if (token && SUPABASE_JWT_SECRET) {
        try {
            const decoded = jsonwebtoken_1.default.verify(token, SUPABASE_JWT_SECRET);
            userId = decoded.sub || 'anonymous';
            userEmail = decoded.email || userEmail;
            userName = decoded.user_metadata?.name || userEmail;
        }
        catch { /* Token inválido — continuar como anónimo */ }
    }
    return {
        id: userId, name: userName, email: userEmail, type: 'local',
        canInstallRecommended: false, canUpdateAndInstallLibraries: true,
        canCreateRestricted: false,
    };
}
// ── SUPABASE ──────────────────────────────────────────────────────────────────
let supabase = null;
try {
    let safeUrl = SUPABASE_URL || 'https://placeholder.supabase.co';
    if (safeUrl && !safeUrl.startsWith('http')) {
        safeUrl = 'https://' + safeUrl;
    }
    supabase = (0, supabase_js_1.createClient)(safeUrl, SUPABASE_SERVICE_KEY || 'placeholder');
}
catch (e) {
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
// ── SCRIPT que intercepta el submit del formulario H5P y lo envía por AJAX ────
// Esto evita que el iframe navegue a la respuesta del POST (mostrando el error 400)
const AJAX_INTERCEPT_SCRIPT = `
<script>
(function() {
  function interceptForm() {
    var form = document.getElementById('h5p-content-form');
    if (!form) return;
    form.addEventListener('submit', function(e) {
      e.preventDefault(); // <-- CLAVE: evitar navegación del iframe
      var formData = new FormData(form);
      console.log('[H5P AJAX] Enviando formulario via fetch a:', form.action);
      fetch(form.action, { method: 'POST', body: formData })
        .then(function(r) { return r.text(); })
        .then(function(html) {
          // Extraer el contentId de la respuesta
          var match = html.match(/contentId[^'"\d]*['"]?(\d+)['"]?/);
          if (match && match[1]) {
            console.log('[H5P AJAX] Guardado exitoso. contentId:', match[1]);
            window.parent.postMessage(JSON.stringify({
              context: 'h5p',
              action: 'saved',
              contentId: match[1]
            }), '*');
          } else if (html.includes('Error:')) {
            console.error('[H5P AJAX] Error al guardar:', html.substring(0, 300));
            window.parent.postMessage(JSON.stringify({
              context: 'h5p',
              action: 'save-error',
              message: html.replace(/<[^>]+>/g, '').substring(0, 200)
            }), '*');
          }
        })
        .catch(function(err) {
          console.error('[H5P AJAX] Fetch error:', err);
        });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', interceptForm);
  } else {
    interceptForm();
  }
})();
</script>
`;
// ── INICIALIZACIÓN H5P + MONTAJE DE RUTAS ────────────────────────────────────
async function initAndMount() {
    console.log('[H5P] Iniciando inicialización...');
    // 1. Crear directorios en el volumen persistente
    for (const dir of ['libraries', 'content', 'tmp', 'config']) {
        fs_1.default.mkdirSync(path_1.default.join(H5P_ROOT, dir), { recursive: true });
    }
    // 2. Pre-crear config.json vacío si no existe
    const configJsonPath = path_1.default.join(H5P_ROOT, 'config', 'config.json');
    if (!fs_1.default.existsSync(configJsonPath)) {
        fs_1.default.writeFileSync(configJsonPath, '{}', 'utf-8');
        console.log('[H5P] config.json creado por primera vez.');
    }
    // 3. Configuración H5P
    const config = await new H5P.H5PConfig(new H5P.fsImplementations.JsonStorage(configJsonPath)).load();
    let baseUrl = process.env.H5P_BASE_URL || `http://localhost:${PORT}`;
    if (baseUrl && !baseUrl.startsWith('http')) {
        baseUrl = 'https://' + baseUrl;
    }
    config.baseUrl = baseUrl;
    await config.save();
    console.log(`[H5P] Config cargada. baseUrl=${config.baseUrl}`);
    // 4. Almacenamientos en filesystem
    const libraryStorage = new H5P.fsImplementations.FileLibraryStorage(path_1.default.join(H5P_ROOT, 'libraries'));
    const contentStorage = new H5P.fsImplementations.FileContentStorage(path_1.default.join(H5P_ROOT, 'content'));
    const tempStorage = new H5P.fsImplementations.DirectoryTemporaryFileStorage(path_1.default.join(H5P_ROOT, 'tmp'));
    const kvStorage = new H5P.fsImplementations.InMemoryStorage();
    // 5. Editor y Player
    const h5pEditor = new H5P.H5PEditor(kvStorage, config, libraryStorage, contentStorage, tempStorage);
    const h5pPlayer = new H5P.H5PPlayer(libraryStorage, contentStorage, config);
    console.log('[H5P] Editor y Player inicializados.');
    // 6. Archivos estáticos H5P (deben coincidir con el baseUrl de H5PConfig)
    app.use('/libraries', express_1.default.static(path_1.default.join(H5P_ROOT, 'libraries')));
    app.use('/h5p/libraries', express_1.default.static(path_1.default.join(H5P_ROOT, 'libraries'))); // Por compatibilidad
    app.use('/content', express_1.default.static(path_1.default.join(H5P_ROOT, 'content')));
    app.use('/h5p/content', express_1.default.static(path_1.default.join(H5P_ROOT, 'content'))); // Por compatibilidad
    // Interceptar h5peditor.js para corregir el bug CORS que destruye el objeto
    app.get('/editor/scripts/h5peditor.js', (req, res, next) => {
        let editorJsPath = path_1.default.join(process.cwd(), 'editor', 'scripts', 'h5peditor.js');
        if (!fs_1.default.existsSync(editorJsPath)) {
            try {
                const h5pPkgPath = path_1.default.dirname(require.resolve('@lumieducation/h5p-server/package.json'));
                editorJsPath = path_1.default.join(h5pPkgPath, 'build', 'assets', 'editor', 'scripts', 'h5peditor.js');
                if (!fs_1.default.existsSync(editorJsPath)) {
                    editorJsPath = path_1.default.join(h5pPkgPath, 'assets', 'editor', 'scripts', 'h5peditor.js');
                }
            }
            catch (e) { }
        }
        if (fs_1.default.existsSync(editorJsPath)) {
            let content = fs_1.default.readFileSync(editorJsPath, 'utf8');
            content = content.replace(/\(function\(\)\{try\{return window\.parent\.H5PEditor;\}catch\(e\)\{return undefined;\}\}\)\(\)/g, '(function(){try{return window.parent.H5PEditor;}catch(e){return window.H5PEditor;}})()');
            content = content.replace(/\(function\(\)\{try\{return window\.parent\.H5PIntegration;\}catch\(e\)\{return undefined;\}\}\)\(\)/g, '(function(){try{return window.parent.H5PIntegration;}catch(e){return window.H5PIntegration;}})()');
            res.type('application/javascript').send(content);
        }
        else {
            next();
        }
    });
    // Montar core y editor desde las carpetas locales en la raíz
    app.use('/core', express_1.default.static(path_1.default.join(process.cwd(), 'core')));
    app.use('/editor', express_1.default.static(path_1.default.join(process.cwd(), 'editor')));
    try {
        const h5pPkgPath = path_1.default.dirname(require.resolve('@lumieducation/h5p-server/package.json'));
        const coreAssets = path_1.default.join(h5pPkgPath, 'build', 'assets');
        if (fs_1.default.existsSync(coreAssets)) {
            app.use('/core', express_1.default.static(path_1.default.join(coreAssets, 'core')));
            app.use('/editor', express_1.default.static(path_1.default.join(coreAssets, 'editor')));
        }
    }
    catch (e) { }
    // 7. Ruta: Editor H5P (GET)
    app.get('/h5p/editor/:contentId?', async (req, res) => {
        try {
            const user = getH5PUser(req);
            const contentIdParam = req.params.contentId;
            // Si el contentId no existe (Railway reiniciado), tratar como nuevo
            let contentId = (!contentIdParam || contentIdParam === 'new') ? undefined : contentIdParam;
            const lang = req.query.language || 'es';
            let model;
            try {
                model = await h5pEditor.render(contentId, lang, user);
            }
            catch (renderErr) {
                // Contenido no encontrado (ej. Railway reiniciado) → editor vacío
                console.warn('[Editor GET] Content not found, falling back to new editor:', renderErr.message);
                contentId = undefined;
                model = await h5pEditor.render(undefined, lang, user);
            }
            console.log('[Editor GET] model type:', typeof model, 'keys:', model && typeof model === 'object' ? Object.keys(model) : 'n/a');
            // Si el modelo devuelve HTML directamente, inyectar nuestros scripts y estilos
            if (typeof model === 'string') {
                // CORRECCIÓN CRUCIAL: El modelo de string de h5p-nodejs-library incluye 
                // "parent.H5PIntegration || " que causa un SecurityError CORS cuando se embebe
                // en un iframe de otro dominio. Lo removemos.
                let safeModel = model.replace('parent.H5PIntegration ||', '');
                const CUSTOM_CSS = `
          <style>
            #save-h5p {
              background: #0ea5e9 !important;
              color: white !important;
              border: none !important;
              padding: 12px 24px !important;
              border-radius: 8px !important;
              font-weight: 800 !important;
              font-size: 14px !important;
              cursor: pointer !important;
              margin: 20px auto !important;
              display: block !important;
              width: 90% !important;
              text-transform: uppercase !important;
              transition: background 0.2s !important;
            }
            #save-h5p:hover { background: #0284c7 !important; }
          </style>
        `;
                const PREVENT_NATIVE_SUBMIT_SCRIPT = `
          <script>
            // Prevenir el POST nativo que causa el error 400 cuando la validación de H5P falla.
            document.addEventListener('DOMContentLoaded', function() {
              var form = document.getElementById('h5p-content-form');
              if (form) {
                form.addEventListener('submit', function(e) {
                  if (window.h5peditor) {
                    var params = window.h5peditor.getParams();
                    if (!params || params.params === undefined) {
                      e.preventDefault();
                      alert('Por favor, selecciona un tipo de contenido o completa los campos requeridos antes de guardar.');
                      return;
                    }
                  }
                  // El script nativo (h5peditor.js) hace su propio AJAX si la validación pasa.
                  // Siempre bloqueamos la navegación nativa.
                  e.preventDefault();
                });
              }
            });
          </script>
        `;
                const injected = CUSTOM_CSS + PREVENT_NATIVE_SUBMIT_SCRIPT + POST_MESSAGE_SCRIPT;
                const finalHtml = safeModel.includes('</body>')
                    ? safeModel.replace('</body>', injected + '</body>')
                    : safeModel + injected;
                res.setHeader('Content-Type', 'text/html; charset=utf-8');
                return res.send(finalHtml);
            }
            // Construir página HTML completa a partir del modelo IEditorModel
            const integration = model?.integration || model?.h5pIntegration || {};
            const scripts = model?.scripts || [];
            const styles = model?.styles || [];
            const scriptTags = scripts
                .map((s) => `<script src="${s}"></script>`)
                .join('\n  ');
            const styleTags = styles
                .map((s) => `<link rel="stylesheet" href="${s}">`)
                .join('\n  ');
            const saveAction = contentId ? `/h5p/editor/${contentId}` : '/h5p/editor/new';
            const html = `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>H5P Editor</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; padding: 8px 12px; font-family: Arial, sans-serif; background: #fff; }
    .h5p-editor { min-height: 400px; }
    .h5peditor-form { padding: 0; }
    
    /* Estilo para el botón de guardado nativo de H5P */
    input[type=submit] { 
      background: #0ea5e9;
      color: white;
      border: none;
      padding: 12px 24px;
      border-radius: 8px;
      font-weight: 800;
      font-size: 14px;
      cursor: pointer;
      margin-top: 20px;
      margin-bottom: 20px;
      width: 100%;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      transition: background 0.2s;
    }
    input[type=submit]:hover { background: #0284c7; }
  </style>
  <script>
    window.H5PIntegration = ${JSON.stringify(integration)};
  </script>
  ${styleTags}
</head>
<body>
  <form method="post" action="${saveAction}" enctype="multipart/form-data" id="h5p-content-form">
    <div class="h5p-editor">
    </div>
    <input type="submit" name="submit" value="Guardar Contenido Interactivo" id="h5p-submit-btn">
  </form>
  ${scriptTags}
  
  <script>
    // Prevenir el POST nativo que causa el error 400 cuando el editor está vacío.
    // El script nativo (h5peditor.js) hace su propio AJAX cuando la validación es correcta,
    // pero si no hay nada seleccionado, permite el submit nativo. Lo bloqueamos.
    document.addEventListener('DOMContentLoaded', function() {
      var form = document.getElementById('h5p-content-form');
      if (form) {
        form.addEventListener('submit', function(e) {
          // Si h5peditor existe pero no tiene parámetros, es porque no se ha seleccionado un tipo
          if (window.h5peditor) {
            var params = window.h5peditor.getParams();
            if (!params || params.params === undefined) {
              e.preventDefault();
              alert('Por favor, selecciona un tipo de contenido interactivo (ej. Interactive Video) antes de guardar.');
              return;
            }
          }
          
          // Prevenimos siempre el POST nativo por seguridad. 
          // El h5peditor.js nativo ya hace $.ajax() y luego redirige.
          e.preventDefault();
        });
      }
    });
  </script>
  
  ${POST_MESSAGE_SCRIPT}
</body>
</html>`;
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.send(html);
        }
        catch (err) {
            console.error('[Editor GET error]', err.message, err.stack?.substring(0, 500));
            res.status(500).send(`<html><body><p style="color:red">Error al cargar el editor H5P: ${err.message}</p></body></html>`);
        }
    });
    // El editor H5P envía multipart/form-data (necesita soportar imágenes dentro del editor)
    app.post('/h5p/editor/:contentId?', upload.any(), async (req, res) => {
        try {
            const user = getH5PUser(req);
            const contentIdParam = req.params.contentId;
            const contentId = contentIdParam === 'new' ? undefined : contentIdParam;
            console.log('[H5P POST] body keys:', Object.keys(req.body));
            let params = undefined;
            let metadata = undefined;
            let library = req.body.library;
            // Variante A: el editor envía req.body.params.params y req.body.params.metadata
            if (req.body.params) {
                const p = typeof req.body.params === 'string' ? JSON.parse(req.body.params) : req.body.params;
                params = p.params ?? p;
                metadata = p.metadata;
            }
            // Variante B: el editor envía req.body.parameters como JSON string
            if (!params && req.body.parameters) {
                try {
                    const parsed = typeof req.body.parameters === 'string' ? JSON.parse(req.body.parameters) : req.body.parameters;
                    params = parsed.params ?? parsed;
                    metadata = parsed.metadata;
                }
                catch (e) {
                    console.warn('[H5P POST] Error parsing parameters JSON', e);
                }
            }
            // Variante C: campos planos (library, params directamente)
            if (!params && req.body['params[params]']) {
                try {
                    params = JSON.parse(req.body['params[params]']);
                }
                catch (e) { }
                try {
                    metadata = JSON.parse(req.body['params[metadata]']);
                }
                catch (e) { }
            }
            if (!params || !library) {
                console.error('[H5P POST] Missing params or library. body:', JSON.stringify(req.body).substring(0, 500));
                return res.status(400).send(`<html><body><p style="color:red">Error: Faltan los parámetros del editor (params o library).</p><pre>${JSON.stringify(req.body).substring(0, 500)}</pre></body></html>`);
            }
            const newContentId = await h5pEditor.saveOrUpdateContent(contentId ? String(contentId) : undefined, params, metadata, library, user);
            console.log('[H5P POST] Guardado exitoso, contentId:', newContentId);
            // La librería nativa h5peditor.js espera JSON de vuelta con el contentId
            res.status(200).send(JSON.stringify({ contentId: newContentId }));
        }
        catch (err) {
            console.error('[Save error]', err.message);
            res.status(500).send(JSON.stringify({ error: err.message }));
        }
    });
    // Alias para /play/:contentId que la librería nativa llama tras guardar exitosamente
    app.get('/play/:contentId', (req, res) => {
        res.redirect(`/h5p/play/${req.params.contentId}`);
    });
    // 8. Ruta: Player H5P
    app.get('/h5p/play/:contentId', async (req, res) => {
        try {
            const user = getH5PUser(req);
            const model = await h5pPlayer.render(req.params.contentId, user);
            let html = typeof model === 'string' ? model : (model?.html || JSON.stringify(model));
            // Inyectar script para avisar al padre React que la actividad se guardó y cargó el player
            const notifyScript = `
        <script>
          try {
            window.parent.postMessage(JSON.stringify({
              context: 'h5p',
              action: 'saved',
              contentId: '${req.params.contentId}'
            }), '*');
          } catch(e) {}
        </script>
      `;
            html = html.includes('</body>') ? html.replace('</body>', notifyScript + '</body>') : html + notifyScript;
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.send(html);
        }
        catch (err) {
            console.error('[Player error]', err.message);
            res.status(500).send(`<html><body><p style="color:red">Error: ${err.message}</p></body></html>`);
        }
    });
    // 9. Rutas AJAX internas del editor H5P
    try {
        const H5PExpress = require('@lumieducation/h5p-express');
        const ajaxRouterFn = H5PExpress.h5pAjaxExpressRouter || H5PExpress.default?.h5pAjaxExpressRouter;
        const h5pPkgPath = path_1.default.dirname(require.resolve('@lumieducation/h5p-server/package.json'));
        const coreAssets = path_1.default.join(h5pPkgPath, 'build', 'assets');
        if (typeof ajaxRouterFn === 'function') {
            app.use('/', ajaxRouterFn(h5pEditor, coreAssets, 'es', { getUser: async (req) => getH5PUser(req) }));
        }
    }
    catch (err) { }
    // 10. Dummy endpoints para telemetría/estado del player (evitar 404s)
    app.all('/contentUserData/*', (req, res) => res.status(200).json({}));
    app.all('/setFinished', (req, res) => res.status(200).json({}));
    // 11. API: Subir archivo .h5p nativamente
    app.post('/api/upload-h5p', upload.single('file'), async (req, res) => {
        try {
            const user = getH5PUser(req);
            if (!req.file) {
                return res.status(400).json({ error: 'No se adjuntó ningún archivo' });
            }
            // Guardar el archivo temporalmente
            const tempPath = path_1.default.join(H5P_ROOT, 'tmp', `upload_${Date.now()}.h5p`);
            fs_1.default.writeFileSync(tempPath, req.file.buffer);
            // Usar el PackageImporter ya instanciado dentro del editor
            const packageImporter = h5pEditor.packageImporter;
            if (!packageImporter) {
                throw new Error('El PackageImporter no está disponible en el editor H5P.');
            }
            console.log(`[H5P] Importando paquete desde ${tempPath}...`);
            const result = await packageImporter.addPackageLibrariesAndContent(tempPath, user);
            console.log(`[H5P] Paquete importado con éxito. ID: ${result.id}`);
            // Limpiar archivo temporal
            try {
                fs_1.default.unlinkSync(tempPath);
            }
            catch (e) {
                console.warn(`[H5P] No se pudo borrar el archivo temporal: ${tempPath}`);
            }
            res.status(200).json({ contentId: result.id });
        }
        catch (err) {
            console.error('[Upload H5P error]', err.message);
            res.status(500).json({ error: err.message });
        }
    });
    // 12. API: Publicar contenido a Supabase Storage
    app.post('/api/publish', async (req, res) => {
        const { contentId, tenantId, activityId } = req.body;
        if (!contentId || !tenantId || !activityId) {
            return res.status(400).json({ error: 'Faltan parámetros: contentId, tenantId, activityId' });
        }
        try {
            const contentPath = path_1.default.join(H5P_ROOT, 'content', String(contentId));
            if (!fs_1.default.existsSync(contentPath)) {
                return res.status(404).json({ error: `Contenido ${contentId} no encontrado` });
            }
            const storagePrefix = `${tenantId}/h5p/${activityId}`;
            let uploadedCount = 0;
            const errors = [];
            const uploadDir = async (localPath, remotePrefix) => {
                const entries = fs_1.default.readdirSync(localPath, { withFileTypes: true });
                for (const entry of entries) {
                    const fullPath = path_1.default.join(localPath, entry.name);
                    const remoteKey = `${remotePrefix}/${entry.name}`;
                    if (entry.isDirectory()) {
                        await uploadDir(fullPath, remoteKey);
                    }
                    else {
                        const buffer = fs_1.default.readFileSync(fullPath);
                        const { error } = await supabase.storage
                            .from('h5p-content')
                            .upload(remoteKey, buffer, { upsert: true, contentType: getMime(entry.name) });
                        if (error)
                            errors.push(`${remoteKey}: ${error.message}`);
                        else
                            uploadedCount++;
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
        }
        catch (err) {
            console.error('[Publish error]', err);
            return res.status(500).json({ error: err.message });
        }
    });
    h5pStatus = 'ready';
    console.log('[H5P] ✅ Todo listo. Servicio completamente operativo.');
}
