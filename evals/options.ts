import fs from 'node:fs';
import path from 'node:path';
import { PLUGINS } from '@/agent/context/plugins';
import type { ProviderConfig } from '@/shared/settings';

/**
 * The options every eval command shares — which Plugins, which endpoint and
 * model, what a million tokens costs, what the run is called — read one way,
 * so `eval:task` and `eval:decision` are written the same.
 */

/** Per million tokens. */
export interface Price {
  input: number;
  cached: number;
  output: number;
}

export interface ModelChoice {
  baseURL: string;
  model: string;
  price?: Price;
}

/** `parseArgs` specs for the shared options. */
export const SHARED_OPTIONS = {
  plugins: { type: 'string' },
  run: { type: 'string' },
  'base-url': { type: 'string' },
  model: { type: 'string' },
  price: { type: 'string' },
} as const;

/** `.env.local`, key by key. Nothing here prints a value. */
export function readEnv(repo: string): Record<string, string> {
  return Object.fromEntries(
    fs
      .readFileSync(path.join(repo, '.env.local'), 'utf8')
      .split('\n')
      .filter((l) => l.includes('='))
      .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
  );
}

/** `--plugins`: absent is the Plugins the product ships switched on, `none` is all off. */
export function pluginsFrom(value: string | undefined): string[] {
  const registered = PLUGINS.map((p) => p.name);
  const plugins =
    value === undefined
      ? PLUGINS.filter((p) => p.defaultOn).map((p) => p.name)
      : value === 'none'
        ? []
        : value.split(',').map((s) => s.trim());
  const unknown = plugins.filter((p) => !registered.includes(p));
  if (unknown.length) throw new Error(`没有这些 Plugin：${unknown.join(', ')}。已登记：${registered.join(', ')}；全关写 none`);
  return plugins;
}

/** `--price input,cached,output`. */
export function priceFrom(value: string | undefined): Price | undefined {
  if (!value) return undefined;
  const [input, cached, output] = value.split(',').map(Number);
  if (![input, cached, output].every((x) => x !== undefined && Number.isFinite(x) && x >= 0))
    throw new Error(`--price ${value}：要求三个非负数——输入,缓存命中的输入,输出（每百万 token）`);
  return { input: input!, cached: cached!, output: output! };
}

/** `--base-url` / `--model` / `--price`, falling back to `.env.local`, then to DeepSeek. */
export function modelFrom(
  values: { 'base-url'?: string; model?: string; price?: string },
  env: Readonly<Record<string, string>>,
): ModelChoice {
  const price = priceFrom(values.price);
  return {
    baseURL: (values['base-url'] || env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, ''),
    model: values.model || env.DEEPSEEK_MODEL || 'deepseek-flash',
    ...(price ? { price } : {}),
  };
}

/** `--run`: a run's directory name; the start time when absent. */
export function runIdFrom(value: string | undefined): string {
  const run = value ?? new Date().toISOString().slice(0, 19).replace(/:/g, '-');
  if (!/^[\w.-]+$/.test(run)) throw new Error(`--run ${run}：只能用字母、数字与 . _ -`);
  return run;
}

/** What the product would store for this choice. The DeepSeek preset, so the
 *  request fields that endpoint needs go out too (`settings.ts`). */
export function providerConfig(m: ModelChoice, apiKey: string): ProviderConfig {
  return { preset: 'deepseek', baseURL: m.baseURL, model: m.model, apiKey, contextWindow: 32_000 };
}

/** In the price's currency; `null` without prices. Cached input is billed at its own rate. */
export function costOf(tokens: { prompt: number; completion: number; cached: number }, price?: Price): number | null {
  if (!price) return null;
  return ((tokens.prompt - tokens.cached) * price.input + tokens.cached * price.cached + tokens.completion * price.output) / 1e6;
}
