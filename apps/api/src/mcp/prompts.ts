import { z } from 'zod';
import type { McpServerLike, McpPromptResult } from './mcp-sdk';
import type { McpContext } from './tools';

/** Un prompt MCP devuelve una lista de mensajes que el cliente inyecta como si los escribiera el usuario. */
function userMsg(text: string): McpPromptResult {
  return { messages: [{ role: 'user', content: { type: 'text', text } }] };
}

/**
 * Prompts MCP (M32): plantillas reutilizables para tareas frecuentes. Guían al modelo a usar las tools de
 * arquitecto (design_team/design_workflow) o, si no, las de CRUD (create_agent + create_workflow). No
 * ejecutan nada por sí mismos: son el punto de partida de la conversación.
 */
export function registerPrompts(server: McpServerLike, _ctx: McpContext): void {
  server.registerPrompt(
    'create_customer_support_team',
    {
      title: 'Crear equipo de soporte',
      description: 'Monta un equipo de IA de atención al cliente (triaje, respuesta, escalado) con su automatización.',
      argsSchema: { channels: z.string().optional(), tone: z.string().optional() },
    },
    ({ channels, tone }) =>
      userMsg(
        [
          'Crea en AgentFlow un EQUIPO de atención al cliente usando la tool design_team (o, si no existe, create_agent + create_workflow).',
          'Roles: un agente de TRIAJE que clasifica la consulta, un agente de RESPUESTA que redacta la contestación, y un agente de ESCALADO para casos complejos, coordinados por un orquestador.',
          channels ? `Canales de entrada: ${channels}.` : 'Deja el canal de entrada configurable (webhook).',
          tone ? `Tono de las respuestas: ${tone}.` : 'Tono profesional y cercano.',
          'Al terminar, resume qué agentes y qué automatización creaste, con sus ids.',
        ].join('\n'),
      ),
  );

  server.registerPrompt(
    'create_hr_department',
    {
      title: 'Crear departamento de RRHH',
      description: 'Crea un equipo de IA de Recursos Humanos (selección, onboarding, políticas).',
      argsSchema: { focus: z.string().optional() },
    },
    ({ focus }) =>
      userMsg(
        [
          'Crea en AgentFlow un DEPARTAMENTO de RRHH con design_department (o design_team / create_agent).',
          'Agentes: RECLUTAMIENTO (criba de CVs y preguntas), ONBOARDING (plan de incorporación) y POLÍTICAS (responde dudas sobre normativa interna), con un orquestador que reparte.',
          focus ? `Prioriza: ${focus}.` : '',
          'Crea también una automatización de ejemplo (p. ej. onboarding al alta de un empleado) y resume los ids.',
        ]
          .filter(Boolean)
          .join('\n'),
      ),
  );

  server.registerPrompt(
    'create_marketing_team',
    {
      title: 'Crear equipo de marketing',
      description: 'Crea un equipo de IA de marketing (contenido, redes, SEO).',
      argsSchema: { product: z.string().optional() },
    },
    ({ product }) =>
      userMsg(
        [
          'Crea en AgentFlow un EQUIPO de marketing con design_team (o create_agent + create_workflow).',
          'Agentes: CONTENIDO (redacta posts/artículos), REDES (adapta a cada red social) y SEO (palabras clave y metadatos), coordinados por un orquestador.',
          product ? `Producto/tema: ${product}.` : 'Deja el tema como entrada del flujo.',
          'Crea una automatización que, a partir de un tema, produzca un borrador multicanal. Resume los ids.',
        ].join('\n'),
      ),
  );

  server.registerPrompt(
    'create_jira_automation',
    {
      title: 'Automatización de Jira',
      description: 'Crea un flujo disparado por un evento de Jira que actúa y avisa por Slack.',
      argsSchema: { project: z.string().optional(), event: z.string().optional() },
    },
    ({ project, event }) =>
      userMsg(
        [
          'Crea en AgentFlow una automatización disparada por Jira usando design_workflow o generate_workflow.',
          `Evento: ${event || 'cuando se crea un ticket'}${project ? ` en el proyecto ${project}` : ''}.`,
          'El flujo debe: (1) resumir el ticket con IA, (2) mover el ticket a «In Progress» vía el conector de Jira, y (3) notificar a Slack.',
          'Usa list_connectors para ver los conectores disponibles. Deja marcadores claros donde falte configuración. Resume el id del flujo creado.',
        ].join('\n'),
      ),
  );

  server.registerPrompt(
    'create_sales_pipeline',
    {
      title: 'Crear pipeline de ventas',
      description: 'Crea un equipo/flujo de IA para cualificar leads y hacer seguimiento.',
      argsSchema: { stages: z.string().optional() },
    },
    ({ stages }) =>
      userMsg(
        [
          'Crea en AgentFlow un PIPELINE de ventas con design_team + design_workflow.',
          'Agentes: CUALIFICACIÓN (puntúa el lead), REDACCIÓN (correo de contacto personalizado) y SEGUIMIENTO (recordatorios).',
          stages ? `Etapas del pipeline: ${stages}.` : 'Etapas: nuevo → cualificado → contactado → cerrado.',
          'Crea una automatización que procese un lead entrante de principio a fin. Resume los ids.',
        ].join('\n'),
      ),
  );

  server.registerPrompt(
    'analyze_workspace',
    {
      title: 'Analizar el workspace',
      description: 'Revisa el workspace: automatizaciones sin uso, duplicados, coste y mejoras.',
    },
    () =>
      userMsg(
        [
          'Analiza este workspace de AgentFlow con la tool analyze_workspace (o, si no existe, con list_workflows + list_executions + list_agents).',
          'Identifica: automatizaciones SIN uso, posibles DUPLICADOS, coste/actividad, y agentes huérfanos.',
          'Devuelve un resumen ejecutivo con hallazgos priorizados y recomendaciones concretas de mejora/limpieza.',
        ].join('\n'),
      ),
  );
}
