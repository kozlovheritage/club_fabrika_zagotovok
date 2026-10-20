import {createHash} from 'node:crypto';
import {readPrivateIndex} from './private-store.mjs';
const normalize = text => String(text || '').toLowerCase().replace(/ё/g, 'е');
const words = text => normalize(text).match(/[a-zа-я0-9]+/g) || [];
export function stem(word) {
  if (/^куриц|^курин/.test(word)) return 'куриц';
  if (word.length < 4) return word;
  return word.replace(/(иями|ями|ами|ого|ему|ому|ыми|ими|ов|ев|ах|ях|ый|ий|ой|ая|яя|ое|ее|ые|ие|ую|юю|ом|ем|ам|ям|а|я|ы|и|у|ю|е|о|ь)$/g, '');
}
const stop = new Set(['в', 'и', 'с', 'к', 'из', 'на', 'по', 'для', 'о', 'а', 'со', 'во']);
const matches = (term, token) => token === term || (term.length >= 3 && token.startsWith(term));
function excerpt(text, terms) {
  const re = /[a-zа-яё0-9]+/gi;
  let hit, first = -1;
  while ((hit = re.exec(text))) if (terms.some(t => matches(t, stem(normalize(hit[0]))))) { first = hit.index; break; }
  const start = Math.max(0, first - 85);
  let snippet = text.slice(start, start + 340);
  if (start) snippet = '…' + snippet.replace(/^\S*\s/, '');
  if (start + 340 < text.length) snippet = snippet.replace(/\s\S*$/, '') + '…';
  return (snippet.match(/[a-zа-яё0-9]+|[^a-zа-яё0-9]+/gi) || []).map(text => ({
    text, match: /^[a-zа-яё0-9]+$/i.test(text) && terms.some(t => matches(t, stem(normalize(text))))
  }));
}
export function createPdfSearch(index, catalog, manifest) {
  if (index.schema !== 1 || index.catalogSha256 !== manifest.catalogSha256 ||
      !Array.isArray(index.documents) || index.documents.length !== catalog.size ||
      index.documents.length !== manifest.documents) throw Error('PDF_INDEX_CATALOG_MISMATCH');
  const documents = new Map(), pages = [], inverted = new Map();
  for (const doc of index.documents) {
    if (!catalog.has(doc.id) || documents.has(doc.id) || !Array.isArray(doc.pages) || !doc.pages.length ||
        doc.pages.length > 2000) throw Error('INVALID_INDEX_DOCUMENT');
    documents.set(doc.id, {id: doc.id, title: catalog.get(doc.id).name.replace(/\.pdf$/i, '')});
    for (const [i, page] of doc.pages.entries()) {
      if (page.number !== i + 1 || typeof page.text !== 'string' || page.text.length > 100_000)
        throw Error('INVALID_INDEX_PAGE');
      const row = {docId: doc.id, number: page.number, text: page.text, tokens: words(page.text).map(stem)};
      const pageId = pages.push(row) - 1;
      for (const token of new Set(row.tokens)) {
        if (!inverted.has(token)) inverted.set(token, new Set());
        inverted.get(token).add(pageId);
      }
    }
  }
  if (pages.length !== manifest.pages) throw Error('PDF_INDEX_PAGE_COUNT');
  const dictionary = [...inverted.keys()];
  return {
    search(query) {
      const terms = [...new Set(words(query).filter(w => !stop.has(w)).map(stem))].slice(0, 8);
      if (!terms.length) return [];
      let candidates;
      for (const term of terms) {
        const ids = new Set();
        for (const word of dictionary) if (matches(term, word)) for (const id of inverted.get(word)) ids.add(id);
        candidates = candidates ? new Set([...candidates].filter(id => ids.has(id))) : ids;
        if (!candidates.size) return [];
      }
      const grouped = new Map();
      for (const id of candidates) {
        const page = pages[id], doc = documents.get(page.docId);
        const score = page.tokens.reduce((n, word) => n + Number(terms.some(t => matches(t, word))), 0);
        const titleScore = words(doc.title).map(stem).filter(word => terms.some(t => matches(t, word))).length * 20;
        if (!grouped.has(doc.id)) grouped.set(doc.id, []);
        grouped.get(doc.id).push({page, score: score + titleScore});
      }
      return [...grouped.entries()].map(([id, hits]) => {
        hits.sort((a, b) => b.score - a.score || a.page.number - b.page.number);
        const best = hits[0], doc = documents.get(id);
        return {id: 'pdf-text-' + id, pdfId: id, title: doc.title, type: 'Текст PDF',
          section: 'Найдено внутри сборника', page: best.page.number,
          matchedPages: hits.map(h => h.page.number).sort((a, b) => a - b),
          fragments: excerpt(best.page.text, terms), score: best.score};
      }).sort((a, b) => b.score - a.score || a.title.localeCompare(b.title, 'ru'))
        .map(({score, ...result}) => result);
    }
  };
}

export function createSearchHandler({catalog, manifest, load = () => readPrivateIndex(manifest), now = Date.now}) {
  let cache, loading, failedUntil = 0;
  const limits = new Map();
  async function engine() {
    if (cache) return cache;
    if (now() < failedUntil) throw Error('INDEX_COOLDOWN');
    if (!loading) loading = Promise.resolve().then(load).then(index => {
      cache = createPdfSearch(index, catalog, manifest); return cache;
    }).catch(error => { failedUntil = now() + 30_000; throw error; })
      .finally(() => { loading = null; });
    return loading;
  }
  return async function search(req, res) {
    res.set({'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff'});
    if (!req.user) return res.status(401).json({message: 'Войдите в клуб'});
    if (typeof req.query.q !== 'string' || req.query.q.length > 120 || req.query.q.trim().length < 2)
      return res.status(400).json({message: 'Введите от 2 до 120 символов'});
    const key = req.user.user_key || req.user.email;
    const time = now(), limit = limits.get(key);
    if (limit && limit.until > time && limit.count >= 60)
      return res.status(429).set('Retry-After', '60').json({message: 'Слишком много запросов. Подождите минуту.'});
    if (!limit || limit.until <= time) limits.set(key, {count: 1, until: time + 60_000});
    else limit.count++;
    if (limits.size > 10000) for (const [id, value] of limits) if (value.until <= time) limits.delete(id);
    try {
      const index = await engine();
      return res.json({results: index.search(req.query.q), coverage: {documents: manifest.documents, pages: manifest.pages}});
    } catch {
      return res.status(503).json({message: 'Поиск по тексту PDF временно недоступен. Попробуйте позже.'});
    }
  };
}

export function assertCatalogManifest(catalogBytes, manifest) {
  if (createHash('sha256').update(catalogBytes).digest('hex') !== manifest.catalogSha256)
    throw Error('PDF_SEARCH_REINDEX_REQUIRED');
}
