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
 * Es el punto donde se ve que cambiar de plataforma no cambió la aplicación: el mismo contrato lo
 * satisfacen los adaptadores de Prisma/Redis (Railway) y los de Hyperdrive/R2/Durable Objects, sin que
 * ningún servicio se entere.
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
