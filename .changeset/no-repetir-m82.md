---
'@core/contracts': minor
---

«No repetir lo que ya envió» en el paso de IA (M82).

`NodeExecutionContext` gana `workflowId?: string`: la identidad ESTABLE del flujo. Es aditivo y opcional, así
que los ejecutores y llamantes existentes siguen compilando. Hacía falta porque lo único que un nodo tenía para
identificarse entre ejecuciones era `workflowVersionId` —que cambia en CADA publicación, y habría borrado la
memoria del nodo al editar el flujo— o `nodeKey` a secas, que comparten dos nodos homónimos de flujos distintos
(las plantillas del marketplace fijan claves como `digest`, así que dos instalaciones habrían colisionado).
