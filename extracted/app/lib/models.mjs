import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const MODELS_DIR = path.resolve(here, '..', '..');

const ACRONYMS = new Map([
  ['gpt', 'GPT'],
  ['cli', 'CLI'],
  ['ai', 'AI'],
  ['api', 'API'],
  ['chatgpt', 'ChatGPT'],
  ['llm', 'LLM'],
]);

function pretty(raw) {
  return raw
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => {
      const lower = part.toLowerCase();
      if (ACRONYMS.has(lower)) return ACRONYMS.get(lower);
      if (/^\d/.test(part)) return part;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(' ');
}

export function listModels() {
  let entries;
  try {
    entries = fs.readdirSync(MODELS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md'))
    .filter((e) => !/^readme/i.test(e.name) && !e.name.startsWith('_'))
    .map((e) => {
      const id = e.name.replace(/\.md$/i, '');
      const full = path.join(MODELS_DIR, e.name);
      const stat = fs.statSync(full);
      const text = fs.readFileSync(full, 'utf8');
      return {
        id,
        name: pretty(id),
        file: e.name,
        chars: text.length,
        estTokens: Math.round(text.length / 4),
        updatedAt: stat.mtimeMs,
        preview: text.slice(0, 240).replace(/\s+/g, ' ').trim(),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

const cache = new Map();

export function loadModelPrompt(id) {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error('invalid model id');
  const full = path.join(MODELS_DIR, id + '.md');
  if (!full.startsWith(MODELS_DIR)) throw new Error('path escape');
  const stat = fs.statSync(full);
  const cached = cache.get(id);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.text;
  const text = fs.readFileSync(full, 'utf8');
  cache.set(id, { mtimeMs: stat.mtimeMs, text });
  return text;
}