import type {
  IWorkflowRepository,
  IExecutionRepository,
  IContextStore,
  INodeRunRepository,
  IAgentRepository,
  IMemoryStore,
  IPendingReviewRepository,
  IEventStore,
  ISecretStore,
  IWebhookRepository,
  IShareRepository,
  IScheduleRepository,
  IConnectorRepository,
  ITriggerBindingRepository,
  IApiKeyRepository,
  IWorkspaceUsageRepository,
  IFileStore,
  IAuthRepository,
  ITeamRepository,
  IEmailService,
} from '@core/engine';
import type { PrismaClient } from '@core/infra';

/**
 * El conjunto de adaptadores que necesita el API, con su token de inyección.
 *
 * Vive aparte de `persistence.module.ts` porque ese fichero importa `@nestjs/common` y este contrato lo
 * comparten DOS composition roots: el módulo de Nest (Railway) y `http/composition.ts` (Workers). Es el
 * punto exacto donde se ve que el cambio de plataforma no cambia la aplicación: los dos entornos
 * construyen el mismo bundle con adaptadores distintos.
 */
export const PERSISTENCE = Symbol('PERSISTENCE');

export interface PersistenceBundle {
  mode: 'memory' | 'postgres';
  workflows: IWorkflowRepository;
  executions: IExecutionRepository;
  context: IContextStore;
  nodeRuns: INodeRunRepository;
  agents: IAgentRepository;
  memory: IMemoryStore;
  pendingReviews: IPendingReviewRepository;
  /** Stream de eventos durable (M6): fuente de verdad del replay y del catch-up tras reinicios. */
  events: IEventStore;
  /** Secretos cifrados en reposo (M7): firmas de webhooks, credenciales, claves de proveedor. */
  secrets: ISecretStore;
  /** Webhooks de ingreso (M7): triggers entrantes firmados que arrancan ejecuciones. */
  webhooks: IWebhookRepository;
  shares: IShareRepository;
  /** Triggers programados (M7-B): registro durable de schedules cron/intervalo. */
  schedules: IScheduleRepository;
  /** Conectores (M11): integraciones OAuth para dispatch saliente autenticado. */
  connectors: IConnectorRepository;
  /** Bindings de disparador (M19): enlace receta↔workflow para triggers sin código (p. ej. Jira). */
  triggerBindings: ITriggerBindingRepository;
  /** Claves de API por workspace (M32): credencial duradera para MCP / apps externas. */
  apiKeys: IApiKeyRepository;
  /** Uso/cuota de tokens LLM por workspace (M33): contador diario para no agotar el presupuesto común. */
  usage: IWorkspaceUsageRepository;
  files: IFileStore;
  /** Usuarios/pertenencias para login+registro con email+contraseña (M73). */
  auth: IAuthRepository;
  /** Gestión de equipo: miembros e invitaciones (M74). */
  team: ITeamRepository;
  /** Envío de correo transaccional (invitaciones); best-effort, intercambiable (M74). */
  email: IEmailService;
  prisma?: PrismaClient;
}
