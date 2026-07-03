import type { PrismaClient } from '@prisma/client';
import type { Agent } from '@core/contracts';
import type { IAgentRepository } from '@core/engine';

type NewAgent = Omit<Agent, 'id'> & { workspaceId: string };

let counter = 0;

function normalize(input: NewAgent, id: string): Agent & { workspaceId: string } {
  return {
    id,
    workspaceId: input.workspaceId,
    name: input.name,
    description: input.description ?? null,
    systemPrompt: input.systemPrompt,
    model: input.model,
    tools: input.tools ?? [],
    memoryScope: input.memoryScope ?? null,
    variables: input.variables ?? null,
    limits: input.limits ?? null,
    permissions: input.permissions ?? null,
    isOrchestrator: input.isOrchestrator ?? false,
  };
}

export class InMemoryAgentRepository implements IAgentRepository {
  private readonly agents = new Map<string, Agent & { workspaceId: string }>();

  constructor(seed: NewAgent[] = []) {
    for (const a of seed) {
      const id = `agent_${++counter}`;
      this.agents.set(id, normalize(a, id));
    }
  }

  async list(workspaceId: string): Promise<Agent[]> {
    return [...this.agents.values()].filter((a) => a.workspaceId === workspaceId);
  }

  async get(id: string): Promise<Agent | null> {
    return this.agents.get(id) ?? null;
  }

  async getInWorkspace(id: string, workspaceId: string): Promise<Agent | null> {
    const a = this.agents.get(id);
    return a && a.workspaceId === workspaceId ? a : null;
  }

  async create(input: NewAgent): Promise<Agent> {
    const id = `agent_${++counter}`;
    const agent = normalize(input, id);
    this.agents.set(id, agent);
    return agent;
  }

  async update(id: string, workspaceId: string, patch: Partial<Omit<Agent, 'id'>>): Promise<Agent | null> {
    const a = this.agents.get(id);
    if (!a || a.workspaceId !== workspaceId) return null; // deny-by-default por tenant
    // Solo se aplican las claves presentes en el patch (no pisa con undefined).
    const next = { ...a } as Agent & { workspaceId: string };
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined) (next as Record<string, unknown>)[k] = v;
    }
    this.agents.set(id, next);
    return next;
  }

  async delete(id: string, workspaceId: string): Promise<boolean> {
    const a = this.agents.get(id);
    if (!a || a.workspaceId !== workspaceId) return false;
    this.agents.delete(id);
    return true;
  }
}


function toAgent(r: any): Agent {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    systemPrompt: r.systemPrompt,
    model: r.model,
    tools: r.tools ?? [],
    memoryScope: r.memoryScope,
    variables: r.variables,
    limits: r.limits,
    permissions: r.permissions,
    isOrchestrator: r.isOrchestrator,
  };
}

export class PrismaAgentRepository implements IAgentRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async list(workspaceId: string): Promise<Agent[]> {
    return (await this.prisma.agent.findMany({ where: { workspaceId } })).map(toAgent);
  }

  async get(id: string): Promise<Agent | null> {
    const r = await this.prisma.agent.findUnique({ where: { id } });
    return r ? toAgent(r) : null;
  }

  async getInWorkspace(id: string, workspaceId: string): Promise<Agent | null> {
    const r = await this.prisma.agent.findFirst({ where: { id, workspaceId } });
    return r ? toAgent(r) : null;
  }

  async create(input: NewAgent): Promise<Agent> {
    const r = await this.prisma.agent.create({
      data: {
        workspaceId: input.workspaceId,
        name: input.name,
        description: input.description ?? null,
        systemPrompt: input.systemPrompt,
        model: input.model,
        tools: input.tools ?? [],
        memoryScope: input.memoryScope ?? null,

        variables: (input.variables ?? undefined) as any,

        limits: (input.limits ?? undefined) as any,

        permissions: (input.permissions ?? undefined) as any,
        isOrchestrator: input.isOrchestrator ?? false,
      },
    });
    return toAgent(r);
  }

  async update(id: string, workspaceId: string, patch: Partial<Omit<Agent, 'id'>>): Promise<Agent | null> {
    // updateMany con workspaceId en el WHERE = tenant-safe (no puede tocar agentes de otro workspace).
    const data: Record<string, unknown> = {};
    for (const k of ['name', 'description', 'systemPrompt', 'model', 'tools', 'memoryScope', 'variables', 'limits', 'permissions', 'isOrchestrator'] as const) {
      if (patch[k] !== undefined) data[k] = patch[k];
    }
    const res = await this.prisma.agent.updateMany({ where: { id, workspaceId }, data: data as any });
    if (res.count === 0) return null;
    const r = await this.prisma.agent.findUnique({ where: { id } });
    return r ? toAgent(r) : null;
  }

  async delete(id: string, workspaceId: string): Promise<boolean> {
    const res = await this.prisma.agent.deleteMany({ where: { id, workspaceId } });
    return res.count > 0;
  }
}
