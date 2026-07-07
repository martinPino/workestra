import { z } from 'zod';
import type { Role } from '@core/contracts';
import type { RbacService } from '../rbac/rbac.service';
import type { McpServerLike, McpToolResult } from './mcp-sdk';
import type { McpContext } from './tools';
import { explainGraph, staticFindings, structuralSignature } from './graph-explain';

function ok(data: unknown): McpToolResult {
  return { content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] };
}
function fail(message: string): McpToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}
async function run(role: Role, rbac: RbacService, scope: string | null, fn: () => Promise<unknown> | unknown): Promise<McpToolResult> {
  try {
    if (scope) rbac.assert(role, scope);
    return ok(await fn());
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

const memberShape = z.object({ name: z.string(), systemPrompt: z.string(), model: z.string().optional() });

/** Grafo trigger → (nodo agente) → end, para que el orquestador planifique y reparte en runtime. */
function orchestratorGraph(orchestratorAgentId: string, triggerEvent: string) {
  return {
    nodes: [
      { key: 'inicio', type: 'trigger', config: { event: triggerEvent }, position: { x: 40, y: 160 } },
      { key: 'coordinador', type: 'agent', config: { agentId: orchestratorAgentId }, position: { x: 320, y: 160 } },
      { key: 'fin', type: 'end', config: {}, position: { x: 600, y: 160 } },
    ],
    edges: [
      { source: 'inicio', target: 'coordinador', sourceHandle: null },
      { source: 'coordinador', target: 'fin', sourceHandle: null },
    ],
  };
}

/**
 * Herramientas de ALTO NIVEL (M32): el MCP como arquitecto. design_* componen los servicios CRUD para
 * montar equipos/procesos completos; analyze_* / explain / optimize inspeccionan y sugieren mejoras.
 * El modelo cliente (Claude/GPT) aporta el «diseño»; estas tools lo materializan de forma determinista.
 */
export function registerArchitectTools(server: McpServerLike, ctx: McpContext): void {
  const ws = ctx.principal.workspaceId;
  const role = ctx.principal.role;
  const r = ctx.rbac;

  // ---- Diseño ----
  server.registerTool(
    'design_workflow',
    { title: 'Diseñar automatización', description: 'Diseña y crea una automatización a partir de un objetivo en lenguaje natural (usa la IA).', inputSchema: { goal: z.string() } },
    async ({ goal }) => run(role, r, 'workflow:write', async () => {
      const { name, graph } = await ctx.workflows.generate(`Diseña una automatización para: ${goal}`, ws);
      return ctx.workflows.create({ name, graph }, ws);
    }),
  );

  server.registerTool(
    'design_process',
    { title: 'Diseñar un proceso', description: 'Diseña y crea un proceso de negocio de varios pasos (usa la IA).', inputSchema: { process: z.string(), steps: z.array(z.string()).optional() } },
    async ({ process, steps }) => run(role, r, 'workflow:write', async () => {
      const detail = steps && steps.length ? `\nPasos: ${steps.join(' → ')}.` : '';
      const { name, graph } = await ctx.workflows.generate(`Diseña el proceso de negocio: ${process}.${detail}`, ws);
      return ctx.workflows.create({ name, graph }, ws);
    }),
  );

  server.registerTool(
    'design_team',
    {
      title: 'Diseñar un equipo',
      description: 'Crea un equipo de IA: agentes miembro + un orquestador que los coordina + una automatización que lo lanza.',
      inputSchema: { name: z.string(), orchestratorPrompt: z.string().optional(), members: z.array(memberShape), triggerEvent: z.string().optional() },
    },
    async ({ name, orchestratorPrompt, members, triggerEvent }) => run(role, r, 'agent:write', async () => {
      r.assert(role, 'workflow:write');
      const created = [];
      for (const m of members) created.push(await ctx.agents.create({ name: m.name, systemPrompt: m.systemPrompt, model: m.model }, ws));
      const orchestrator = await ctx.agents.create(
        {
          name: `${name} · Coordinador`,
          systemPrompt: orchestratorPrompt ?? `Eres el coordinador del equipo «${name}». Descompón la tarea, delega en los especialistas y fusiona sus resultados.`,
          isOrchestrator: true,
        },
        ws,
      );
      const wf = await ctx.workflows.create({ name, graph: orchestratorGraph((orchestrator as { id: string }).id, triggerEvent ?? 'manual') }, ws);
      return { team: name, orchestratorAgentId: (orchestrator as { id: string }).id, memberAgentIds: created.map((a) => (a as { id: string }).id), workflowId: (wf as { id: string }).id };
    }),
  );

  server.registerTool(
    'design_department',
    {
      title: 'Diseñar un departamento',
      description: 'Crea un departamento: varios sub-equipos de agentes + un orquestador general + una automatización.',
      inputSchema: { name: z.string(), teams: z.array(z.object({ name: z.string(), members: z.array(memberShape) })) },
    },
    async ({ name, teams }) => run(role, r, 'agent:write', async () => {
      r.assert(role, 'workflow:write');
      const result: Array<{ team: string; memberAgentIds: string[] }> = [];
      for (const team of teams) {
        const ids: string[] = [];
        for (const m of team.members) {
          const a = await ctx.agents.create({ name: `${team.name} · ${m.name}`, systemPrompt: m.systemPrompt, model: m.model }, ws);
          ids.push((a as { id: string }).id);
        }
        result.push({ team: team.name, memberAgentIds: ids });
      }
      const head = await ctx.agents.create(
        { name: `${name} · Dirección`, systemPrompt: `Diriges el departamento «${name}». Coordina los equipos: ${teams.map((t: { name: string }) => t.name).join(', ')}.`, isOrchestrator: true },
        ws,
      );
      const wf = await ctx.workflows.create({ name, graph: orchestratorGraph((head as { id: string }).id, 'manual') }, ws);
      return { department: name, headAgentId: (head as { id: string }).id, teams: result, workflowId: (wf as { id: string }).id };
    }),
  );

  // ---- Análisis ----
  server.registerTool(
    'analyze_workspace',
    { title: 'Analizar el workspace', description: 'Resumen del workspace: automatizaciones sin uso, duplicados, actividad y agentes.' },
    async () => run(role, r, 'workflow:read', async () => {
      const wfs = (await ctx.workflows.list(ws)) as Array<{ id: string; name: string; status: string }>;
      const agents = (await ctx.agents.list(ws)) as Array<{ isOrchestrator?: boolean }>;
      const execRes = (await ctx.executions.list(ws, { limit: 200 })) as { executions: Array<{ status: string }> };
      const execs = execRes.executions ?? [];

      // Duplicados: firma estructural del grafo de cada workflow (se cargan uno a uno, en proceso).
      const sigs = new Map<string, string[]>();
      for (const w of wfs) {
        try {
          const full = (await ctx.workflows.get(w.id, ws)) as { graph: import('@core/contracts').WorkflowGraph };
          const sig = structuralSignature(full.graph);
          sigs.set(sig, [...(sigs.get(sig) ?? []), w.name]);
        } catch {
          /* si un flujo no carga, se omite del análisis de duplicados */
        }
      }
      const duplicates = [...sigs.values()].filter((names) => names.length > 1);
      const statusCount = (arr: Array<{ status: string }>) => arr.reduce<Record<string, number>>((a, x) => ((a[x.status] = (a[x.status] ?? 0) + 1), a), {});

      return {
        workflows: { total: wfs.length, porEstado: statusCount(wfs) },
        // Candidatas a «sin uso»: automatizaciones nunca publicadas (siguen en borrador).
        sinPublicar: wfs.filter((w) => w.status === 'DRAFT').map((w) => w.name),
        duplicados: duplicates,
        agentes: { total: agents.length, orquestadores: agents.filter((a) => a.isOrchestrator).length },
        ejecuciones: { muestra: execs.length, porEstado: statusCount(execs) },
      };
    }),
  );

  server.registerTool(
    'analyze_workflow',
    { title: 'Analizar una automatización', description: 'Estadísticas de uso + hallazgos estáticos de una automatización.', inputSchema: { id: z.string() } },
    async ({ id }) => run(role, r, 'workflow:read', async () => {
      const wf = (await ctx.workflows.get(id, ws)) as { name: string; status: string; graph: import('@core/contracts').WorkflowGraph };
      return { nombre: wf.name, estado: wf.status, nodos: wf.graph.nodes?.length ?? 0, hallazgos: staticFindings(wf.graph) };
    }),
  );

  server.registerTool(
    'explain_workflow',
    { title: 'Explicar una automatización', description: 'Explica una automatización en texto legible + diagrama mermaid.', inputSchema: { id: z.string() } },
    async ({ id }) => run(role, r, 'workflow:read', async () => {
      const wf = (await ctx.workflows.get(id, ws)) as { graph: import('@core/contracts').WorkflowGraph };
      return explainGraph(wf.graph);
    }),
  );

  server.registerTool(
    'optimize_workflow',
    { title: 'Optimizar una automatización', description: 'Sugiere mejoras (nodos inalcanzables, callejones, ciclos…). NO guarda: aplica tú los cambios con update_workflow_graph.', inputSchema: { id: z.string() } },
    async ({ id }) => run(role, r, 'workflow:read', async () => {
      const wf = (await ctx.workflows.get(id, ws)) as { name: string; graph: import('@core/contracts').WorkflowGraph };
      const sugerencias = staticFindings(wf.graph).filter((f) => !f.startsWith('Sin problemas'));
      return {
        nombre: wf.name,
        sugerencias: sugerencias.length ? sugerencias : ['El flujo está estructuralmente sano; no hay optimizaciones automáticas evidentes.'],
        nota: 'Revisa las sugerencias y aplica los cambios con update_workflow_graph o edit_workflow.',
      };
    }),
  );
}
