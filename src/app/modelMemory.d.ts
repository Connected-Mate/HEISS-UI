export type RememberedSettings = Partial<{ steps: number; cfg: number; denoise: number; inpaintStrength: number; frames: number; fps: number; sampler: string; scheduler: string }>;
export type ModelMemory = Record<string, RememberedSettings & { at?: number }>;
type MemoryProfile = { id: string; kind?: string; capabilities?: Record<string, boolean>; constraints?: Record<string, { min?: number; max?: number }> };

export function rememberSettings(memory: ModelMemory, modelId: string, values: Record<string, unknown>, now?: number): ModelMemory;
export function recalledSettings(memory: ModelMemory, profile: MemoryProfile | null | undefined): RememberedSettings;
export function loadModelMemory(storage?: Storage): ModelMemory;
export function saveModelMemory(memory: ModelMemory, storage?: Storage): void;
