"use strict";
/**
 * r2Helper.ts — Helper para subir archivos a Cloudflare R2 desde Node.js.
 *
 * Implementa AWS Signature V4 usando únicamente el módulo nativo `crypto`
 * de Node.js (sin dependencias externas).
 *
 * Uso:
 *   const r2 = getR2Config();
 *   if (r2) await uploadDirectoryToR2('/ruta/local', 'prefijo/r2', r2);
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getR2Config = getR2Config;
exports.uploadDirectoryToR2 = uploadDirectoryToR2;
exports.restoreDirectoryFromR2 = restoreDirectoryFromR2;
const crypto_1 = __importDefault(require("crypto"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
// ── Configuración desde variables de entorno ──────────────────────────────────
/**
 * Lee las variables de entorno R2_* y devuelve la config, o null si faltan.
 */
function getR2Config() {
    const accountId = process.env.R2_ACCOUNT_ID?.trim();
    const accessKeyId = process.env.R2_ACCESS_KEY_ID?.trim();
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY?.trim();
    const bucketName = process.env.R2_BUCKET_NAME?.trim();
    const publicUrl = process.env.R2_PUBLIC_URL?.trim();
    if (!accountId || !accessKeyId || !secretAccessKey || !bucketName || !publicUrl) {
        return null;
    }
    return { accountId, accessKeyId, secretAccessKey, bucketName, publicUrl };
}
// ── AWS Signature V4 ──────────────────────────────────────────────────────────
function hmacSha256(key, data) {
    return crypto_1.default.createHmac('sha256', key).update(data, 'utf8').digest();
}
function sha256hex(data) {
    return crypto_1.default.createHash('sha256').update(data).digest('hex');
}
function derivedSigningKey(secretKey, dateStamp, region, service) {
    const kDate = hmacSha256(`AWS4${secretKey}`, dateStamp);
    const kRegion = hmacSha256(kDate, region);
    const kService = hmacSha256(kRegion, service);
    return hmacSha256(kService, 'aws4_request');
}
// ── Upload a R2 ───────────────────────────────────────────────────────────────
/**
 * Sube un Buffer a R2 bajo la clave `key`.
 * Devuelve la URL pública del archivo subido.
 */
async function uploadBufferToR2(fileBuffer, key, contentType, config) {
    const region = 'auto';
    const service = 's3';
    const host = `${config.accountId}.r2.cloudflarestorage.com`;
    const urlPath = `/${config.bucketName}/${key}`;
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:\-]|\.\d{3}/g, '').slice(0, 15) + 'Z';
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = sha256hex(fileBuffer);
    // Cabeceras canónicas (ordenadas alfabéticamente)
    const canonicalHeaders = `content-type:${contentType}\n` +
        `host:${host}\n` +
        `x-amz-content-sha256:${payloadHash}\n` +
        `x-amz-date:${amzDate}\n`;
    const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date';
    const canonicalRequest = [
        'PUT',
        urlPath,
        '', // query string vacío
        canonicalHeaders,
        signedHeaders,
        payloadHash
    ].join('\n');
    const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
    const stringToSign = [
        'AWS4-HMAC-SHA256',
        amzDate,
        credentialScope,
        sha256hex(canonicalRequest)
    ].join('\n');
    const signingKey = derivedSigningKey(config.secretAccessKey, dateStamp, region, service);
    const signature = hmacSha256(signingKey, stringToSign).toString('hex');
    const authHeader = `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${credentialScope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`;
    const url = `https://${host}${urlPath}`;
    // fetch está disponible nativamente en Node.js 22
    const response = await fetch(url, {
        method: 'PUT',
        headers: {
            'Content-Type': contentType,
            'Content-Length': String(fileBuffer.length),
            'x-amz-content-sha256': payloadHash,
            'x-amz-date': amzDate,
            'Authorization': authHeader,
        },
        body: fileBuffer,
    });
    if (!response.ok) {
        const text = await response.text();
        throw new Error(`R2 upload failed [${response.status}]: ${text}`);
    }
    return `${config.publicUrl}/${key}`;
}
// ── MIME helper ───────────────────────────────────────────────────────────────
function getMimeForR2(filename) {
    const ext = path_1.default.extname(filename).toLowerCase();
    const mimes = {
        '.html': 'text/html',
        '.htm': 'text/html',
        '.js': 'application/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.xml': 'application/xml',
        '.txt': 'text/plain',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.svg': 'image/svg+xml',
        '.webp': 'image/webp',
        '.mp4': 'video/mp4',
        '.webm': 'video/webm',
        '.mp3': 'audio/mpeg',
        '.wav': 'audio/wav',
        '.ogg': 'audio/ogg',
        '.woff': 'font/woff',
        '.woff2': 'font/woff2',
        '.ttf': 'font/ttf',
        '.pdf': 'application/pdf',
        '.zip': 'application/zip',
    };
    return mimes[ext] || 'application/octet-stream';
}
// ── API pública ───────────────────────────────────────────────────────────────
/**
 * Sube un directorio completo a R2 manteniendo la estructura de carpetas.
 *
 * @param localDir  Ruta absoluta al directorio local (ej: '/app/h5p-storage/scorm/content/abc')
 * @param r2Prefix  Prefijo en R2 (ej: 'h5p-scorm/abc')
 * @param config    Configuración R2 obtenida con getR2Config()
 */
async function uploadDirectoryToR2(localDir, r2Prefix, config) {
    let uploaded = 0;
    const errors = [];
    async function uploadDir(dir, prefix) {
        const entries = fs_1.default.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path_1.default.join(dir, entry.name);
            const r2Key = `${prefix}/${entry.name}`;
            if (entry.isDirectory()) {
                await uploadDir(fullPath, r2Key);
            }
            else {
                try {
                    const buffer = fs_1.default.readFileSync(fullPath);
                    const contentType = getMimeForR2(entry.name);
                    await uploadBufferToR2(buffer, r2Key, contentType, config);
                    uploaded++;
                }
                catch (e) {
                    errors.push(`${r2Key}: ${e.message}`);
                }
            }
        }
    }
    await uploadDir(localDir, r2Prefix);
    return { uploaded, errors };
}
/**
 * Restaura un directorio desde R2 hacia el disco local si existe.
 */
async function restoreDirectoryFromR2(r2Prefix, localDir, config) {
    try {
        const region = 'auto';
        const service = 's3';
        const host = `${config.accountId}.r2.cloudflarestorage.com`;
        const canonicalUri = `/${config.bucketName}`;
        const canonicalQuery = `list-type=2&prefix=${encodeURIComponent(r2Prefix)}`;
        const now = new Date();
        const amzDate = now.toISOString().replace(/[:\-]|\.\d{3}/g, '').slice(0, 15) + 'Z';
        const dateStamp = amzDate.slice(0, 8);
        const payloadHash = sha256hex('');
        const canonicalHeaders = `host:${host}\n` +
            `x-amz-content-sha256:${payloadHash}\n` +
            `x-amz-date:${amzDate}\n`;
        const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
        const canonicalRequest = [
            'GET',
            canonicalUri,
            canonicalQuery,
            canonicalHeaders,
            signedHeaders,
            payloadHash
        ].join('\n');
        const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
        const stringToSign = [
            'AWS4-HMAC-SHA256',
            amzDate,
            credentialScope,
            sha256hex(canonicalRequest)
        ].join('\n');
        const signingKey = derivedSigningKey(config.secretAccessKey, dateStamp, region, service);
        const signature = hmacSha256(signingKey, stringToSign).toString('hex');
        const authHeader = `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${credentialScope}, ` +
            `SignedHeaders=${signedHeaders}, Signature=${signature}`;
        const url = `https://${host}${canonicalUri}?${canonicalQuery}`;
        const response = await fetch(url, {
            headers: {
                'Host': host,
                'x-amz-date': amzDate,
                'x-amz-content-sha256': payloadHash,
                'Authorization': authHeader,
            }
        });
        if (!response.ok)
            return false;
        const text = await response.text();
        // Parse keys from XML
        const keyMatches = [...text.matchAll(/<Key>([^<]+)<\/Key>/g)].map(m => m[1]);
        if (keyMatches.length === 0)
            return false;
        fs_1.default.mkdirSync(localDir, { recursive: true });
        for (const key of keyMatches) {
            const relativePath = key.substring(r2Prefix.length + 1);
            const targetFilePath = path_1.default.join(localDir, relativePath);
            fs_1.default.mkdirSync(path_1.default.dirname(targetFilePath), { recursive: true });
            const fileUrl = `${config.publicUrl}/${key}`;
            const fileRes = await fetch(fileUrl);
            if (fileRes.ok) {
                const buf = Buffer.from(await fileRes.arrayBuffer());
                fs_1.default.writeFileSync(targetFilePath, buf);
            }
        }
        return fs_1.default.existsSync(path_1.default.join(localDir, 'h5p.json')) && fs_1.default.existsSync(path_1.default.join(localDir, 'content.json'));
    }
    catch (err) {
        console.warn('[R2 Restore] Error restaurando desde R2:', err.message);
        return false;
    }
}
