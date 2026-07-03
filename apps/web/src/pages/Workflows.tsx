import { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { Plus, Boxes, GitBranch, Play, Workflow as WorkflowIcon } from 'lucide-react';
import { Page } from '../app/AppShell';
import { Card, Button, PageHeader, Badge, Dot, EmptyState, Skeleton } from '../ui';
import { useWorkflows } from '../lib/hooks';
import { api } from '../lib/api';
import { STARTER_DOC, docToWorkflowGraph } from '../graph';
import { useT } from '../i18n';

export function Workflows() {
  const t = useT();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const qc = useQueryClient();
  const { data, isLoading } = useWorkflows();

  useEffect(() => {
    if (params.get('new') === '1') {
      params.delete('new');
      setParams(params, { replace: true });
      void (async () => {
        const wf = await api.createWorkflow('Nuevo workflow', docToWorkflowGraph(STARTER_DOC));
        qc.invalidateQueries({ queryKey: ['workflows'] });
        navigate(`/workflows/${wf.id}`);
      })();
    }
  }, [params]);

  const create = async () => {
    const wf = await api.createWorkflow('Nuevo workflow', docToWorkflowGraph(STARTER_DOC));
    qc.invalidateQueries({ queryKey: ['workflows'] });
    navigate(`/workflows/${wf.id}`);
  };

  return (
    <Page className="space-y-6">
      <PageHeader
        title="Workflows"
        subtitle={t("Diseña y ejecuta equipos de agentes con el editor visual.")}
        actions={
          <Button variant="primary" onClick={create}>
            <Plus size={15} /> {t("Nuevo workflow")}
          </Button>
        }
      />

      {isLoading ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-36 rounded-xl" />
          ))}
        </div>
      ) : !data || data.length === 0 ? (
        <EmptyState
          icon={<WorkflowIcon size={22} />}
          title={t("Aún no hay workflows")}
          description={t("Crea tu primer workflow y empieza a orquestar agentes de IA.")}
          action={
            <Button variant="primary" onClick={create}>
              <Plus size={15} /> {t("Crear workflow")}
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {data.map((wf, i) => (
            <motion.div key={wf.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.04 }}>
              <Card hover className="group cursor-pointer p-5" onClick={() => navigate(`/workflows/${wf.id}`)}>
                <div className="flex items-start justify-between">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/12 text-primary">
                    <Boxes size={20} />
                  </div>
                  <Badge tone={wf.status === 'ACTIVE' ? 'success' : 'default'}>
                    <Dot tone={wf.status === 'ACTIVE' ? 'success' : 'default'} /> {wf.status.toLowerCase()}
                  </Badge>
                </div>
                <div className="mt-4 text-sm font-semibold text-txt-primary">{wf.name}</div>
                <div className="mt-1 flex items-center gap-3 text-xs text-txt-secondary">
                  <span className="flex items-center gap-1">
                    <GitBranch size={12} /> {wf.graph?.nodes?.length ?? 0} {t("nodos")}
                  </span>
                  <span>v{wf.version}</span>
                </div>
                <div className="mt-4 flex items-center justify-between border-t border-border pt-3">
                  <span className="text-xs text-txt-disabled">{t("Editar en el canvas")}</span>
                  <span className="flex items-center gap-1 text-xs font-medium text-primary opacity-0 transition-opacity group-hover:opacity-100">
                    <Play size={12} /> {t("Abrir")}
                  </span>
                </div>
              </Card>
            </motion.div>
          ))}
        </div>
      )}
    </Page>
  );
}
