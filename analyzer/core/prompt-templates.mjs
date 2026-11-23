import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';

const files = {
  clean: 'clean-chapters',
  cleanSupplementary: 'clean-supplementary',
  cleanChapterReview: 'clean-chapter-review',
  cleanStructureStrategy: 'clean-structure-strategy',
  cleanStructureReview: 'clean-structure-review',
  cleanStructureConfirm: 'clean-structure-confirm',
  cleanStructureRepair: 'clean-structure-repair',
  segment: 'scene-segment',
  mentionMapping: 'mention-mapping',
};
const base = Object.fromEntries(Object.entries(files).map(([key, name]) =>
  [key, fs.readFileSync(new URL('../prompts/' + name + '.prompt', import.meta.url), 'utf8')]));
const context = new AsyncLocalStorage();
export const getTemplate = view => context.getStore()?.[view] || base[view] || '';
export const originalPrompts = () => ({ ...base });
export const withTemplates = (overrides, run) => context.run(overrides || {}, run);

