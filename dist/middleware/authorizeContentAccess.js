"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.clearAccessCache = clearAccessCache;
exports.getSupabaseClient = getSupabaseClient;
exports.setSupabaseClient = setSupabaseClient;
exports.authorizeContentAccess = authorizeContentAccess;
exports.createAuthorizePlayMiddleware = createAuthorizePlayMiddleware;
const supabase_js_1 = require("@supabase/supabase-js");
const CACHE_TTL_MS = 60 * 1000; // 60 segundos
const accessCache = new Map();
function clearAccessCache() {
    accessCache.clear();
}
let supabaseInstance = null;
function getSupabaseClient() {
    if (supabaseInstance)
        return supabaseInstance;
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (url && key) {
        try {
            let safeUrl = url.startsWith('http') ? url : `https://${url}`;
            supabaseInstance = (0, supabase_js_1.createClient)(safeUrl, key);
        }
        catch (e) {
            console.error('[Supabase Client Error]', e.message);
        }
    }
    return supabaseInstance;
}
function setSupabaseClient(client) {
    supabaseInstance = client;
}
/**
 * Valida la autorización de acceso a contenido H5P o SCORM según el rol del usuario y sus matrículas en Supabase.
 */
async function authorizeContentAccess(user, contentId, kind, customSupabase, activityIdHint) {
    const cacheKey = `${user.id}:${user.tenant_id}:${kind}:${contentId}:${activityIdHint || ''}`;
    const now = Date.now();
    const cached = accessCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
        return cached.result;
    }
    const supabase = customSupabase !== undefined ? customSupabase : getSupabaseClient();
    if (!supabase) {
        console.warn('[authorizeContentAccess] Supabase client no configurado. Permitiendo en modo degradado para no romper dev.');
        const devResult = { ok: true };
        return devResult;
    }
    try {
        // 1. Buscar la actividad en Supabase
        let activity = null;
        // Intento 0: Si viene activityIdHint
        if (activityIdHint && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(activityIdHint)) {
            const { data, error } = await supabase
                .from('activities')
                .select('id, tenant_id, module_id, modules(course_id)')
                .eq('id', activityIdHint)
                .maybeSingle();
            if (error) {
                console.warn('[authorizeContentAccess] Error querying by activityIdHint:', error.message);
            }
            else if (data) {
                const courseId = data.modules?.course_id || data.course_id;
                activity = {
                    id: data.id,
                    tenant_id: data.tenant_id,
                    course_id: courseId,
                    module_id: data.module_id,
                };
            }
        }
        // Intento A: ID directo de actividad
        const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(contentId);
        if (!activity && isUuid) {
            const { data, error } = await supabase
                .from('activities')
                .select('id, tenant_id, module_id, modules(course_id)')
                .eq('id', contentId)
                .maybeSingle();
            if (error) {
                console.warn('[authorizeContentAccess] Error querying by direct ID:', error.message);
            }
            else if (data) {
                const courseId = data.modules?.course_id || data.course_id;
                activity = {
                    id: data.id,
                    tenant_id: data.tenant_id,
                    course_id: courseId,
                    module_id: data.module_id,
                };
            }
        }
        // Intento B: Buscar en metadatos de content (scormId, scorm_id, h5pId, h5p_content_id, etc.)
        if (!activity) {
            const { data, error } = await supabase
                .from('activities')
                .select('id, tenant_id, module_id, content, modules(course_id)')
                .or(`content->>scormId.eq.${contentId},content->>scorm_id.eq.${contentId},content->>h5pId.eq.${contentId},content->>h5p_id.eq.${contentId},content->>h5p_content_id.eq.${contentId},content->>contentId.eq.${contentId},content->>packageId.eq.${contentId}`)
                .maybeSingle();
            if (error) {
                console.warn('[authorizeContentAccess] Error querying by metadata:', error.message);
            }
            else if (data) {
                const courseId = data.modules?.course_id || data.course_id;
                activity = {
                    id: data.id,
                    tenant_id: data.tenant_id,
                    course_id: courseId,
                    module_id: data.module_id,
                };
            }
        }
        // Si aún no se encuentra, devolver 404
        if (!activity) {
            console.warn(`[authorizeContentAccess] Content ${contentId} (hint: ${activityIdHint}) not found in activities`);
            const notFoundResult = {
                ok: false,
                status: 404,
                reason: 'content_not_found',
            };
            accessCache.set(cacheKey, { result: notFoundResult, expiresAt: now + CACHE_TTL_MS });
            return notFoundResult;
        }
        // Resolver course_id a través de module_id si no está presente
        if (!activity.course_id && activity.module_id) {
            try {
                const { data: modData } = await supabase
                    .from('modules')
                    .select('course_id')
                    .eq('id', activity.module_id)
                    .maybeSingle();
                if (modData?.course_id) {
                    activity.course_id = modData.course_id;
                }
            }
            catch (modErr) {
                console.warn('[authorizeContentAccess] Error resolving module course_id:', modErr.message);
            }
        }
        // 2. Validar pertenencia a Tenant
        if (activity.tenant_id !== user.tenant_id) {
            console.error(`[Security] Cross-tenant content play attempt: user=${user.id} user_tenant=${user.tenant_id} activity_tenant=${activity.tenant_id} content=${contentId}`);
            const crossTenantResult = {
                ok: false,
                status: 403,
                reason: 'cross_tenant',
            };
            accessCache.set(cacheKey, { result: crossTenantResult, expiresAt: now + CACHE_TTL_MS });
            return crossTenantResult;
        }
        // 3. Reglas por Rol
        if (user.role === 'admin' || user.role === 'teacher') {
            const okResult = { ok: true };
            accessCache.set(cacheKey, { result: okResult, expiresAt: now + CACHE_TTL_MS });
            return okResult;
        }
        if (user.role === 'student') {
            if (!activity.course_id) {
                // Si la actividad no tiene course_id asociado (huérfana), denegar por seguridad
                const noCourseResult = { ok: false, status: 403, reason: 'no_enrollment' };
                accessCache.set(cacheKey, { result: noCourseResult, expiresAt: now + CACHE_TTL_MS });
                return noCourseResult;
            }
            // Validar matrícula activa en el curso
            const { data: enrollment, error: enrError } = await supabase
                .from('enrollments')
                .select('id')
                .eq('tenant_id', user.tenant_id)
                .eq('student_id', user.id)
                .eq('course_id', activity.course_id)
                .maybeSingle();
            if (enrError || !enrollment) {
                console.warn(`[Security] Student access denied (no enrollment): student=${user.id} course=${activity.course_id} content=${contentId}`);
                const noEnrResult = {
                    ok: false,
                    status: 403,
                    reason: 'no_enrollment',
                };
                accessCache.set(cacheKey, { result: noEnrResult, expiresAt: now + CACHE_TTL_MS });
                return noEnrResult;
            }
            const okResult = { ok: true };
            accessCache.set(cacheKey, { result: okResult, expiresAt: now + CACHE_TTL_MS });
            return okResult;
        }
        // Cualquier otro rol
        const roleDeniedResult = {
            ok: false,
            status: 403,
            reason: 'role_denied',
        };
        accessCache.set(cacheKey, { result: roleDeniedResult, expiresAt: now + CACHE_TTL_MS });
        return roleDeniedResult;
    }
    catch (err) {
        console.error('[authorizeContentAccess Error]', err);
        return { ok: false, status: 403, reason: 'role_denied' };
    }
}
/**
 * Middleware Express para proteger rutas de H5P Player y subrecursos.
 */
async function createAuthorizePlayMiddleware(kind) {
    return async (req, res, next) => {
        if (!req.user) {
            res.status(401).json({ error: 'Unauthorized: Authentication required' });
            return;
        }
        const contentId = req.params.contentId || req.params.id || req.params[0];
        if (!contentId) {
            next();
            return;
        }
        const authCheck = await authorizeContentAccess(req.user, String(contentId), kind);
        if (!authCheck.ok) {
            if (authCheck.status === 404) {
                res.status(404).json({ error: 'Not Found: Content does not exist' });
                return;
            }
            res.status(403).json({ error: `Forbidden: Access denied (${authCheck.reason})` });
            return;
        }
        next();
    };
}
