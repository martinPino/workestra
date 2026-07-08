import type { BrowserEngine, BrowserEngineName } from './types';
import type { BrowserSecurityPolicy } from './security';
import { defaultSecurityPolicy } from './security';

/** Identidad de una sesión: cada ejecución abre la suya, independiente de las demás. */
export interface SessionOwner {
  executionId?: string;
  workflowId?: string;
  agentId?: string;
  workspaceId?: string;
}

export interface BrowserSession {
  id: string;
  engine: BrowserEngine;
  owner: SessionOwner;
  createdAt: number;
  lastUsedAt: number;
  actionCount: number;
}

export interface SessionManagerDeps {
  /** Fábrica de motor (por defecto la global). Permite inyectar un motor concreto en tests. */
  createEngine: (name?: BrowserEngineName) => BrowserEngine;
  engineName?: BrowserEngineName;
  policy?: BrowserSecurityPolicy;
  /** Reloj inyectable (tests deterministas). */
  now?: () => number;
  /** Generador de id inyectable (tests deterministas). */
  genId?: () => string;
}

/**
 * Gestor de SESIONES de navegador (M71). Abre una sesión independiente por ejecución, la cierra
 * automáticamente al finalizar (o por vida máxima / nº de acciones), y barre las huérfanas. Vive en memoria
 * en el proceso que ejecuta (el worker). No conoce el motor concreto: sólo la interfaz `BrowserEngine`.
 */
export class BrowserSessionManager {
  private readonly sessions = new Map<string, BrowserSession>();
  private readonly deps: Required<Pick<SessionManagerDeps, 'createEngine' | 'now' | 'genId'>> & SessionManagerDeps;
  private seq = 0;

  constructor(deps: SessionManagerDeps) {
    this.deps = {
      ...deps,
      now: deps.now ?? Date.now,
      genId: deps.genId ?? (() => `bsess_${Date.now().toString(36)}_${(++this.seq).toString(36)}`),
    };
  }

  private policy(): BrowserSecurityPolicy {
    return this.deps.policy ?? defaultSecurityPolicy();
  }

  /** Abre una sesión nueva (lanza el navegador) y devuelve su id. */
  async open(owner: SessionOwner, launch: (engine: BrowserEngine) => Promise<void>): Promise<BrowserSession> {
    this.sweep(); // cierra huérfanas antes de abrir una nueva
    const engine = this.deps.createEngine(this.deps.engineName);
    await launch(engine);
    const now = this.deps.now();
    const session: BrowserSession = { id: this.deps.genId(), engine, owner, createdAt: now, lastUsedAt: now, actionCount: 0 };
    this.sessions.set(session.id, session);
    return session;
  }

  /** Recupera una sesión viva; lanza si no existe o expiró (y en ese caso la cierra). */
  async use(sessionId: string): Promise<BrowserSession> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Sesión de navegador inexistente o ya cerrada: ${sessionId}`);
    const policy = this.policy();
    const now = this.deps.now();
    if (now - session.createdAt > policy.maxSessionMs) {
      await this.close(sessionId);
      throw new Error('La sesión de navegador superó su vida máxima y se cerró.');
    }
    if (session.actionCount >= policy.maxActionsPerSession) {
      await this.close(sessionId);
      throw new Error('La sesión de navegador superó el nº máximo de acciones y se cerró.');
    }
    session.lastUsedAt = now;
    session.actionCount += 1;
    return session;
  }

  async close(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    await session.engine.close().catch(() => undefined);
  }

  /** Cierra todas las sesiones de una ejecución (se llama al terminar el workflow). */
  async closeByExecution(executionId: string): Promise<void> {
    const ids = [...this.sessions.values()].filter((s) => s.owner.executionId === executionId).map((s) => s.id);
    await Promise.all(ids.map((id) => this.close(id)));
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)));
  }

  /** Cierra sesiones que superaron su vida máxima (huérfanas). Best-effort, no lanza. */
  sweep(): void {
    const now = this.deps.now();
    const maxMs = this.policy().maxSessionMs;
    for (const s of [...this.sessions.values()]) {
      if (now - s.createdAt > maxMs) void this.close(s.id);
    }
  }

  count(): number {
    return this.sessions.size;
  }
}
