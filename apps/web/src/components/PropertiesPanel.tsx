import { TriangleAlert } from 'lucide-react';
import { useEditorStore } from '../editor/store';
import { getNodeType } from '../editor/node-types';
import { nodeSetupIssues } from '../editor/node-issues';
import { useAgents, useConnectors } from '../lib/hooks';
import { SchemaForm } from './SchemaForm';
import { ConnectorForm } from './ConnectorForm';
import { ConditionForm } from './ConditionForm';
import { useT } from '../i18n';

/** Panel de propiedades: se genera desde el config schema del tipo del nodo seleccionado. */
export function PropertiesPanel() {
  const selection = useEditorStore((s) => s.selection);
  const doc = useEditorStore((s) => s.history.doc);
  const updateConfig = useEditorStore((s) => s.updateConfig);
  // Hooks ANTES de cualquier return temprano (regla de hooks): pueblan el aviso «falta configurar».
  const agentsQuery = useAgents();
  const connectorsQuery = useConnectors();
  const t = useT();

  if (selection.length !== 1) {
    return (
      <div className="p-4 text-xs text-txt-secondary">
        {selection.length === 0 ? t('Selecciona un nodo para editar sus propiedades.') : `${selection.length} ${t('nodos seleccionados.')}`}
      </div>
    );
  }

  const node = doc.nodes.find((n) => n.id === selection[0]);
  if (!node) return <div className="p-4 text-xs text-txt-secondary">—</div>;

  const def = getNodeType(node.kind);
  if (!def) return <div className="p-4 text-xs text-txt-secondary">{t('Tipo desconocido:')} {node.kind}</div>;

  const Icon = def.icon;
  const issues = nodeSetupIssues(node.kind, node.config, {
    agents: agentsQuery.data,
    connectors: connectorsQuery.data,
    agentsError: agentsQuery.isError,
    connectorsError: connectorsQuery.isError,
  });
  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-center gap-2.5">
        <div className={`flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-elevated ${def.color}`}>
          <Icon size={17} strokeWidth={2} />
        </div>
        <div>
          <div className={`text-xs font-semibold ${def.color}`}>{t(def.label)}</div>
          <div className="font-mono text-[10px] text-txt-disabled">{node.id}</div>
        </div>
      </div>
      {/* Aviso «falta configurar» (M26): qué le falta a ESTE paso para funcionar, arriba del formulario. */}
      {issues.length > 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-warning/25 bg-warning/10 px-2.5 py-2 text-[11px] text-warning">
          <TriangleAlert size={13} className="mt-0.5 shrink-0" />
          <div>
            <div className="font-medium">{t('Falta para que funcione')}</div>
            <ul className="mt-0.5 list-disc pl-3.5">
              {issues.map((i) => (
                <li key={i}>{t(i)}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
      <div className="h-px bg-border" />
      {/* key={node.id}: remonta el formulario al cambiar de nodo para que los campos con estado local
          (unidad del campo `duration`, cloudId/avanzado del conector) se re-inicialicen desde el nodo
          recién seleccionado en vez de heredar el estado del anterior. Editar el MISMO nodo no remonta. */}
      {node.kind === 'connector' ? (
        // El nodo Conector usa un editor por ACCIONES (M20): sin method/path/JSON a la vista.
        <ConnectorForm key={node.id} value={node.config} onChange={(config) => updateConfig(node.id, config)} />
      ) : node.kind === 'condition' ? (
        // El nodo Condición usa un constructor de reglas VISUAL (M21): sin escribir «Expresión».
        <ConditionForm key={node.id} value={node.config} onChange={(config) => updateConfig(node.id, config)} />
      ) : (
        <SchemaForm key={node.id} schema={def.configSchema} value={node.config} onChange={(config) => updateConfig(node.id, config)} />
      )}
    </div>
  );
}
