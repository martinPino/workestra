-- M40: servidores MCP enganchados por agente (JSON: [{id,name,url}]).
ALTER TABLE "Agent" ADD COLUMN "mcpServers" JSONB;
