---
'@core/contracts': minor
---

Analítica de producto (M84).

Añade el modelo de eventos (`analytics.ts`) y el puerto del almacén (`analytics-sink.ts`), y el scope
`analytics:read` para OWNER/ADMIN. Todo aditivo: nada de lo existente cambia de forma.

Lo que hay que saber para tocarlo: en `analytics.ts` NO puede aparecer un `z.string()` sin acotar. Cada
texto es un enum, un slug con forma o un hash, y hay un test que recorre el registro y falla si alguien
mete uno suelto. Es lo que impide que un mensaje de error o una búsqueda arrastren un secreto o el
contenido de un flujo hasta la tabla de eventos. Añadir un campo medible es, a propósito, un cambio de
contrato con su revisión.
