import { mkdir, writeFile } from 'node:fs/promises';

const BASE = 'https://pubapps.bucknell.edu/CourseInformation';
const TERM = '202705';

async function get(path) {
  const response = await fetch(`${BASE}/${path}`);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${path}`);
  return response.json();
}

const [courses, seats] = await Promise.all([
  get(`data/course/term/${TERM}`),
  get(`data/banner/term/${TERM}/seats`)
]);

const normalized = courses.map(section => ({
  ...section,
  openSeats: seats[section.Id] ?? null,
  sourceTerm: TERM,
  sourceUrl: `${BASE}/#/lookup`
}));

await mkdir('data', { recursive: true });
await writeFile('data/spring-2027-sections.json', `${JSON.stringify(normalized, null, 2)}\n`);
console.log(`Saved ${normalized.length} Spring 2026-27 sections.`);
