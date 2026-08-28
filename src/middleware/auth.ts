import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'teacher' | 'student' | string;
  tenant_id: string;
  raw?: any;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

/**
 * Extrae y valida el token JWT de Supabase (HS256).
 * Soporta Header 'Authorization: Bearer <token>' y Query Parameter '?token=<token>' (para iframes).
 */
export function extractAndVerifyToken(req: Request): AuthUser {
  let token: string | undefined;

  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7).trim();
  } else if (req.query.token && typeof req.query.token === 'string') {
    token = req.query.token.trim();
  }

  if (!token) {
    throw new Error('AUTH_MISSING_TOKEN');
  }

  const jwtSecret = process.env.SUPABASE_JWT_SECRET || '';
  if (!jwtSecret) {
    console.error('[requireAuth] SUPABASE_JWT_SECRET no está configurado en el entorno.');
    throw new Error('AUTH_CONFIG_ERROR');
  }

  let decoded: any;
  try {
    decoded = jwt.verify(token, jwtSecret, { algorithms: ['HS256'] });
  } catch (err: any) {
    if (err.name === 'TokenExpiredError') {
      throw new Error('AUTH_TOKEN_EXPIRED');
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
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  try {
    const user = extractAndVerifyToken(req);
    req.user = user;
    next();
  } catch (err: any) {
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
export function requireRole(...allowedRoles: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized: User authentication required' });
      return;
    }

    if (!allowedRoles.includes(req.user.role)) {
      console.warn(
        `[Security] Forbidden role access attempt: user=${req.user.id}, role=${req.user.role}, required=${allowedRoles.join(',')}, endpoint=${req.originalUrl}`
      );
      res.status(403).json({ error: `Forbidden: Insufficient role permissions. Required: ${allowedRoles.join(' or ')}` });
      return;
    }

    next();
  };
}

/**
 * Valida que el tenant recibido en el request (header, body o param) coincida con el tenant del JWT.
 */
export function enforceTenantMatch(req: Request, targetTenantId?: string): boolean {
  if (!req.user) return false;
  if (!targetTenantId) return true; // Si no se envió tenant_id explícito, se usa el de req.user

  if (targetTenantId !== req.user.tenant_id) {
    console.error(
      `[Security/Integrity] Cross-tenant attempt blocked: user=${req.user.id}, jwt_tenant=${req.user.tenant_id}, requested_tenant=${targetTenantId}, endpoint=${req.originalUrl}`
    );
    return false;
  }

  return true;
}
