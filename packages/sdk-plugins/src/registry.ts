import type { INodeExecutor, NodeType, PluginManifest } from '@core/contracts';

/**
 * Registro de ejecutores de nodo. Satisface estructuralmente `INodeExecutorRegistry`
 * del engine (get(type) => INodeExecutor | undefined), sin acoplarse a él.
 * Añadir un tipo de nodo = `register(executor)`; el runner nunca cambia (Open/Closed).
 */
export class NodeExecutorRegistry {
  private readonly executors = new Map<NodeType, INodeExecutor>();

  register(executor: INodeExecutor): this {
    if (this.executors.has(executor.type)) {
      throw new Error(`Ya existe un executor para el tipo de nodo "${executor.type}".`);
    }
    this.executors.set(executor.type, executor);
    return this;
  }

  get(type: NodeType): INodeExecutor | undefined {
    return this.executors.get(type);
  }

  has(type: NodeType): boolean {
    return this.executors.has(type);
  }

  types(): NodeType[] {
    return [...this.executors.keys()];
  }
}

export interface RegisteredPlugin {
  manifest: PluginManifest;
}

/** Registro de plugins: guarda manifests y registra sus ejecutores de nodo. */
export class PluginRegistry {
  private readonly plugins = new Map<string, RegisteredPlugin>();
  readonly nodes = new NodeExecutorRegistry();

  register(manifest: PluginManifest, executors: INodeExecutor[] = []): this {
    const id = `${manifest.key}@${manifest.version}`;
    if (this.plugins.has(id)) {
      throw new Error(`Plugin ya registrado: ${id}`);
    }
    this.plugins.set(id, { manifest });
    for (const ex of executors) this.nodes.register(ex);
    return this;
  }

  list(): PluginManifest[] {
    return [...this.plugins.values()].map((p) => p.manifest);
  }
}
