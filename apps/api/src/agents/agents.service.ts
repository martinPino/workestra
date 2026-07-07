import { Injectable, Inject, NotFoundException, BadRequestException } from '@nestjs/common';
import { type Role, type McpServerRef, McpServerRefSchema } from '@core/contracts';
import { z } from 'zod';
import { PERSISTENCE, type PersistenceBundle } from '../persistence/persistence.module';

interface CreateAgentBody {
  name: string;
  description?: string;
  systemPrompt?: string;
  model?: string;
  tools?: string[];
  mcpServers?: McpServerRef[];
  memoryScope?: string;
  limits?: Record<string, unknown>;
  permissions?: { role?: Role };
  isOrchestrator?: boolean;
}

/** Valida y normaliza los servidores MCP (M40): URL válida obligatoria; asegura un id estable por servidor. */
function normalizeMcpServers(raw: unknown): McpServerRef[] {
  const parsed = z.array(McpServerRefSchema.partial({ id: true })).safeParse(raw ?? []);
  if (!parsed.success) throw new BadRequestException('Servidor MCP inválido: revisa el nombre y la URL (http/https).');
  return parsed.data.map((s, i) => ({ id: s.id?.trim() || `mcp_${Date.now().toString(36)}_${i}`, name: s.name, url: s.url }));
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
      mcpServers: body.mcpServers ? normalizeMcpServers(body.mcpServers) : null,
      memoryScope: body.memoryScope ?? 'shared',
      variables: null,
      limits: body.limits ?? null,
      permissions: body.permissions ?? { role: 'EDITOR' },
      isOrchestrator: body.isOrchestrator ?? false,
    });
  }

  /** Actualiza solo los campos presentes en `body` (tenant-safe: 404 si no es del workspace). */
  async update(id: string, body: Partial<CreateAgentBody>, workspaceId: string) {
    const patch: Record<string, unknown> = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.description !== undefined) patch.description = body.description ?? null;
    if (body.systemPrompt !== undefined) patch.systemPrompt = body.systemPrompt;
    if (body.model !== undefined) patch.model = body.model;
    if (body.tools !== undefined) patch.tools = body.tools;
    if (body.mcpServers !== undefined) patch.mcpServers = normalizeMcpServers(body.mcpServers);
    if (body.memoryScope !== undefined) patch.memoryScope = body.memoryScope;
    if (body.limits !== undefined) patch.limits = body.limits;
    if (body.permissions !== undefined) patch.permissions = body.permissions;
    if (body.isOrchestrator !== undefined) patch.isOrchestrator = body.isOrchestrator;
    const updated = await this.p.agents.update(id, workspaceId, patch);
    if (!updated) throw new NotFoundException(`Agente no encontrado: ${id}`);
    return updated;
  }

  async remove(id: string, workspaceId: string) {
    const ok = await this.p.agents.delete(id, workspaceId);
    if (!ok) throw new NotFoundException(`Agente no encontrado: ${id}`);
    return { deleted: true };
  }
}
