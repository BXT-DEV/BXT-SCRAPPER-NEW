import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isPackaged = (process as any).pkg !== undefined;
const PROJECT_ROOT = isPackaged 
  ? process.cwd() 
  : path.resolve(__dirname, "../../");

const COST_FILE_PATH = path.join(PROJECT_ROOT, 'logs', 'api_cost.json');

// Using standard Gemini 2.5 Flash prices (approximate) per 1M tokens
// Prompt: $0.075 / 1M tokens
// Candidates: $0.30 / 1M tokens
const PROMPT_COST_PER_TOKEN = 0.075 / 1000000;
const CANDIDATE_COST_PER_TOKEN = 0.30 / 1000000;

export interface CostData {
  target: string;
  totalPromptTokens: number;
  totalCandidateTokens: number;
  totalRequests: number;
  estimatedCostUSD: number;
}

export async function recordCost(target: string, promptTokens: number, candidateTokens: number) {
  try {
    let data: Record<string, CostData> = {};
    
    // Ensure logs directory exists
    await fs.mkdir(path.dirname(COST_FILE_PATH), { recursive: true });

    try {
      const content = await fs.readFile(COST_FILE_PATH, 'utf-8');
      data = JSON.parse(content);
    } catch {
      // File doesn't exist or is invalid, start fresh
    }

    if (!data[target]) {
      data[target] = {
        target,
        totalPromptTokens: 0,
        totalCandidateTokens: 0,
        totalRequests: 0,
        estimatedCostUSD: 0
      };
    }

    const t = data[target];
    t.totalPromptTokens += promptTokens;
    t.totalCandidateTokens += candidateTokens;
    t.totalRequests += 1;
    
    const cost = (promptTokens * PROMPT_COST_PER_TOKEN) + (candidateTokens * CANDIDATE_COST_PER_TOKEN);
    t.estimatedCostUSD += cost;

    await fs.writeFile(COST_FILE_PATH, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error(`Failed to record API cost: ${(err as Error).message}`);
  }
}

export async function getCostStats(): Promise<CostData[]> {
  try {
    const content = await fs.readFile(COST_FILE_PATH, 'utf-8');
    const data: Record<string, CostData> = JSON.parse(content);
    return Object.values(data);
  } catch {
    return [];
  }
}
