import type { PrismaClient } from '@prisma/client';
import type { IShareRepository, ShareRecord } from '@core/engine';

type CreateInput = Parameters<IShareRepository['create']>[0];

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/** Share repo in-memory (dev/tests): el default `PERSISTENCE=memory` funciona sin Postgres. */
export class InMemoryShareRepository implements IShareRepository {
  private readonly byId = new Map<string, ShareRecord>();
  private seq = 0;

  async create(input: CreateInput): Promise<ShareRecord> {
    const id = `shr_${++this.seq}`;
    const rec: ShareRecord = {
      id,
      createdAt: new Date().toISOString(),
      revokedAt: null,
      importCount: 0,
      lastImportedAt: null,
      importerWorkspaceIds: [],
      ...input,
    };
    this.byId.set(id, rec);
    return rec;
  }
  async findByTokenHash(tokenHash: string): Promise<ShareRecord | null> {
    return [...this.byId.values()].find((s) => s.tokenHash === tokenHash) ?? null;
  }
  async listByWorkspace(workspaceId: string): Promise<ShareRecord[]> {
    return [...this.byId.values()].filter((s) => s.workspaceId === workspaceId);
  }
  async bumpImport(id: string, importerWorkspaceId: string): Promise<void> {
    const s = this.byId.get(id);
    if (!s) return;
    if (s.importerWorkspaceIds.includes(importerWorkspaceId)) return; // ese workspace ya contó
    this.byId.set(id, {
      ...s,
      importCount: s.importCount + 1,
      lastImportedAt: new Date().toISOString(),
      importerWorkspaceIds: [...s.importerWorkspaceIds, importerWorkspaceId],
    });
  }
  async revoke(id: string): Promise<void> {
    const s = this.byId.get(id);
    if (s) this.byId.set(id, { ...s, revokedAt: new Date().toISOString() });
  }
}

/**
 * Share repo en Postgres (M85). La tabla está bajo RLS por `workspaceId`; la lectura pública corre a
 * propósito FUERA del contexto de tenant (GUC NULL → la política deja ver la fila, que se localiza por el
 * hash del token, único globalmente). El `bumpImport` de quien importa corre en modo sistema por lo mismo:
 * no es el dueño del share.
 */
export class PrismaShareRepository implements IShareRepository {
  constructor(private readonly prisma: PrismaClient) {}

  private map(r: {
    id: string;
    workspaceId: string;
    workflowId: string | null;
    sourceName: string;
    tokenHash: string;
    snapshot: unknown;
    report: unknown;
    redactionCount: number;
    createdByUserId: string;
    createdAt: Date;
    expiresAt: Date | null;
    revokedAt: Date | null;
    importCount: number;
    lastImportedAt: Date | null;
    importerWorkspaceIds: string[];
  }): ShareRecord {
    return {
      id: r.id,
      workspaceId: r.workspaceId,
      workflowId: r.workflowId,
      sourceName: r.sourceName,
      tokenHash: r.tokenHash,
      snapshot: r.snapshot,
      report: r.report,
      redactionCount: r.redactionCount,
      createdByUserId: r.createdByUserId,
      createdAt: r.createdAt.toISOString(),
      expiresAt: iso(r.expiresAt),
      revokedAt: iso(r.revokedAt),
      importCount: r.importCount,
      lastImportedAt: iso(r.lastImportedAt),
      importerWorkspaceIds: r.importerWorkspaceIds,
    };
  }

  async create(input: CreateInput): Promise<ShareRecord> {
    const r = await this.prisma.workflowShare.create({
      data: {
        workspaceId: input.workspaceId,
        workflowId: input.workflowId,
        sourceName: input.sourceName,
        tokenHash: input.tokenHash,
        snapshot: input.snapshot as never,
        report: input.report as never,
        redactionCount: input.redactionCount,
        createdByUserId: input.createdByUserId,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      },
    });
    return this.map(r);
  }
  async findByTokenHash(tokenHash: string): Promise<ShareRecord | null> {
    const r = await this.prisma.workflowShare.findUnique({ where: { tokenHash } });
    return r ? this.map(r) : null;
  }
  async listByWorkspace(workspaceId: string): Promise<ShareRecord[]> {
    const rows = await this.prisma.workflowShare.findMany({ where: { workspaceId }, orderBy: { createdAt: 'desc' } });
    return rows.map((r) => this.map(r));
  }
  async bumpImport(id: string, importerWorkspaceId: string): Promise<void> {
    // Atómico e idempotente por workspace: `array_append` + incremento SOLO si ese workspace no está ya en la
    // lista. Una sola sentencia (sin leer-luego-escribir) evita carreras y que el contador se infle en bucle.
    await this.prisma.$executeRaw`
      UPDATE "WorkflowShare"
      SET "importerWorkspaceIds" = array_append("importerWorkspaceIds", ${importerWorkspaceId}),
          "importCount" = "importCount" + 1,
          "lastImportedAt" = now()
      WHERE "id" = ${id} AND NOT (${importerWorkspaceId} = ANY("importerWorkspaceIds"))
    `;
  }
  async revoke(id: string): Promise<void> {
    await this.prisma.workflowShare.update({ where: { id }, data: { revokedAt: new Date() } });
  }
}
