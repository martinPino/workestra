import type { Role } from '@core/contracts';
import { can } from '@core/contracts';

/** Scope RBAC requerido por cada tool. Solo tools NO peligrosas (M3). */
export const TOOL_SCOPES: Record<string, string> = {
  mock: 'tool:mock',
  http: 'tool:http',
  browser: 'tool:browser', // M71: «Browser Automation»
};

export interface AuthzResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Autorización de tools DENY-BY-DEFAULT que consume el RBAC de M0 (no un stub):
 *   1) la tool debe estar en el allowlist del agente, y
 *   2) el rol debe tener el scope RBAC de esa tool.
 */
export class ToolAuthorizationService {
  authorize(params: { role: Role; agentTools: string[]; toolKey: string }): AuthzResult {
    const { role, agentTools, toolKey } = params;
    if (!agentTools.includes(toolKey)) {
      return { allowed: false, reason: `La tool "${toolKey}" no está en el allowlist del agente.` };
    }
    const scope = TOOL_SCOPES[toolKey];
    if (!scope) {
      return { allowed: false, reason: `Tool no habilitada en el catálogo seguro: "${toolKey}".` };
    }
    if (!can(role, scope)) {
      return { allowed: false, reason: `El rol ${role} carece del scope RBAC ${scope}.` };
    }
    return { allowed: true };
  }
}
