import { bookBasis } from './project.mjs';
import { makeScenes } from './tables.mjs';
import { sourceLines } from './text.mjs';
import { HttpError } from './storage.mjs';

export function describeBook(entry, storage) {
  const { id, revision, project } = entry;
  const { source, clean, numbered, scenes, characters, mentions } = project;
  return {
    id, revision, title: clean.title, file: source.file, encoding: source.encoding, notes: source.notes, sourceHash: source.sha256, basis: bookBasis(project),
    legacy: source.origin?.format || null, lineCount: clean.lineCount, warnings: clean.warnings, edits: clean.edits,
    counts: {
      chapters: clean.chapters.length, paragraphs: clean.chapters.reduce((sum, c) => sum + c.paragraphs.length, 0),
      chars: clean.body.length, sentences: numbered?.sentences.length ?? null,
      scenes: scenes?.rows.length ?? null, characters: characters?.rows.length ?? null, mentions: mentions?.rows.length ?? null,
      audit: clean.audit.length,
    },
    coverage: numbered?.coverage ?? null, backups: storage.backupCount(id),
    provenance: { scenes: scenes?.provenance ?? null, characters: characters?.provenance ?? null },
  };
}

function page(rows, query, filter = () => true) {
  const offset = Math.max(0, Number.parseInt(query.get('offset'), 10) || 0);
  const limit = Math.min(200, Math.max(1, Number.parseInt(query.get('limit'), 10) || 50));
  const filtered = rows.filter(filter);
  return { rows: filtered.slice(offset, offset + limit), offset, limit, total: filtered.length };
}

function sceneRows(project, scene) {
  return project.numbered.sentences.slice(Number(scene.from.slice(1)) - 1, Number(scene.to.slice(1)));
}

export function bookView(entry, query, storage) {
  const { id, project } = entry;
  const { source, clean, numbered, scenes, characters, mentions } = project;
  const kind = query.get('kind');
  switch (kind) {
    case 'source': return page(sourceLines(source.text), query);
    case 'clean': return page(clean.chapters.flatMap(c => c.paragraphs.map(p => ({ ...p, chapter: c.title }))), query);
    case 'audit': {
      const models = new Map(project.cleanReviews.map(row => [row.line, row.provenance.model]));
      return page(clean.audit.map(row => ({ ...row, model: models.get(row.line) || null })), query);
    }
    case 'chapters': return page(numbered?.chapters ?? [], query);
    case 'numbered': return page(numbered?.sentences ?? [], query, s => !query.get('chapter') || query.get('chapter') === s.chapterId);
    case 'structure':
    case 'body': {
      const result = entry.suggestions?.[kind];
      return page(result?.basis === bookBasis(project) ? result.rows : [], query);
    }
    case 'scenes': return page((scenes?.rows ?? []).map(scene => ({
      ...scene, excerpt: numbered.sentences[Number(scene.from.slice(1)) - 1].text.slice(0, 120),
    })), query);
    case 'partial': {
      const job = storage.getJob(id, 'scenes');
      if (!job || job.basis !== bookBasis(project) || !numbered || !job.cursor
        || job.status === 'complete' || entry.completedJobs?.scenes === job.id) return page([], query);
      const checked = numbered.sentences.slice(0, job.cursor);
      const cuts = job.data.filter(cut => cut < job.cursor);
      const rows = makeScenes(checked, cuts).map((row, index, list) => ({
        ...row, provisional: index === list.length - 1 && !job.data.includes(job.cursor),
        excerpt: sceneRows(project, row)[0]?.text.slice(0, 120),
      }));
      const result = page(rows, query);
      return { ...result, cursor: job.cursor };
    }
    case 'scene': {
      const scene = scenes?.rows.find(r => r.sceneId === query.get('scene'));
      if (!scene) throw new HttpError(404, '场景不存在');
      const view = page(sceneRows(project, scene), query);
      const grouped = new Map(view.rows.map(row => [row.id, []]));
      for (const m of mentions?.rows ?? []) {
        if (m.sceneId === scene.sceneId) grouped.get(m.sentenceId)?.push(m);
      }
      return { ...view, scene, rows: view.rows.map(row => ({ ...row, mentions: grouped.get(row.id) })) };
    }
    case 'characters': {
      const view = page(characters?.rows ?? [], query);
      return { ...view, rows: view.rows.map(row => ({
        ...row,
        evidence: row.evidence.map(e => ({ ...e, text: numbered.sentences[Number(e.sentenceId.slice(1)) - 1].text })),
      })) };
    }
    case 'mentions': return page(mentions?.rows ?? [], query, m => (!query.get('scene') || query.get('scene') === m.sceneId)
      && (!query.get('class') || query.get('class') === m.cls));
    default: throw new HttpError(404, '视图不存在');
  }
}

