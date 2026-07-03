import { Handle, Position, type NodeProps } from 'reactflow';
import { Square } from 'lucide-react';
import type { AfNodeData } from '../graph';
import { getNodeType } from '../editor/node-types';

const STATUS_RING: Record<string, string> = {
  running: 'ring-2 ring-primary shadow-[0_0_18px_rgb(var(--primary)/0.35)]',
  waiting: 'ring-2 ring-warning shadow-[0_0_18px_rgb(var(--warning)/0.4)] animate-pulse',
  succeeded: 'ring-2 ring-success shadow-[0_0_18px_rgb(var(--success)/0.35)]',
  failed: 'ring-2 ring-danger shadow-[0_0_18px_rgb(var(--danger)/0.35)]',
  skipped: 'opacity-60',
};

const HANDLE_CLASS = '!h-2.5 !w-2.5 !border-2 !border-border !bg-elevated';

export function AfNode({ data, selected }: NodeProps<AfNodeData>) {
  const def = getNodeType(data.kind);
  const Icon = def?.icon ?? Square;
  const statusRing = data.status ? (STATUS_RING[data.status] ?? '') : '';
  const selectedRing = selected ? 'ring-2 ring-primary' : '';
  return (
    <div
      className={`min-w-[156px] rounded-xl border border-border bg-card px-2.5 py-2 text-xs text-txt-primary shadow-card transition-all duration-150 hover:border-border-strong ${statusRing} ${selectedRing}`}
    >
      <Handle type="target" position={Position.Left} className={HANDLE_CLASS} />
      <div className="flex items-center gap-2.5">
        <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-border bg-elevated ${def?.color ?? 'text-txt-primary'}`}>
          <Icon size={15} strokeWidth={2} />
        </span>
        <span className="truncate font-medium text-txt-primary">{def?.label ?? data.kind}</span>
      </div>
      <Handle type="source" position={Position.Right} className={HANDLE_CLASS} />
    </div>
  );
}
