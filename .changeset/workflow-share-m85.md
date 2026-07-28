---
'@core/contracts': minor
---

Compartir un workflow por enlace (M85).

Añade el contrato de la forma PORTABLE de un workflow (`share.ts`): el grafo con marcadores en vez de ids,
los agentes con su definición pero sin secretos, y el informe de qué se quita al compartir. Aditivo.

Lo delicado vive fuera del contrato: el sanitizador (`@core/sdk-plugins`) usa una ALLOWLIST de claves de
config por tipo de nodo —nunca una denylist—, porque la config de un nodo es un `record` abierto y creciente:
con una lista de lo prohibido, cada campo nuevo viajaría por defecto; con una de lo permitido, lo desconocido
se cae. Un test planta diez secretos por todo un workflow y verifica que ninguno aparece en lo compartido.
