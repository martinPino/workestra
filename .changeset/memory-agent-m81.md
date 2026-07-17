---
'@core/contracts': minor
---

Memoria del agente (M81).

- `Agent.memoryScope` pasa de `string` libre a un enum cerrado (`'temporal' | 'persistent' | 'shared'`, o
  ausente/`null` para apagarla). Un valor inventado hacía que el runtime fallara cerrado —el agente se
  quedaba sin memoria— mientras la UI la seguía pintando encendida; ahora se rechaza en el borde.
- `IAgentRuntime.invoke` acepta un tercer parámetro OPCIONAL `workspaceId` (el tenant de la ejecución). Sin
  él no hay memoria ni herramientas de integración: el almacén es multi-tenant y no podrían aislarse. Es
  aditivo: los implementadores y llamantes existentes siguen compilando.
