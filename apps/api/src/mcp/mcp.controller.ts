import { Body, Controller, Delete, Get, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { setCurrentWorkspace } from '@core/infra';
import { Public } from '../auth/public.decorator';
import { PERSISTENCE, type PersistenceBundle } from '../persistence/persistence.module';
import { resolveApiKey, type ApiKeyPrincipal } from '../api-keys/api-key.util';
import { McpService } from './mcp.service';

type McpReq = IncomingMessage & { user?: ApiKeyPrincipal };

/**
 * Endpoint MCP (Streamable HTTP, M32). Dos formas de auth para máxima compatibilidad de clientes:
 *  - `/mcp` con cabecera `Authorization: Bearer af_…` (o un JWT de sesión): la autentica el guard global.
 *  - `/mcp/:key` con la clave embebida en la URL: para clientes que no permiten cabeceras (algunos
 *    conectores de Claude Desktop/ChatGPT). Es `@Public()` y resuelve la clave aquí mismo.
 */
@Controller()
export class McpController {
  constructor(
    private readonly mcp: McpService,
    @Inject(PERSISTENCE) private readonly persistence: PersistenceBundle,
  ) {}

  @Post('mcp')
  async post(@Req() req: McpReq, @Res() res: ServerResponse, @Body() body: unknown): Promise<void> {
    await this.mcp.handle(req, res, body, req.user!);
  }

  @Get('mcp')
  async get(@Req() req: McpReq, @Res() res: ServerResponse): Promise<void> {
    await this.mcp.handle(req, res, undefined, req.user!);
  }

  @Delete('mcp')
  async del(@Req() req: McpReq, @Res() res: ServerResponse): Promise<void> {
    await this.mcp.handle(req, res, undefined, req.user!);
  }

  @Public()
  @Post('mcp/:key')
  async postKey(@Param('key') key: string, @Req() req: McpReq, @Res() res: ServerResponse, @Body() body: unknown): Promise<void> {
    await this.serveWithKey(key, req, res, body);
  }

  @Public()
  @Get('mcp/:key')
  async getKey(@Param('key') key: string, @Req() req: McpReq, @Res() res: ServerResponse): Promise<void> {
    await this.serveWithKey(key, req, res, undefined);
  }

  @Public()
  @Delete('mcp/:key')
  async delKey(@Param('key') key: string, @Req() req: McpReq, @Res() res: ServerResponse): Promise<void> {
    await this.serveWithKey(key, req, res, undefined);
  }

  private async serveWithKey(key: string, req: McpReq, res: ServerResponse, body: unknown): Promise<void> {
    const principal = await resolveApiKey(this.persistence.apiKeys, key);
    if (!principal) {
      res.statusCode = 401;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'API key inválida o revocada.' }, id: null }));
      return;
    }
    setCurrentWorkspace(principal.workspaceId); // el guard no corre en rutas @Public: fijamos el tenant aquí
    await this.mcp.handle(req, res, body, principal);
  }
}
