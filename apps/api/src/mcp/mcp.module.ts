import { Module } from '@nestjs/common';
import { McpController } from './mcp.controller';
import { McpService } from './mcp.service';
import { WorkflowsModule } from '../workflows/workflows.module';
import { AgentsModule } from '../agents/agents.module';
import { ExecutionModule } from '../execution/execution.module';
import { ConnectorsModule } from '../connectors/connectors.module';
import { RbacModule } from '../rbac/rbac.module';

/**
 * Servidor MCP (M32): expone las automatizaciones/agentes/ejecuciones como tools+resources sobre
 * Streamable HTTP. Importa los módulos de servicio (que exportan su service) para llamarlos en proceso.
 */
@Module({
  imports: [WorkflowsModule, AgentsModule, ExecutionModule, ConnectorsModule, RbacModule],
  controllers: [McpController],
  providers: [McpService],
})
export class McpModule {}
