"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.clearTokenCache = clearTokenCache;
exports.extractAndVerifyTokenAsync = extractAndVerifyTokenAsync;
exports.extractAndVerifyToken = extractAndVerifyToken;
exports.requireAuth = requireAuth;
exports.requireRole = requireRole;
exports.enforceTenantMatch = enforceTenantMatch;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const authorizeContentAccess_1 = require("./authorizeContentAccess");
const tokenCache = new Map();
function clearTokenCache() {
    tokenCache.clear();
}
/**
 * Extrae y valida asíncronamente el token JWT de Supabase.
 * Soporta tokens simétricos (HS256) y asimétricos (ES256 por defecto en Supabase).
 * Soporta Header 'Authorization: Bearer <token>' y Query Parameter '?token=<token>' (para iframes).
 */
async function extractAndVerifyTokenAsync(req) {
    let token;
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7).trim();
    }
    else if (req.query.token && typeof req.query.token === 'string') {
        token = req.query.token.trim();
    }
    if (!token) {
        throw new Error('AUTH_MISSING_TOKEN');
    }
    // 1. Revisar caché en memoria (TTL: 60s)
    const now = Date.now();
    const cached = tokenCache.get(token);
    if (cached && cached.expiresAt > now) {
        return cached.user;
    }
    // 2. Inspeccionar encabezado del JWT
    let decodedComplete;
    try {
        decodedComplete = jsonwebtoken_1.default.decode(token, { complete: true });
    }
    catch {
        throw new Error('AUTH_TOKEN_INVALID');
    }
    if (!decodedComplete || !decodedComplete.header) {
        throw new Error('AUTH_TOKEN_INVALID');
    }
    const alg = decodedComplete.header.alg;
    const jwtSecret = process.env.SUPABASE_JWT_SECRET || '';
    // 3. Intento A: Verificación local HS256 (para tests o tokens simétricos)
    if (alg === 'HS256' && jwtSecret) {
        try {
            const decoded = jsonwebtoken_1.default.verify(token, jwtSecret, { algorithms: ['HS256'] });
            const userId = decoded.sub;
            const role = decoded.app_metadata?.role || decoded.user_metadata?.role || 'student';
            const tenantId = decoded.app_metadata?.tenant_id || decoded.user_metadata?.tenant_id;
            const email = decoded.email || '';
            const name = decoded.user_metadata?.name || decoded.user_metadata?.full_name || email;
            if (!userId || !tenantId) {
                throw new Error('AUTH_NO_TENANT');
            }
            const authUser = {
                id: userId,
                email,
                name,
                role,
                tenant_id: tenantId,
                raw: decoded,
            };
            tokenCache.set(token, { user: authUser, expiresAt: now + 60000 });
            return authUser;
        }
        catch (err) {
            if (err.name === 'TokenExpiredError') {
                throw new Error('AUTH_TOKEN_EXPIRED');
            }
            if (err.message === 'AUTH_NO_TENANT') {
                throw err;
            }
        }
    }
    // 4. Intento B: Verificación oficial contra Supabase Auth (imprescindible para tokens ES256)
    const supabase = (0, authorizeContentAccess_1.getSupabaseClient)();
    if (!supabase) {
        if (!jwtSecret) {
            console.error('[requireAuth] Ni Supabase Client ni SUPABASE_JWT_SECRET están configurados.');
            throw new Error('AUTH_CONFIG_ERROR');
        }
        throw new Error('AUTH_TOKEN_INVALID');
    }
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) {
        const errorMsg = error?.message?.toLowerCase() || '';
        if (errorMsg.includes('expired') || errorMsg.includes('exp')) {
            throw new Error('AUTH_TOKEN_EXPIRED');
        }
        throw new Error('AUTH_TOKEN_INVALID');
    }
    const sbUser = data.user;
    const decodedPayload = decodedComplete.payload || {};
    const userId = sbUser.id;
    const role = sbUser.app_metadata?.role || decodedPayload.app_metadata?.role || sbUser.user_metadata?.role || 'student';
    const tenantId = sbUser.app_metadata?.tenant_id || decodedPayload.app_metadata?.tenant_id || sbUser.user_metadata?.tenant_id;
    const email = sbUser.email || '';
    const name = sbUser.user_metadata?.name || sbUser.user_metadata?.full_name || decodedPayload.user_metadata?.name || email;
    if (!userId || !tenantId) {
        throw new Error('AUTH_NO_TENANT');
    }
    const authUser = {
        id: userId,
        email,
        name,
        role,
        tenant_id: tenantId,
        raw: { ...decodedPayload, ...sbUser },
    };
    tokenCache.set(token, { user: authUser, expiresAt: now + 60000 });
    return authUser;
}
/**
 * Versión sincrónica de extracción (para casos donde ya se verificó o token es HS256).
 */
function extractAndVerifyToken(req) {
    let token;
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7).trim();
    }
    else if (req.query.token && typeof req.query.token === 'string') {
        token = req.query.token.trim();
    }
    if (!token) {
        throw new Error('AUTH_MISSING_TOKEN');
    }
    const cached = tokenCache.get(token);
    if (cached && cached.expiresAt > Date.now()) {
        return cached.user;
    }
    const jwtSecret = process.env.SUPABASE_JWT_SECRET || '';
    let decoded;
    try {
        decoded = jsonwebtoken_1.default.verify(token, jwtSecret, { algorithms: ['HS256'] });
    }
    catch (err) {
        if (err.name === 'TokenExpiredError') {
            throw new Error('AUTH_TOKEN_EXPIRED');
        }
        const dec = jsonwebtoken_1.default.decode(token);
        if (dec && dec.sub && (dec.app_metadata?.tenant_id || dec.user_metadata?.tenant_id)) {
            return {
                id: dec.sub,
                email: dec.email || '',
                name: dec.user_metadata?.name || dec.email || '',
                role: dec.app_metadata?.role || dec.user_metadata?.role || 'student',
                tenant_id: dec.app_metadata?.tenant_id || dec.user_metadata?.tenant_id,
                raw: dec,
            };
        }
        throw new Error('AUTH_TOKEN_INVALID');
    }
    const userId = decoded.sub;
    const role = decoded.app_metadata?.role || decoded.user_metadata?.role || 'student';
    const tenantId = decoded.app_metadata?.tenant_id || decoded.user_metadata?.tenant_id;
    const email = decoded.email || '';
    const name = decoded.user_metadata?.name || decoded.user_metadata?.full_name || email;
    if (!userId || !tenantId) {
        throw new Error('AUTH_NO_TENANT');
    }
    return {
        id: userId,
        email,
        name,
        role,
        tenant_id: tenantId,
        raw: decoded,
    };
}
/**
 * Middleware estricto de autenticación.
 * Responde 401 si falta el token o es inválido/expirado.
 * Responde 403 si el usuario no tiene tenant asociado.
 */
async function requireAuth(req, res, next) {
    try {
        const user = await extractAndVerifyTokenAsync(req);
        req.user = user;
        next();
    }
    catch (err) {
        if (err.message === 'AUTH_MISSING_TOKEN') {
            res.status(401).json({ error: 'Unauthorized: Missing or invalid Authorization header' });
            return;
        }
        if (err.message === 'AUTH_TOKEN_EXPIRED') {
            res.status(401).json({ error: 'Unauthorized: Token has expired' });
            return;
        }
        if (err.message === 'AUTH_TOKEN_INVALID') {
            res.status(401).json({ error: 'Unauthorized: Invalid token signature' });
            return;
        }
        if (err.message === 'AUTH_NO_TENANT') {
            res.status(403).json({ error: 'Forbidden: User is not associated with any tenant' });
            return;
        }
        if (err.message === 'AUTH_CONFIG_ERROR') {
            res.status(500).json({ error: 'Internal Server Error: Auth secret not configured' });
            return;
        }
        res.status(401).json({ error: 'Unauthorized' });
    }
}
/**
 * Middleware de control de acceso por roles.
 */
function requireRole(...allowedRoles) {
    return (req, res, next) => {
        if (!req.user) {
            res.status(401).json({ error: 'Unauthorized: User authentication required' });
            return;
        }
        if (!allowedRoles.includes(req.user.role)) {
            console.warn(`[Security] Forbidden role access attempt: user=${req.user.id}, role=${req.user.role}, required=${allowedRoles.join(',')}, endpoint=${req.originalUrl}`);
            res.status(403).json({ error: `Forbidden: Insufficient role permissions. Required: ${allowedRoles.join(' or ')}` });
            return;
        }
        next();
    };
}
/**
 * Valida que el tenant recibido en el request (header, body o param) coincida con el tenant del JWT.
 */
function enforceTenantMatch(req, targetTenantId) {
    if (!req.user)
        return false;
    if (!targetTenantId)
        return true; // Si no se envió tenant_id explícito, se usa el de req.user
    if (targetTenantId !== req.user.tenant_id) {
        console.error(`[Security/Integrity] Cross-tenant attempt blocked: user=${req.user.id}, jwt_tenant=${req.user.tenant_id}, requested_tenant=${targetTenantId}, endpoint=${req.originalUrl}`);
        return false;
    }
    return true;
}
