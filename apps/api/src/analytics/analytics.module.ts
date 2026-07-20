import { Module } from '@nestjs/common';
import type { AnalyticsSink } from '@core/contracts';
import { NoopAnalyticsSink, PostgresAnalyticsSink } from '@core/infra';
import { PersistenceModule, PERSISTENCE, type PersistenceBundle } from '../persistence/persistence.module';
import { RbacModule } from '../rbac/rbac.module';
import { AnalyticsService, ANALYTICS_SINK } from './analytics.service';
import { IngestController, InsightsController, PlatformInsightsController } from './analytics.controller';
import { PlatformAdminGuard, PlatformAdminService } from './platform-admin.guard';

/**
 * Analítica de producto (M84).
 *
 * El almacén se inyecta por token, no se importa: cambiar Postgres por un motor columnar el día que haga
 * falta es escribir otro adaptador y tocar esta fábrica. Los umbrales que disparan esa mudanza los mide
 * el rollup y los deja en `AnalyticsRollupWatermark.metrics`, porque un umbral que nadie mide no es un
 * umbral, es un comentario.
 *
 * Sin Postgres (modo memoria, que es el de desarrollo por defecto) entra el adaptador vacío: el producto
 * arranca igual y la analítica simplemente no guarda nada, en vez de romper `pnpm dev` a quien solo
 * quiere tocar la UI.
 */
@Module({
  // RbacModule NO es opcional: los controladores usan `ScopesGuard` y sin su módulo Nest no lo resuelve
  // y la API ENTERA entra en crash-loop al arrancar. `pnpm verify` no lo detecta porque no levanta el
  // contenedor de dependencias — es el fallo que el CLAUDE.md de este repo avisa por escrito.
  imports: [PersistenceModule, RbacModule],
  controllers: [IngestController, InsightsController, PlatformInsightsController],
  providers: [
    AnalyticsService,
    PlatformAdminService,
    PlatformAdminGuard,
    {
      provide: ANALYTICS_SINK,
      inject: [PERSISTENCE],
      useFactory: (p: PersistenceBundle): AnalyticsSink =>
        // Se reutiliza el MISMO cliente que el resto de la app, con su extensión RLS, en vez de abrir uno
        // propio: así la analítica sigue teniendo la segunda barrera de aislamiento por tenant. Un lote
        // siempre trae filas de un único workspace (el de la sesión), así que el `WITH CHECK` de la
        // política encaja. La vista global sale del contexto a propósito y por una única puerta.
        p.prisma ? new PostgresAnalyticsSink(p.prisma) : new NoopAnalyticsSink(),
    },
  ],
  exports: [AnalyticsService, PlatformAdminService],
})
export class AnalyticsModule {}
