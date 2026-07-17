---
'@core/contracts': minor
---

`DATE_REF_RE` / `isDateRef`: la forma de las referencias de fecha (`{{fecha:-1d}}`) pasa a contracts.

La regla la necesitan dos lados que no pueden importarse entre sí —el runtime que la resuelve
(`@core/sdk-plugins`) y el editor que valida lo que escribes (`apps/web`, que solo puede consumir
contracts)—. Escrita dos veces, el editor marcaba en rojo «referencia a un paso que no existe» sobre algo
que el motor resolvía perfectamente. Aditivo: no cambia nada existente.
