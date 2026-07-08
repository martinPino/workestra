export const meta = {
  name: 'adversarial-review',
  description: 'Revisión de código adversarial multi-agente: descubre el cambio, lo revisa por lentes en paralelo y verifica cada hallazgo antes de reportarlo',
  whenToUse:
    'Para revisar a fondo un cambio (commit, rama o working tree) del monorepo AgentFlow. Pasa el rango en `args` (p. ej. "HEAD", "HEAD~3..HEAD", "main...HEAD", un SHA, "staged" o "working"); por defecto revisa el último commit. Devuelve solo los defectos confirmados tras verificación adversarial.',
  phases: [
    { title: 'Scope', detail: 'resolver el conjunto de cambios con git' },
    { title: 'Review', detail: 'reviewers en paralelo, uno por lente' },
    { title: 'Verify', detail: 'verificar cada hallazgo contra el código, por defecto REFUTADO' },
  ],
}

// --- Entrada: args puede ser un string (rango/keyword de git) o { ref/range/base/head } ---
const rawArgs = args
const spec =
  typeof rawArgs === 'string'
    ? rawArgs.trim()
    : rawArgs && typeof rawArgs === 'object'
      ? (rawArgs.range || rawArgs.ref || (rawArgs.base && rawArgs.head ? `${rawArgs.base}...${rawArgs.head}` : '') || '')
      : ''
const SPEC = spec || 'HEAD' // por defecto: el último commit

const REPO = '/Users/martin.schwarzboeck/Desktop/AI-workflows (Turborepo/pnpm monorepo TypeScript: apps/{api,web,worker}, packages/{contracts,domain,engine,sdk-plugins,infra}). `pnpm verify` corre build+typecheck+lint+depcruise+test.'

const SCOPE_SCHEMA = {
  type: 'object',
  required: ['range', 'files', 'summary'],
  properties: {
    range: { type: 'string', description: 'El rango/diff de git que realmente se revisó (p. ej. HEAD~1..HEAD, o "working tree").' },
    files: {
      type: 'array',
      description: 'Ficheros cambiados con un resumen de una línea de qué cambió en cada uno.',
      items: {
        type: 'object',
        required: ['path', 'change'],
        properties: {
          path: { type: 'string' },
          change: { type: 'string' },
        },
      },
    },
    summary: { type: 'string', description: 'Resumen en 2-4 frases del objetivo del cambio, para orientar a los reviewers.' },
  },
}

const FINDINGS_SCHEMA = {
  type: 'object',
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['file', 'summary', 'failure_scenario', 'severity'],
        properties: {
          file: { type: 'string' },
          line: { type: 'number' },
          summary: { type: 'string', description: 'Una frase: el defecto.' },
          failure_scenario: { type: 'string', description: 'Entradas/estado concretos → salida errónea/crash.' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
        },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['verdict', 'reasoning'],
  properties: {
    verdict: { type: 'string', enum: ['CONFIRMED', 'REFUTED', 'UNCERTAIN'] },
    reasoning: { type: 'string' },
    corrected_severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'none'] },
    suggested_fix: { type: 'string' },
  },
}

// --- Fase 1: Scope. Un agente resuelve el conjunto de cambios con git. ---
phase('Scope')
const scope = await agent(
  `Repo: ${REPO}

Resuelve el conjunto de cambios a revisar a partir de este especificador: "${SPEC}".
- Si es un rango de git (contiene ".." o "..."), úsalo tal cual: \`git diff <spec> --stat\` y \`git diff <spec>\`.
- Si es un único ref/SHA (p. ej. "HEAD" o "abc1234"), revisa ESE commit: \`git show <spec> --stat\` y el diff de \`git diff <spec>~1..<spec>\`.
- Si es "working", revisa el working tree sin commitear: \`git diff\` (+ \`git diff --staged\`).
- Si es "staged", revisa solo lo indexado: \`git diff --staged\`.
Devuelve el rango efectivo, la lista de ficheros cambiados con un resumen por fichero, y un resumen del objetivo del cambio. Ignora ficheros generados/lock. NO revises todavía; solo delimita el alcance.`,
  { label: `scope:${SPEC}`, phase: 'Scope', schema: SCOPE_SCHEMA, effort: 'medium' },
)

if (!scope || !scope.files || scope.files.length === 0) {
  log(`No se encontraron ficheros para el especificador "${SPEC}".`)
  return { range: scope?.range ?? SPEC, files: 0, confirmed: [] }
}

const fileList = scope.files.map((f) => `- ${f.path}: ${f.change}`).join('\n')
const BASE = `Repo: ${REPO}

Cambio bajo revisión (rango ${scope.range}). Objetivo: ${scope.summary}

Ficheros cambiados:
${fileList}

Inspecciona el diff (\`git diff ${scope.range}\` o \`git show\`) y LEE el estado ACTUAL de los ficheros afectados y sus dependencias. Reporta SOLO defectos reales que causen: comportamiento incorrecto, crash, agujero de seguridad/aislamiento de tenant, regresión de comportamiento existente, o una experiencia rota para el usuario. NADA de estilo, nombres o nitpicks hipotéticos. Cada hallazgo debe traer un escenario de fallo concreto (entradas → resultado erróneo).`

// --- Fase 2: Review. Lentes en paralelo. ---
const LENSES = [
  {
    key: 'correctness',
    prompt: `${BASE}

LENTE: Corrección funcional. Traza el flujo de datos y control extremo a extremo por los caminos que toca el cambio. Busca: casos límite, off-by-one, orden de operaciones, valores nulos/undefined, async/await y condiciones de carrera, errores tragados, y contratos entre paquetes (p. ej. un evento nuevo que el reducer o la UI no manejan). Verifica que el cambio hace lo que su objetivo dice.`,
  },
  {
    key: 'security-tenant',
    prompt: `${BASE}

LENTE: Seguridad y aislamiento por tenant. ¿Puede una petición leer/escribir datos de otro workspace? ¿Los endpoints nuevos exigen auth/scope como los demás? ¿Hay SSRF/inyección/proto-pollution, secretos filtrados, o límites que faltan (tamaño, TTL, cuotas)? ¿Los IDs se validan contra el workspace del principal? Reporta solo agujeros reales.`,
  },
  {
    key: 'regression',
    prompt: `${BASE}

LENTE: Regresión. Céntrate en el código COMPARTIDO que el cambio toca (evaluadores, parsers, resolvers, utilidades usadas por muchos sitios). Demuestra o descarta que TODO comportamiento previo sigue idéntico. Cualquier cambio de firma, de forma de datos, de regex, o de semántica que un llamador existente no espere. ¿Front y back siguen alineados (mismos formatos, mismas claves)?`,
  },
  {
    key: 'tests-edges',
    prompt: `${BASE}

LENTE: Cobertura y casos límite. ¿Los tests nuevos prueban de verdad el camino crítico, o son triviales? ¿Qué escenario realista NO está cubierto y rompería? Entradas vacías/enormes/malformadas, unicode, concurrencia, fallos del almacén/red, TTL caducado. Señala el hueco de test más peligroso como un hallazgo con su escenario.`,
  },
]

phase('Review')
const reviews = await parallel(
  LENSES.map((l) => () => agent(l.prompt, { label: `review:${l.key}`, phase: 'Review', schema: FINDINGS_SCHEMA, effort: 'high' })),
)

const all = reviews
  .map((r, i) => ({ r, lens: LENSES[i].key }))
  .filter((x) => x.r)
  .flatMap((x) => (x.r.findings || []).map((f) => ({ ...f, lens: x.lens })))

log(`Reviewers encontraron ${all.length} hallazgo(s) candidato(s); verificando cada uno adversarialmente.`)

if (all.length === 0) {
  return { range: scope.range, files: scope.files.length, candidates: 0, confirmed: [], uncertain: [] }
}

// --- Fase 3: Verify. Cada hallazgo se verifica intentando REFUTARLO. ---
phase('Verify')
const verified = await parallel(
  all.map((f, i) => () =>
    agent(
      `${BASE}

Verifica ADVERSARIALMENTE este defecto reclamado. Por DEFECTO es REFUTADO salvo que lo pruebes con evidencia concreta del código actual. Lee los ficheros/líneas exactos, construye el escenario de fallo real y comprueba si el código se comporta así de verdad (considera TODOS los llamadores y los modos relevantes, p. ej. cola vs inline).

RECLAMO (${f.severity}, lente ${f.lens}) en ${f.file}${f.line ? ':' + f.line : ''}:
${f.summary}
Escenario de fallo: ${f.failure_scenario}

Devuelve CONFIRMED solo si es un defecto real en el código actual, REFUTED si el código es correcto, UNCERTAIN si no puedes determinarlo. Da la severidad corregida y, si CONFIRMED, un arreglo concreto.`,
      { label: `verify:${f.lens}:${(f.file || '').split('/').pop()}`, phase: 'Verify', schema: VERDICT_SCHEMA, effort: 'high' },
    ).then((v) => ({ finding: f, verdict: v })),
  ),
)

const pick = (want) =>
  verified
    .filter(Boolean)
    .filter((v) => v.verdict && v.verdict.verdict === want)
    .map((v) => ({ ...v.finding, corrected_severity: v.verdict.corrected_severity, reasoning: v.verdict.reasoning, suggested_fix: v.verdict.suggested_fix }))

const confirmed = pick('CONFIRMED')
const uncertain = pick('UNCERTAIN')

const rank = { critical: 0, high: 1, medium: 2, low: 3, none: 4 }
confirmed.sort((a, b) => (rank[a.corrected_severity ?? a.severity] ?? 5) - (rank[b.corrected_severity ?? b.severity] ?? 5))

log(`Confirmados ${confirmed.length} de ${all.length} candidatos (${uncertain.length} inciertos).`)
return { range: scope.range, files: scope.files.length, candidates: all.length, confirmed, uncertain }
