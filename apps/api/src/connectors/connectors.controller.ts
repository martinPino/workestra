import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { connectorProviders } from '@core/sdk-plugins';
import { ScopesGuard } from '../rbac/scopes.guard';
import { RequireScopes } from '../rbac/scopes.decorator';
import { Public } from '../auth/public.decorator';
import { Workspace } from '../auth/workspace.decorator';
import { ConnectorsService } from './connectors.service';

/** Redirección mínima (evita acoplar el tipo Response de express en la firma). */
interface Redirectable {
  redirect(url: string): void;
}

/** Gestión de conectores del workspace (protegido por RBAC + tenant). */
@Controller('connectors')
export class ConnectorsController {
  constructor(private readonly svc: ConnectorsService) {}

  /** Catálogo de proveedores disponibles (para poblar la UI). */
  @Get('providers')
  @UseGuards(ScopesGuard)
  @RequireScopes('workflow:read')
  providers() {
    const isProd = process.env.NODE_ENV === 'production';
    return Object.values(connectorProviders())
      .filter((p) => p.provider !== 'dev' || !isProd) // el proveedor dev no existe en prod
      .map((p) => ({
        provider: p.provider,
        label: p.label,
        scopes: p.scopes,
        requiresConfig: p.requiresConfig,
        // `configured`: listo para conectar (no requiere config, o tiene client id/secret en el server).
        configured: this.svc.isConfigured(p.provider),
        // Proveedor del que salen las credenciales (varias apps de Google comparten `google`); para el hint.
        configProvider: p.configProvider ?? p.provider,
      }));
  }

  @Get()
  @UseGuards(ScopesGuard)
  @RequireScopes('workflow:read')
  list(@Workspace() workspaceId: string) {
    return this.svc.list(workspaceId);
  }

  @Post()
  @UseGuards(ScopesGuard)
  @RequireScopes('workflow:write')
  create(@Body() body: { provider: string; key: string }, @Workspace() workspaceId: string) {
    return this.svc.create(workspaceId, body?.provider, body?.key);
  }

  @Post(':id/connect')
  @UseGuards(ScopesGuard)
  @RequireScopes('workflow:write')
  connect(@Param('id') id: string, @Workspace() workspaceId: string) {
    return this.svc.connect(id, workspaceId);
  }

  @Delete(':id')
  @UseGuards(ScopesGuard)
  @RequireScopes('workflow:write')
  remove(@Param('id') id: string, @Workspace() workspaceId: string) {
    return this.svc.delete(id, workspaceId);
  }

  /**
   * Callback OAuth (PÚBLICO): el proveedor redirige aquí con `code` + `state`. El `state` firmado
   * identifica el conector y su tenant; se intercambia el code por el token y se guarda cifrado.
   */
  @Public()
  @Get('callback')
  async callback(@Query('code') code: string, @Query('state') state: string, @Res() res: Redirectable) {
    const { redirectTo } = await this.svc.callback(code, state);
    res.redirect(redirectTo);
  }
}

/**
 * Proveedor OAuth de DESARROLLO (`dev`), servido por la propia API. Simula Authorization Code para
 * probar el flujo completo (authorize → token → llamada autenticada) sin apps OAuth reales. NO usar
 * en producción: auto-aprueba y emite tokens sin verificar identidad.
 */
@Public()
@Controller('oauth/dev')
export class DevOAuthController {
  /** Auto-aprueba y redirige al `redirect_uri` con un `code` y el `state` recibido. */
  @Get('authorize')
  authorize(@Query('redirect_uri') redirectUri: string, @Query('state') state: string, @Res() res: Redirectable) {
    const code = `devcode_${randomBytes(8).toString('hex')}`;
    const sep = redirectUri.includes('?') ? '&' : '?';
    res.redirect(`${redirectUri}${sep}code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`);
  }

  /** Intercambia el `code` por un access token de desarrollo. */
  @Post('token')
  token(@Body() body: { code?: string }) {
    if (!body?.code) throw new UnauthorizedException('Falta code.');
    return { access_token: `devtok_${randomBytes(12).toString('hex')}`, token_type: 'bearer', scope: 'read' };
  }

  /** Recurso protegido de ejemplo que el nodo de conector puede llamar con el Bearer. */
  @Get('api/whoami')
  whoami(@Headers('authorization') auth?: string) {
    // Valida el Bearer pero NO refleja material del token en la respuesta (evita que fragmentos del
    // token acaben en el bodyPreview persistido del nodo de conector).
    if (!auth?.startsWith('Bearer ') || auth.length < 12) throw new UnauthorizedException('Falta Bearer.');
    return { ok: true, user: 'dev-user', at: 'dev-provider' };
  }
}
