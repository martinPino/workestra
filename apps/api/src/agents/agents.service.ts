import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import type { Role } from '@core/contracts';
import { PERSISTENCE, type PersistenceBundle } from '../persistence/persistence.module';

interface CreateAgentBody {
  name: string;
  description?: string;
  systemPrompt?: string;
  model?: string;
  tools?: string[];
  memoryScope?: string;
  limits?: Record<string, unknown>;
  permissions?: { role?: Role };
  isOrchestrator?: boolean;
}

@Injectable()
export class AgentsService {
  constructor(@Inject(PERSISTENCE) private readonly p: PersistenceBundle) {}

  list(workspaceId: string) {
    return this.p.agents.list(workspaceId);
  }

  async get(id: string, workspaceId: string) {
    const agent = await this.p.agents.getInWorkspace(id, workspaceId); // solo si es del tenant
    if (!agent) throw new NotFoundException(`Agente no encontrado: ${id}`);
    return agent;
  }

  create(body: CreateAgentBody, workspaceId: string) {
    return this.p.agents.create({
      workspaceId,
      name: body.name,
      description: body.description ?? null,
      systemPrompt: body.systemPrompt ?? 'Eres un asistente útil.',
      model: body.model ?? 'mock-1',
      tools: body.tools ?? [],
      memoryScope: body.memoryScope ?? 'shared',
      variables: null,
      limits: body.limits ?? null,
      permissions: body.permissions ?? { role: 'EDITOR' },
      isOrchestrator: body.isOrchestrator ?? false,
    });
  }
}
