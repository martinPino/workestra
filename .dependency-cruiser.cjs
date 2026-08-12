/**
 * Gates de arquitectura (Clean Architecture / SOLID).
 * Un import prohibido rompe el build (severity: error) — criterio de aceptación de M0.
 */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      comment: 'No se permiten dependencias circulares.',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'engine-domain-are-pure',
      comment:
        'domain y engine NO pueden depender de frameworks (NestJS), ORM (Prisma) ni infraestructura (bullmq/ioredis) ni de adaptadores (@core/infra).',
      severity: 'error',
      from: { path: '^packages/(domain|engine)/src' },
      to: {
        path: [
          '@nestjs',
          '@prisma/client',
          '^bullmq',
          '^ioredis',
          '@core/infra',
          '^packages/infra',
        ],
      },
    },
    {
      name: 'domain-is-innermost',
      comment: 'domain es la capa más interna: no depende de engine/infra/sdk-plugins.',
      severity: 'error',
      from: { path: '^packages/domain/src' },
      to: { path: ['@core/(engine|infra|sdk-plugins)', '^packages/(engine|infra|sdk-plugins)'] },
    },
    {
      name: 'web-never-imports-backend-core',
      comment: 'El frontend solo consume @core/contracts, nunca engine/infra.',
      severity: 'error',
      from: { path: '^apps/web/src' },
      to: { path: ['@core/(engine|infra)', '^packages/(engine|infra)', '@nestjs', '@prisma/client'] },
    },
    {
      name: 'no-orphans',
      comment: 'Módulos sin usar (avisa, no rompe).',
      severity: 'warn',
      from: {
        orphan: true,
        pathNot: [
          '\\.d\\.ts$',
          '(^|/)index\\.ts$',
          '(^|/)(main|demo)\\.tsx?$',
          '\\.(test|spec)\\.ts$',
          '\\.config\\.(js|cjs|mjs|ts)$',
          // Stubs que solo referencia el `alias` de wrangler.jsonc en tiempo de build: nadie los
          // importa desde el código, y sin esto su aviso de huérfano taparía los huérfanos de verdad.
          '^apps/api/src/stubs/',
        ],
      },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)dist/' },
    tsConfig: { fileName: 'tsconfig.base.json' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
    },
  },
};
