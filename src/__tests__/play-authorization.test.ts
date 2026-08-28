import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import jwt from 'jsonwebtoken';
import http from 'http';
import express from 'express';
import { requireAuth } from '../middleware/auth';
import {
  authorizeContentAccess,
  clearAccessCache,
  setSupabaseClient,
} from '../middleware/authorizeContentAccess';

const TEST_SECRET = 'jwt-secret-play-auth-testing-32-chars!!';
process.env.SUPABASE_JWT_SECRET = TEST_SECRET;

describe('Play & Content Authorization Suite', () => {
  const tenantA = 'tenant-aaa-uuid';
  const tenantB = 'tenant-bbb-uuid';
  const course1 = 'course-111-uuid';
  const course2 = 'course-222-uuid';

  const contentH5P_1 = 'h5p-content-100';
  const contentH5P_2 = 'h5p-content-200';
  const contentSCORM_1 = 'scorm-content-300';
  const contentNonExistent = 'non-existent-content-999';

  // Tokens
  const studentAlphaToken = jwt.sign(
    { sub: 'student-alpha', email: 'alpha@tenantA.com', app_metadata: { role: 'student', tenant_id: tenantA } },
    TEST_SECRET, { algorithm: 'HS256', expiresIn: '1h' }
  );

  const studentBetaToken = jwt.sign(
    { sub: 'student-beta', email: 'beta@tenantA.com', app_metadata: { role: 'student', tenant_id: tenantA } },
    TEST_SECRET, { algorithm: 'HS256', expiresIn: '1h' }
  );

  const studentGammaToken = jwt.sign(
    { sub: 'student-gamma', email: 'gamma@tenantB.com', app_metadata: { role: 'student', tenant_id: tenantB } },
    TEST_SECRET, { algorithm: 'HS256', expiresIn: '1h' }
  );

  const teacherAToken = jwt.sign(
    { sub: 'teacher-a', email: 'teacherA@tenantA.com', app_metadata: { role: 'teacher', tenant_id: tenantA } },
    TEST_SECRET, { algorithm: 'HS256', expiresIn: '1h' }
  );

  const teacherBToken = jwt.sign(
    { sub: 'teacher-b', email: 'teacherB@tenantB.com', app_metadata: { role: 'teacher', tenant_id: tenantB } },
    TEST_SECRET, { algorithm: 'HS256', expiresIn: '1h' }
  );

  const adminAToken = jwt.sign(
    { sub: 'admin-a', email: 'adminA@tenantA.com', app_metadata: { role: 'admin', tenant_id: tenantA } },
    TEST_SECRET, { algorithm: 'HS256', expiresIn: '1h' }
  );

  const adminBToken = jwt.sign(
    { sub: 'admin-b', email: 'adminB@tenantB.com', app_metadata: { role: 'admin', tenant_id: tenantB } },
    TEST_SECRET, { algorithm: 'HS256', expiresIn: '1h' }
  );

  const expiredToken = jwt.sign(
    { sub: 'expired-user', app_metadata: { role: 'student', tenant_id: tenantA } },
    TEST_SECRET, { algorithm: 'HS256', expiresIn: '-10s' }
  );

  const unknownRoleToken = jwt.sign(
    { sub: 'unknown-user', app_metadata: { role: 'guest', tenant_id: tenantA } },
    TEST_SECRET, { algorithm: 'HS256', expiresIn: '1h' }
  );

  let app: express.Express;
  let server: http.Server;
  let baseUrl: string;
  let dbQueryCount = 0;

  // Mock de Supabase para actividades y matrículas
  const mockSupabase: any = {
    from: (table: string) => {
      return {
        select: (_cols: string) => {
          let currentField: string | null = null;
          let currentValue: any = null;
          let currentOrFilter: string | null = null;
          const filterChain: Record<string, any> = {};

          const builder: any = {
            eq: (field: string, val: any) => {
              currentField = field;
              currentValue = val;
              filterChain[field] = val;
              return builder;
            },
            or: (orClause: string) => {
              currentOrFilter = orClause;
              return builder;
            },
            maybeSingle: async () => {
              dbQueryCount++;
              if (table === 'activities') {
                const targetContent = currentValue || currentOrFilter;
                if (currentValue === contentH5P_1 || (currentOrFilter && currentOrFilter.includes(contentH5P_1))) {
                  return {
                    data: {
                      id: 'act-uuid-1',
                      tenant_id: tenantA,
                      module_id: 'mod-1',
                      modules: { course_id: course1 }
                    },
                    error: null
                  };
                }
                if (currentValue === contentH5P_2 || (currentOrFilter && currentOrFilter.includes(contentH5P_2))) {
                  return {
                    data: {
                      id: 'act-uuid-2',
                      tenant_id: tenantA,
                      module_id: 'mod-2',
                      modules: { course_id: course2 }
                    },
                    error: null
                  };
                }
                if (currentValue === contentSCORM_1 || (currentOrFilter && currentOrFilter.includes(contentSCORM_1))) {
                  return {
                    data: {
                      id: 'act-uuid-scorm-1',
                      tenant_id: tenantA,
                      module_id: 'mod-1',
                      modules: { course_id: course1 }
                    },
                    error: null
                  };
                }
                return { data: null, error: null };
              }

              if (table === 'enrollments') {
                // studentAlpha está matriculado en course1 de tenantA
                if (
                  filterChain['student_id'] === 'student-alpha' &&
                  filterChain['tenant_id'] === tenantA &&
                  filterChain['course_id'] === course1
                ) {
                  return { data: { id: 'enr-alpha-1' }, error: null };
                }
                // Otros no tienen matrícula
                return { data: null, error: null };
              }

              return { data: null, error: null };
            }
          };
          return builder;
        }
      };
    }
  };

  before(async () => {
    setSupabaseClient(mockSupabase);

    app = express();
    app.use(express.json());

    // Public health
    app.get('/health', (_req, res) => res.status(200).json({ status: 'ready' }));

    // H5P Play Middleware & Routes (cubre subrutas)
    app.use('/h5p/play/:contentId', requireAuth, async (req, res, next) => {
      const contentId = String(req.params.contentId);
      const authCheck = await authorizeContentAccess(req.user!, contentId, 'h5p', mockSupabase);
      if (!authCheck.ok) {
        if (authCheck.status === 404) {
          res.status(404).json({ error: 'Not Found: H5P content does not exist' });
          return;
        }
        res.status(403).json({ error: `Forbidden: Access denied (${authCheck.reason})` });
        return;
      }
      next();
    });

    app.get('/h5p/play/:contentId', (req, res) => {
      res.status(200).json({ play: true, contentId: req.params.contentId });
    });

    app.get('/h5p/play/:contentId/*', (req, res) => {
      res.status(200).json({ playSubresource: true, path: req.url });
    });

    // SCORM Play Middleware & Routes
    app.use('/scorm/play/:id', requireAuth, async (req, res, next) => {
      const scormId = String(req.params.id);
      const authCheck = await authorizeContentAccess(req.user!, scormId, 'scorm', mockSupabase);
      if (!authCheck.ok) {
        if (authCheck.status === 404) {
          res.status(404).json({ error: 'Not Found: SCORM content does not exist' });
          return;
        }
        res.status(403).json({ error: `Forbidden: Access denied (${authCheck.reason})` });
        return;
      }
      next();
    });

    app.get('/scorm/play/:id', (req, res) => {
      res.status(200).json({ playScorm: true, id: req.params.id });
    });

    app.get('/scorm/play/:id/*', (req, res) => {
      res.status(200).json({ playScormSubresource: true, path: req.url });
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

  beforeEach(() => {
    clearAccessCache();
    dbQueryCount = 0;
  });

  // -------------------------------------------------------------
  // H5P PLAY TESTS
  // -------------------------------------------------------------
  it('1. student sin enrollment en el curso -> 403 (no_enrollment)', async () => {
    const res = await fetch(`${baseUrl}/h5p/play/${contentH5P_1}`, {
      headers: { Authorization: `Bearer ${studentBetaToken}` }
    });
    assert.strictEqual(res.status, 403);
    const body = await res.json() as any;
    assert.match(body.error, /no_enrollment/i);
  });

  it('2. student con enrollment en otro curso del mismo tenant -> 403 (no_enrollment)', async () => {
    const res = await fetch(`${baseUrl}/h5p/play/${contentH5P_2}`, {
      headers: { Authorization: `Bearer ${studentAlphaToken}` }
    });
    assert.strictEqual(res.status, 403);
    const body = await res.json() as any;
    assert.match(body.error, /no_enrollment/i);
  });

  it('3. student con enrollment activo en el curso del contenido -> 200', async () => {
    const res = await fetch(`${baseUrl}/h5p/play/${contentH5P_1}`, {
      headers: { Authorization: `Bearer ${studentAlphaToken}` }
    });
    assert.strictEqual(res.status, 200);
  });

  it('4. student de otro tenant (mismo contentId) -> 403 (cross_tenant)', async () => {
    const res = await fetch(`${baseUrl}/h5p/play/${contentH5P_1}`, {
      headers: { Authorization: `Bearer ${studentGammaToken}` }
    });
    assert.strictEqual(res.status, 403);
    const body = await res.json() as any;
    assert.match(body.error, /cross_tenant/i);
  });

  it('5. teacher del mismo tenant -> 200', async () => {
    const res = await fetch(`${baseUrl}/h5p/play/${contentH5P_1}`, {
      headers: { Authorization: `Bearer ${teacherAToken}` }
    });
    assert.strictEqual(res.status, 200);
  });

  it('6. teacher de otro tenant -> 403 (cross_tenant)', async () => {
    const res = await fetch(`${baseUrl}/h5p/play/${contentH5P_1}`, {
      headers: { Authorization: `Bearer ${teacherBToken}` }
    });
    assert.strictEqual(res.status, 403);
    const body = await res.json() as any;
    assert.match(body.error, /cross_tenant/i);
  });

  it('7. admin del mismo tenant -> 200', async () => {
    const res = await fetch(`${baseUrl}/h5p/play/${contentH5P_1}`, {
      headers: { Authorization: `Bearer ${adminAToken}` }
    });
    assert.strictEqual(res.status, 200);
  });

  it('8. admin de otro tenant -> 403 (cross_tenant)', async () => {
    const res = await fetch(`${baseUrl}/h5p/play/${contentH5P_1}`, {
      headers: { Authorization: `Bearer ${adminBToken}` }
    });
    assert.strictEqual(res.status, 403);
    const body = await res.json() as any;
    assert.match(body.error, /cross_tenant/i);
  });

  it('9. contentId inexistente -> 404 (content_not_found)', async () => {
    const res = await fetch(`${baseUrl}/h5p/play/${contentNonExistent}`, {
      headers: { Authorization: `Bearer ${teacherAToken}` }
    });
    assert.strictEqual(res.status, 404);
  });

  it('10. sin Authorization ni ?token= -> 401', async () => {
    const res = await fetch(`${baseUrl}/h5p/play/${contentH5P_1}`);
    assert.strictEqual(res.status, 401);
  });

  it('11. token expirado -> 401', async () => {
    const res = await fetch(`${baseUrl}/h5p/play/${contentH5P_1}`, {
      headers: { Authorization: `Bearer ${expiredToken}` }
    });
    assert.strictEqual(res.status, 401);
  });

  it('12. token con rol desconocido/denegado -> 403', async () => {
    const res = await fetch(`${baseUrl}/h5p/play/${contentH5P_1}`, {
      headers: { Authorization: `Bearer ${unknownRoleToken}` }
    });
    assert.strictEqual(res.status, 403);
  });

  // -------------------------------------------------------------
  // SCORM PLAY TESTS
  // -------------------------------------------------------------
  it('13. student con enrollment activo en SCORM -> 200', async () => {
    const res = await fetch(`${baseUrl}/scorm/play/${contentSCORM_1}`, {
      headers: { Authorization: `Bearer ${studentAlphaToken}` }
    });
    assert.strictEqual(res.status, 200);
  });

  it('14. student sin enrollment en SCORM -> 403', async () => {
    const res = await fetch(`${baseUrl}/scorm/play/${contentSCORM_1}`, {
      headers: { Authorization: `Bearer ${studentBetaToken}` }
    });
    assert.strictEqual(res.status, 403);
  });

  // -------------------------------------------------------------
  // SUBRECURSOS INTERNOS
  // -------------------------------------------------------------
  it('15. Subrecurso interno con alumno matriculado -> 200', async () => {
    const res = await fetch(`${baseUrl}/h5p/play/${contentH5P_1}/img/logo.png`, {
      headers: { Authorization: `Bearer ${studentAlphaToken}` }
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json() as any;
    assert.strictEqual(body.playSubresource, true);
  });

  it('16. Subrecurso interno con alumno NO matriculado -> 403', async () => {
    const res = await fetch(`${baseUrl}/h5p/play/${contentH5P_1}/img/logo.png`, {
      headers: { Authorization: `Bearer ${studentBetaToken}` }
    });
    assert.strictEqual(res.status, 403);
  });

  // -------------------------------------------------------------
  // CACHÉ EN MEMORIA (60s)
  // -------------------------------------------------------------
  it('17. Dos llamadas seguidas del mismo usuario al mismo contentId usan caché (1 consulta a BD)', async () => {
    dbQueryCount = 0;
    // Llamada 1
    const res1 = await fetch(`${baseUrl}/h5p/play/${contentH5P_1}`, {
      headers: { Authorization: `Bearer ${studentAlphaToken}` }
    });
    assert.strictEqual(res1.status, 200);
    const queriesAfterFirst = dbQueryCount;
    assert.ok(queriesAfterFirst >= 1, 'Debe haber hecho consulta inicial');

    // Llamada 2 (inmediata)
    const res2 = await fetch(`${baseUrl}/h5p/play/${contentH5P_1}`, {
      headers: { Authorization: `Bearer ${studentAlphaToken}` }
    });
    assert.strictEqual(res2.status, 200);
    assert.strictEqual(dbQueryCount, queriesAfterFirst, 'La segunda llamada debe ser atendida desde la caché sin nueva consulta SQL');
  });
});
