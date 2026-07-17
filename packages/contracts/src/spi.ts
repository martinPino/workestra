import type { NodeType } from './enums';
import type { ExecutionContext } from './context';
import type { Agent } from './entities';

/**
 * SPI (Service Provider Interface) de plugins. Superficie estable que autores externos
 * implementan para añadir tipos de nodo, herramientas y conectores SIN tocar el núcleo.
 */

/** Arista saliente del nodo hacia un sucesor: permite a un nodo (p. ej. el Router) inspeccionar sus
 *  destinos en runtime para decidir a cuál(es) enrutar. `targetType`/`targetConfig` describen el nodo
 *  destino (p. ej. un nodo `agent` con su `agentId`). */
export interface OutgoingEdge {
  readonly target: string;
  readonly targetType: string;
  readonly targetConfig: Record<string, unknown>;
  readonly sourceHandle: string | null;
}

export interface NodeExecutionContext {
  readonly executionId: string;
  /** Workspace (tenant) DE LA EJECUCIÓN. Los nodos lo usan para acotar recursos por tenant (M8). */
  readonly workspaceId: string;
  readonly nodeKey: string;
  readonly config: Record<string, unknown>;
  readonly context: ExecutionContext;
  readonly signal: AbortSignal;
  /** Aristas salientes del nodo (destinos). Presente en el runner real; opcional para tests simples. */
  readonly outgoing?: readonly OutgoingEdge[];
  /** Emite un evento de dominio (observabilidad). */
  emit(event: unknown): void;
}

export type NodeControl =
  | { kind: 'continue' }
  | { kind: 'branch'; handle: string }
  | { kind: 'pause'; reason: string }
  | { kind: 'end' };

export interface NodeUsage {
  tokens: number;
  cost: number;
}

export interface NodeResult {
  context: ExecutionContext;
  control: NodeControl;
  /** Consumo del nodo (LLM). El runner lo registra en el log y lo acumula en la ejecución. */
  usage?: NodeUsage;
}

export interface ToolResult {
  ok: boolean;
  output: unknown;
}

/** Un tipo de nodo del DAG. El runner lo resuelve por `type` desde el registro. */
export interface INodeExecutor {
  readonly type: NodeType;
  execute(ctx: NodeExecutionContext): Promise<NodeResult>;
}

export type ResolvedAuth = Record<string, unknown>;

/** Descripción de una tool para el LLM (M71): texto + JSON Schema de parámetros. */
export interface ToolDescription {
  description: string;
  parameters: Record<string, unknown>;
}

export interface ITool {
  readonly key: string;
  readonly idempotent: boolean;
  invoke(input: unknown, auth: ResolvedAuth): Promise<unknown>;
  /**
   * Opcional (M71): descripción + esquema de parámetros para el LLM. Si falta, el runtime ofrece la tool con
   * un esquema genérico vacío. Lo usan tools con vocabulario rico (p. ej. «browser», con muchas acciones).
   */
  describe?(): ToolDescription;
}

export interface ConnectorEvent {
  provider: string;
  type: string;
  payload: unknown;
}

export interface IConnector {
  readonly provider: string;
  dispatch(event: ConnectorEvent): Promise<void>;
}

export interface AgentResult {
  context: ExecutionContext;
  output: unknown;
  tokens: number;
  cost: number;
}

export interface IAgentRuntime {
  /**
   * `workspaceId` es el TENANT de la ejecución: sin él el runtime corre sin memoria ni herramientas de
   * integración (falla cerrado, porque no podría aislarlas por tenant). Opcional para no romper a los
   * llamantes que no lo tienen (p. ej. un test con contexto vacío).
   */
  invoke(agent: Agent, ctx: ExecutionContext, workspaceId?: string): Promise<AgentResult>;
}

/** Ej.: 'secrets:read:connector', 'net:egress:github.com', 'workflow:execute'. */
export type PermissionScope = string;

export interface PluginManifest {
  key: string;
  version: string;
  kind: 'node' | 'tool' | 'connector';
  permissions: PermissionScope[];
  provides: {
    nodes?: NodeType[];
    tools?: string[];
    connectors?: string[];
  };
}
