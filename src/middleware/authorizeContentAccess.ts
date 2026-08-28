import { Request, Response, NextFunction } from 'express';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { AuthUser } from './auth';

export interface AuthorizeResult {
  ok: boolean;
  status?: 200 | 401 | 403 | 404;
  reason?: 'content_not_found' | 'cross_tenant' | 'no_enrollment' | 'role_denied' | string;
}

interface CacheEntry {
  result: AuthorizeResult;
  expiresAt: number;
}

const CACHE_TTL_MS = 60 * 1000; // 60 segundos
const accessCache = new Map<string, CacheEntry>();

export function clearAccessCache(): void {
  accessCache.clear();
}

let supabaseInstance: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient | null {
  if (supabaseInstance) return supabaseInstance;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (url && key) {
    try {
      let safeUrl = url.startsWith('http') ? url : `https://${url}`;
      supabaseInstance = createClient(safeUrl, key);
    } catch (e: any) {
      console.error('[Supabase Client Error]', e.message);
    }
  }
  return supabaseInstance;
}

export function setSupabaseClient(client: SupabaseClient | null): void {
  supabaseInstance = client;
}

/**
 * Valida la autorización de acceso a contenido H5P o SCORM según el rol del usuario y sus matrículas en Supabase.
 */
export async function authorizeContentAccess(
  user: { id: string; role: string; tenant_id: string },
  contentId: string,
  kind: 'h5p' | 'scorm',
  customSupabase?: SupabaseClient | null
): Promise<AuthorizeResult> {
  const cacheKey = `${user.id}:${user.tenant_id}:${kind}:${contentId}`;
  const now = Date.now();

  const cached = accessCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.result;
  }

  const supabase = customSupabase !== undefined ? customSupabase : getSupabaseClient();

  if (!supabase) {
    console.warn('[authorizeContentAccess] Supabase client no configurado. Permitiendo en modo degradado para no romper dev.');
    const devResult: AuthorizeResult = { ok: true };
    return devResult;
  }

  try {
    // 1. Buscar la actividad en Supabase
    // Puede ser por id directo (UUID) o por metadatos (content->>h5p_content_id o content->>scorm_id)
    let activity: { id: string; tenant_id: string; course_id?: string; module_id?: string } | null = null;

    // Intento A: ID directo
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(contentId);
    if (isUuid) {
      const { data, error } = await supabase
        .from('activities')
        .select('id, tenant_id, module_id, modules(course_id)')
        .eq('id', contentId)
        .maybeSingle();

      if (!error && data) {
        const courseId = (data.modules as any)?.course_id || (data as any).course_id;
        activity = {
          id: data.id,
          tenant_id: data.tenant_id,
          course_id: courseId,
          module_id: data.module_id,
        };
      }
    }

    // Intento B: Si no se encontró por ID directo, buscar por content metadata
    if (!activity) {
      const { data, error } = await supabase
        .from('activities')
        .select('id, tenant_id, module_id, content, modules(course_id)')
        .or(`content->>h5p_content_id.eq.${contentId},content->>scorm_id.eq.${contentId},content->>contentId.eq.${contentId}`)
        .maybeSingle();

      if (!error && data) {
        const courseId = (data.modules as any)?.course_id || (data as any).course_id;
        activity = {
          id: data.id,
          tenant_id: data.tenant_id,
          course_id: courseId,
          module_id: data.module_id,
        };
      }
    }

    // Si aún no se encuentra, buscar en courses si es id de curso o recurso inexistente
    if (!activity) {
      console.warn(`[authorizeContentAccess] Content ${contentId} not found in activities`);
      const notFoundResult: AuthorizeResult = {
        ok: false,
        status: 404,
        reason: 'content_not_found',
      };
      accessCache.set(cacheKey, { result: notFoundResult, expiresAt: now + CACHE_TTL_MS });
      return notFoundResult;
    }

    // 2. Validar pertenencia a Tenant
    if (activity.tenant_id !== user.tenant_id) {
      console.error(
        `[Security] Cross-tenant content play attempt: user=${user.id} user_tenant=${user.tenant_id} activity_tenant=${activity.tenant_id} content=${contentId}`
      );
      const crossTenantResult: AuthorizeResult = {
        ok: false,
        status: 403,
        reason: 'cross_tenant',
      };
      accessCache.set(cacheKey, { result: crossTenantResult, expiresAt: now + CACHE_TTL_MS });
      return crossTenantResult;
    }

    // 3. Reglas por Rol
    if (user.role === 'admin' || user.role === 'teacher') {
      const okResult: AuthorizeResult = { ok: true };
      accessCache.set(cacheKey, { result: okResult, expiresAt: now + CACHE_TTL_MS });
      return okResult;
    }

    if (user.role === 'student') {
      if (!activity.course_id) {
        // Si la actividad no tiene course_id asociado (huérfana), denegar por seguridad
        const noCourseResult: AuthorizeResult = { ok: false, status: 403, reason: 'no_enrollment' };
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
        console.warn(
          `[Security] Student access denied (no enrollment): student=${user.id} course=${activity.course_id} content=${contentId}`
        );
        const noEnrResult: AuthorizeResult = {
          ok: false,
          status: 403,
          reason: 'no_enrollment',
        };
        accessCache.set(cacheKey, { result: noEnrResult, expiresAt: now + CACHE_TTL_MS });
        return noEnrResult;
      }

      const okResult: AuthorizeResult = { ok: true };
      accessCache.set(cacheKey, { result: okResult, expiresAt: now + CACHE_TTL_MS });
      return okResult;
    }

    // Cualquier otro rol
    const roleDeniedResult: AuthorizeResult = {
      ok: false,
      status: 403,
      reason: 'role_denied',
    };
    accessCache.set(cacheKey, { result: roleDeniedResult, expiresAt: now + CACHE_TTL_MS });
    return roleDeniedResult;
  } catch (err: any) {
    console.error('[authorizeContentAccess Error]', err);
    return { ok: false, status: 403, reason: 'role_denied' };
  }
}

/**
 * Middleware Express para proteger rutas de H5P Player y subrecursos.
 */
export async function createAuthorizePlayMiddleware(kind: 'h5p' | 'scorm') {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized: Authentication required' });
      return;
    }

    const contentId = req.params.contentId || req.params.id || (req.params as any)[0];
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
