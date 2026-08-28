import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import jwt from 'jsonwebtoken';
import http from 'http';
import express from 'express';
import { requireAuth, requireRole, enforceTenantMatch, extractAndVerifyToken } from '../middleware/auth';

const TEST_SECRET = 'super-secret-test-jwt-key-32-chars-long!!';
process.env.SUPABASE_JWT_SECRET = TEST_SECRET;

describe('Security & JWT Authentication Middleware', () => {
  const teacherToken = jwt.sign(
    {
      sub: 'teacher-uuid-1',
      email: 'teacher@tenant1.com',
      app_metadata: { role: 'teacher', tenant_id: 'tenant-1-uuid' },
      user_metadata: { name: 'Profesor Uno' }
    },
    TEST_SECRET,
    { algorithm: 'HS256', expiresIn: '1h' }
  );

  const studentToken = jwt.sign(
    {
      sub: 'student-uuid-1',
      email: 'student@tenant1.com',
      app_metadata: { role: 'student', tenant_id: 'tenant-1-uuid' },
      user_metadata: { name: 'Alumno Uno' }
    },
    TEST_SECRET,
    { algorithm: 'HS256', expiresIn: '1h' }
  );

  const adminToken = jwt.sign(
    {
      sub: 'admin-uuid-1',
      email: 'admin@tenant1.com',
      app_metadata: { role: 'admin', tenant_id: 'tenant-1-uuid' },
      user_metadata: { name: 'Admin Uno' }
    },
    TEST_SECRET,
    { algorithm: 'HS256', expiresIn: '1h' }
  );

  const expiredToken = jwt.sign(
    {
      sub: 'expired-uuid',
      email: 'exp@tenant1.com',
      app_metadata: { role: 'teacher', tenant_id: 'tenant-1-uuid' }
    },
    TEST_SECRET,
    { algorithm: 'HS256', expiresIn: '-1s' }
  );

  const noTenantToken = jwt.sign(
    {
      sub: 'notenant-uuid',
      email: 'notenant@test.com',
      app_metadata: { role: 'teacher' }
    },
    TEST_SECRET,
    { algorithm: 'HS256', expiresIn: '1h' }
  );

  let app: express.Express;
  let server: http.Server;
  let baseUrl: string;

  before(async () => {
    app = express();
    app.use(express.json());

    // Public route
    app.get('/health', (_req, res) => res.status(200).json({ status: 'ready' }));

    // Protected write route
    app.post('/upload', requireAuth, requireRole('teacher', 'admin'), (req, res) => {
      const requestedTenant = req.headers['x-upload-tenant'] as string | undefined;
      if (requestedTenant && !enforceTenantMatch(req, requestedTenant)) {
        res.status(403).json({ error: 'Forbidden: Cannot upload to another tenant' });
        return;
      }
      res.status(200).json({ success: true, tenantId: req.user!.tenant_id });
    });

    // Protected read route
    app.get('/h5p/play/:id', requireAuth, (req, res) => {
      res.status(200).json({ play: true, user: req.user });
    });

    // Publish route with tenant match check
    app.post('/api/publish', requireAuth, requireRole('teacher', 'admin'), (req, res) => {
      const { tenantId, activityId } = req.body;
      if (tenantId && !enforceTenantMatch(req, tenantId)) {
        res.status(403).json({ error: 'Forbidden: Cannot publish to another tenant' });
        return;
      }
      res.status(200).json({ published: true, activityId, tenantId: req.user!.tenant_id });
    });

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const address = server.address() as any;
        baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('1. Public /health returns 200 without token', async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert.strictEqual(res.status, 200);
  });

  it('2. POST /upload without Authorization header returns 401', async () => {
    const res = await fetch(`${baseUrl}/upload`, { method: 'POST' });
    assert.strictEqual(res.status, 401);
    const body = await res.json() as any;
    assert.match(body.error, /Unauthorized/i);
  });

  it('3. POST /upload with invalid token signature returns 401', async () => {
    const res = await fetch(`${baseUrl}/upload`, {
      method: 'POST',
      headers: { Authorization: 'Bearer invalid.token.payload' }
    });
    assert.strictEqual(res.status, 401);
  });

  it('4. POST /upload with expired token returns 401', async () => {
    const res = await fetch(`${baseUrl}/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${expiredToken}` }
    });
    assert.strictEqual(res.status, 401);
    const body = await res.json() as any;
    assert.match(body.error, /expired/i);
  });

  it('5. POST /upload with token missing tenant returns 403', async () => {
    const res = await fetch(`${baseUrl}/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${noTenantToken}` }
    });
    assert.strictEqual(res.status, 403);
  });

  it('6. POST /upload with student role returns 403 Forbidden', async () => {
    const res = await fetch(`${baseUrl}/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${studentToken}` }
    });
    assert.strictEqual(res.status, 403);
    const body = await res.json() as any;
    assert.match(body.error, /Insufficient role/i);
  });

  it('7. POST /upload with teacher role and matching tenant returns 200', async () => {
    const res = await fetch(`${baseUrl}/upload`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${teacherToken}`,
        'x-upload-tenant': 'tenant-1-uuid'
      }
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json() as any;
    assert.strictEqual(body.tenantId, 'tenant-1-uuid');
  });

  it('8. POST /upload with teacher role but mismatching x-upload-tenant returns 403 (cross-tenant)', async () => {
    const res = await fetch(`${baseUrl}/upload`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${teacherToken}`,
        'x-upload-tenant': 'tenant-attacker-uuid'
      }
    });
    assert.strictEqual(res.status, 403);
  });

  it('9. POST /api/publish with teacher role and matching tenant returns 200', async () => {
    const res = await fetch(`${baseUrl}/api/publish`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${teacherToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        activityId: 'act-123',
        tenantId: 'tenant-1-uuid',
        contentId: '10'
      })
    });
    assert.strictEqual(res.status, 200);
  });

  it('10. POST /api/publish with mismatched body tenantId returns 403', async () => {
    const res = await fetch(`${baseUrl}/api/publish`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${teacherToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        activityId: 'act-123',
        tenantId: 'tenant-attacker-uuid',
        contentId: '10'
      })
    });
    assert.strictEqual(res.status, 403);
  });

  it('11. GET /h5p/play/123 with valid student token returns 200', async () => {
    const res = await fetch(`${baseUrl}/h5p/play/123`, {
      headers: { Authorization: `Bearer ${studentToken}` }
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json() as any;
    assert.strictEqual(body.user.role, 'student');
  });

  it('12. GET /h5p/play/123 with query param ?token=<studentToken> returns 200', async () => {
    const res = await fetch(`${baseUrl}/h5p/play/123?token=${studentToken}`);
    assert.strictEqual(res.status, 200);
    const body = await res.json() as any;
    assert.strictEqual(body.user.id, 'student-uuid-1');
  });
});
