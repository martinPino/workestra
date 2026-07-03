// La política RBAC vive en @core/contracts para compartirse entre la API y el runtime de
// agentes (autorización de tools). Este re-export mantiene los imports locales estables.
export { ROLE_SCOPES, can } from '@core/contracts';
