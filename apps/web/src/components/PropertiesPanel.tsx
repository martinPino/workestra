import { useEditorStore } from '../editor/store';
import { getNodeType } from '../editor/node-types';
import { SchemaForm } from './SchemaForm';
import { ConnectorForm } from './ConnectorForm';
import { ConditionForm } from './ConditionForm';
import { useT } from '../i18n';

/** Panel de propiedades: se genera desde el config schema del tipo del nodo seleccionado. */
export function PropertiesPanel() {
  const selection = useEditorStore((s) => s.selection);
  const doc = useEditorStore((s) => s.history.doc);
  const updateConfig = useEditorStore((s) => s.updateConfig);
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
