import { Brain } from 'lucide-react';
import { useEditorStore } from '../editor/store';
import { Badge } from '../ui';

const DOT: Record<string, string> = {
  pending: 'bg-muted',
  running: 'bg-warning animate-pulse',
  succeeded: 'bg-success',
  failed: 'bg-danger',
  skipped: 'bg-border-strong',
};

/** Árbol de subtareas del Orchestrator, proyectado en vivo desde el ExecutionStateReducer. */
export function SubtaskTree() {
  const plan = useEditorStore((s) => s.plan);
  if (!plan) return null;

  const ids = plan.order.length ? plan.order : Object.keys(plan.subtasks);

  return (
    <div className="border-t border-border p-4">
      <div className="mb-3 flex items-center gap-2">
        <div className="flex h-6 w-6 items-center justify-center rounded-md bg-accent/12 text-accent">
          <Brain size={13} />
        </div>
        <span className="text-[11px] font-semibold uppercase tracking-wide text-txt-secondary">Plan del Orchestrator</span>
        {plan.merged && <Badge tone="success">fusionado ✓</Badge>}
      </div>

      {plan.validationErrors?.length ? (
        <div className="mb-2 rounded-lg border border-danger/20 bg-danger/10 p-2 text-[11px] text-danger">
          Plan rechazado: {plan.validationErrors.join('; ')}
        </div>
      ) : null}

      <ol className="flex flex-col gap-1.5">
        {ids.map((id) => {
          const st = plan.subtasks[id];
          if (!st) return null;
          return (
            <li key={id} className="rounded-lg border border-border bg-card px-2.5 py-2">
              <div className="flex items-center gap-2 text-xs">
                <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[st.status] ?? 'bg-muted'}`} />
                <span className="font-medium text-txt-primary">{id}</span>
                <span className="truncate text-txt-secondary">→ {st.agentId}</span>
              </div>
              {st.output && <div className="mt-1 truncate text-[10px] text-txt-disabled">{st.output}</div>}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
