/* Материал врача: тексты загружаются отдельно, чтобы страница клуба оставалась лёгкой. */
const hematologistTable = [
  {
    nutrient: 'ЖЕЛЕЗО',
    foods: '1. Говядина (стейк/тататар/запеченная)\n2. Печень говяжья (1 раз в нед.)\n3. Мидии/устрицы',
    helper: 'Витамин С:\nСалат из болгарского перца, сок грейпфрута, киви.',
    blocker: 'Чай и кофе (в течение 1 часа до и 1 часа после).\nМолоко (кальций блокирует).'
  },
  {
    nutrient: 'ЦИНК',
    foods: '1. Тыквенные семечки (сырые!)\n2. Говяжья печень\n3. Яйцо (желток)',
    helper: 'Лук и чеснок (содержат серу, улучшают усвоение).',
    blocker: 'Отруби и хлеб с цельным зерном (фитиновая кислота крадет цинк).'
  },
  {
    nutrient: 'ВИТАМИН В12',
    foods: '1. Говяжья печень\n2. Жирная рыба (скумбрия, сардины)\n3. Яйца',
    helper: 'Кислая среда (лимонный сок в рыбу).',
    blocker: 'Алкоголь (разрушает В12).'
  },
  {
    nutrient: 'ФОЛИЕВАЯ К-ТА (В9)',
    foods: '1. Зелень (шпинат, петрушка)\n2. Спаржа\n3. Бобовые (нут, фасоль)',
    helper: 'Термическая обработка (бланширование) разрушает антипитательные вещества.',
    blocker: 'Запись еды большим количеством воды (разбавляет ферменты).'
  },
  {
    nutrient: 'МЕДЬ',
    foods: '1. Гречка (зеленая)\n2. Орехи кешью\n3. Авокадо',
    helper: 'Кислые фрукты (апельсины).',
    blocker: 'Избыток цинка в добавках (он вытесняет медь).'
  }
];

function hematologistNode(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function appendHematologistText(target, lines) {
  if (!lines.length) return;
  const text = lines.join(' ').trim();
  if (!text) return;
  const heading = /^(?:\d+\.\s+[А-ЯЁA-Z]{2,}|🔹\s*ШАГ|[🟢🟡🔴]\s*ФЕРРИТИН|(?:🍽|🐟)?\s*(?:ЗАВТРАК|ОБЕД|ПОЛДНИК|УЖИН|КЛЮЧЕВЫЕ ПРАВИЛА ДНЯ))/u.test(text);
  const note = /^(?:ВАЖНО ЗАПОМНИТЬ|Эти симптомы — лишь подсказка|Совет от врача:)/iu.test(text);
  const subtitle = /^(?:Что чувствует ваше тело|Три закона питания при дефицитах|Почему так|Пять важных принципов|Наша общая задача)/iu.test(text) || (text.endsWith(':') && text.length < 110);
  target.append(hematologistNode(heading ? 'h4' : 'p', text, note ? 'hematologist-note' : subtitle ? 'hematologist-subtitle' : ''));
}

function appendHematologistBlock(target, block) {
  const lines = block.split('\n').map(line => line.trim()).filter(Boolean);
  let paragraph = [];
  let list = null;
  const flushParagraph = () => {
    appendHematologistText(target, paragraph);
    paragraph = [];
  };
  for (const line of lines) {
    if (/^[-•]\s/u.test(line)) {
      flushParagraph();
      if (!list) {
        list = hematologistNode('ul');
        target.append(list);
      }
      list.append(hematologistNode('li', line.replace(/^[-•]\s*/u, '')));
    } else {
      list = null;
      paragraph.push(line);
    }
  }
  flushParagraph();
}

function appendHematologistTable(target) {
  const wrapper = hematologistNode('div', undefined, 'hematologist-table-wrap');
  wrapper.setAttribute('role', 'region');
  wrapper.setAttribute('aria-label', 'Таблица продуктов при дефицитах');
  wrapper.tabIndex = 0;
  const table = hematologistNode('table', undefined, 'hematologist-table');
  const head = hematologistNode('thead');
  const headings = [
    'Если у вас дефицит...',
    'Ешьте ЭТО (ТОП-3)',
    'Добавьте к этому (усилитель)',
    'Уберите ЭТО из этого приема пищи (блокатор)'
  ];
  const headRow = hematologistNode('tr');
  for (const text of headings) {
    const th = hematologistNode('th', text);
    th.scope = 'col';
    headRow.append(th);
  }
  head.append(headRow);
  table.append(head);
  const body = hematologistNode('tbody');
  for (const item of hematologistTable) {
    const row = hematologistNode('tr');
    const th = hematologistNode('th', item.nutrient);
    th.scope = 'row';
    row.append(th);
    for (const value of [item.foods, item.helper, item.blocker]) row.append(hematologistNode('td', value));
    body.append(row);
  }
  table.append(body);
  wrapper.append(table);
  target.append(wrapper);
}

function renderHematologist(source) {
  const intro = document.getElementById('hematologistIntroBody');
  const sections = document.getElementById('hematologistSections');
  intro.replaceChildren();
  sections.replaceChildren();
  let target = intro;
  let section = 0;
  let block = [];
  const flush = () => {
    if (block.length && section !== 6) appendHematologistBlock(target, block.join('\n'));
    block = [];
  };

  for (const original of source.replace(/\r/g, '').split('\n')) {
    const line = original.trim();
    const match = line.match(/^БЛОК\s+([1-8])\.\s*(.+)$/iu);
    if (match) {
      flush();
      section = Number(match[1]);
      if (section === 1) {
        target = intro;
        continue;
      }
      const sectionNode = hematologistNode('section', undefined, 'hematologist-section');
      sectionNode.append(hematologistNode('h3', `Блок ${section - 1}. ${match[2]}`));
      sections.append(sectionNode);
      target = sectionNode;
      if (section === 6) appendHematologistTable(target);
      continue;
    }
    if (!section || (section === 1 && (
      line === 'Врач-гематолог' ||
      line === 'Кузнецова Дарья Михайловна' ||
      /^(?:АЗБУКА ПИТАНИЯ|Инстаграмм |Телеграм канал |Канал в Макс )/iu.test(line)
    ))) continue;
    if (!line) flush();
    else block.push(line);
  }
  flush();
}

async function loadHematologist() {
  const intro = document.getElementById('hematologistIntroBody');
  const sections = document.getElementById('hematologistSections');
  if (!intro || !sections || sections.dataset.loaded === 'true' || sections.dataset.loading === 'true') return;
  sections.dataset.loading = 'true';
  sections.replaceChildren(hematologistNode('p', 'Загрузка материала…'));
  const authenticated = location.pathname === '/club';
  try {
    const responses = await Promise.all([1, 2, 3].map(part =>
      fetch(authenticated ? `/api/hematologist/${part}.txt` : `./health/hematologist-${part}.txt`, {
        credentials: 'same-origin',
        cache: 'no-cache'
      })
    ));
    for (const response of responses) if (!response.ok) throw new Error(`HTTP ${response.status}`);
    renderHematologist((await Promise.all(responses.map(response => response.text()))).join('\n\n'));
    sections.dataset.loaded = 'true';
  } catch (error) {
    console.error('Не удалось загрузить материал гематолога', error);
    sections.replaceChildren(hematologistNode('p', 'Не удалось загрузить материал. Вернитесь в раздел «Для здоровья» и откройте его снова.'));
  } finally {
    delete sections.dataset.loading;
  }
}

window.loadHematologist = loadHematologist;