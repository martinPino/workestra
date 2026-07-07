/**
 * Modelos ofrecidos al generar/editar una automatización con IA (M34). El valor es el id que se manda al
 * backend; la cadena de fallback (M33) cubre que el proveedor de ese modelo se agote cayendo a otro.
 */
export interface GenerationModel {
  label: string;
  value: string;
}

export const GENERATION_MODELS: GenerationModel[] = [
  { label: 'Llama 3.3 70B · equilibrado (por defecto)', value: 'llama-3.3-70b-versatile' },
  { label: 'Llama 3.1 8B · muy rápido', value: 'llama-3.1-8b-instant' },
  { label: 'GPT-OSS 120B · potente', value: 'openai/gpt-oss-120b' },
  { label: 'GPT-4o mini · OpenAI', value: 'gpt-4o-mini' },
  { label: 'Claude Haiku · Anthropic', value: 'claude-haiku-4-5-20251001' },
  { label: 'Claude Sonnet · Anthropic', value: 'claude-sonnet-5' },
];

export const DEFAULT_GENERATION_MODEL = GENERATION_MODELS[0].value;
