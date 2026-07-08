import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { Workspace } from '../auth/workspace.decorator';
import { ExecutionsService } from './executions.service';

@Controller('executions')
export class ExecutionsController {
  constructor(private readonly svc: ExecutionsService) {}

  @Post()
  start(@Body() body: { workflowId: string; context?: Record<string, unknown> }, @Workspace() workspaceId: string) {
    return this.svc.start(body.workflowId, workspaceId, body.context);
  }

  @Get()
  list(
    @Workspace() workspaceId: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
    @Query('workflowId') workflowId?: string,
  ) {
    return this.svc.list(workspaceId, { status, limit: limit ? Number(limit) : undefined, workflowId });
  }

  @Get(':id')
  get(@Param('id') id: string, @Workspace() workspaceId: string) {
    return this.svc.get(id, workspaceId);
  }

  /** Delta del stream de eventos (M9): solo los `seq > since`, para el poll incremental de la consola. */
  @Get(':id/events')
  events(@Param('id') id: string, @Workspace() workspaceId: string, @Query('since') since?: string) {
    return this.svc.listEvents(id, workspaceId, since != null ? Number(since) : -1);
  }

  /**
   * Artefacto de la ejecución (M72): una captura/PDF/descarga que una tool guardó en el almacén de ficheros
   * durante el run. Se devuelve como data URL en JSON (no binario) porque el endpoint va autenticado con
   * Bearer y un `<img src>` directo no llevaría la cabecera; así el front lo pinta con un simple `src`.
   */
  @Get(':id/files/:fileId')
  async file(@Param('id') id: string, @Param('fileId') fileId: string, @Workspace() workspaceId: string) {
    const f = await this.svc.getFile(id, workspaceId, fileId);
    const base64 = Buffer.from(f.bytes).toString('base64');
    return { name: f.name, mimeType: f.mimeType, dataUrl: `data:${f.mimeType};base64,${base64}` };
  }
}
