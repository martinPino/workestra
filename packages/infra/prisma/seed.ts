import { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';

const prisma = new PrismaClient();

// Hash placeholder (M0). El auth real usa OIDC/JWT + argon2 (apps/api).
const devHash = (s: string) => createHash('sha256').update(s).digest('hex');

// IDs fijos alineados con el workspace por defecto de la API (DEFAULT_WORKSPACE = 'ws_dev').
const ORG_ID = 'org_dev';
const WS_ID = 'ws_dev';

async function main() {
  const org = await prisma.organization.upsert({
    where: { slug: 'acme' },
    update: {},
    create: { id: ORG_ID, name: 'ACME Inc.', slug: 'acme', plan: 'pro' },
  });

  const workspace = await prisma.workspace.upsert({
    where: { id: WS_ID },
    update: {},
    create: { id: WS_ID, organizationId: org.id, name: 'Default', slug: 'default' },
  });

  const user = await prisma.user.upsert({
    where: { email: 'owner@acme.dev' },
    update: {},
    create: { email: 'owner@acme.dev', name: 'Owner', passwordHash: devHash('owner@acme.dev') },
  });

  await prisma.membership.upsert({
    where: { userId_organizationId_workspaceId: { userId: user.id, organizationId: org.id, workspaceId: workspace.id } },
    update: { role: 'OWNER' },
    create: { userId: user.id, organizationId: org.id, workspaceId: workspace.id, role: 'OWNER' },
  });

  // Agentes (idempotente: solo si el workspace no tiene agentes todavía).
  const count = await prisma.agent.count({ where: { workspaceId: WS_ID } });
  if (count === 0) {
    await prisma.agent.createMany({
      data: [
        {
          workspaceId: WS_ID,
          name: 'QA Agent',
          description: 'Especialista en Playwright.',
          systemPrompt: 'Eres un ingeniero de QA. Analiza y responde de forma concisa.',
          model: 'mock-1',
          tools: ['mock'],
          memoryScope: 'shared',
          limits: { maxTokens: 4000 },
          permissions: { role: 'EDITOR' },
          isOrchestrator: false,
        },
        {
          workspaceId: WS_ID,
          name: 'Backend Agent',
          description: 'Especialista en Java/Spring; puede llamar HTTP.',
          systemPrompt: 'Eres un ingeniero backend. Usa herramientas cuando aporten valor.',
          model: 'mock-1',
          tools: ['mock', 'http'],
          memoryScope: 'shared',
          limits: { maxTokens: 4000 },
          permissions: { role: 'EDITOR' },
          isOrchestrator: false,
        },
        {
          workspaceId: WS_ID,
          name: 'Orchestrator',
          description: 'Agente líder: analiza, planifica y coordina agentes especializados.',
          systemPrompt: 'Eres el Orchestrator. Descompón la tarea, delega en agentes y fusiona resultados.',
          model: 'mock-1',
          tools: [],
          memoryScope: 'shared',
          limits: { maxTokens: 8000 },
          permissions: { role: 'ADMIN' },
          isOrchestrator: true,
        },
      ],
    });
  }

  const agents = await prisma.agent.findMany({ where: { workspaceId: WS_ID } });
  console.log('Seed OK:', { workspace: WS_ID, agents: agents.map((a) => `${a.id}:${a.name}`) });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
