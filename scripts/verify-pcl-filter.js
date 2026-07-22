import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = path.join(projectRoot, 'native', 'build', 'pcl_vertical_wall_filter');
const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'verify-pcl-wall-filter-'));

function buildSyntheticCloud() {
  const points = [];
  let groundPoints = 0;
  let wallPoints = 0;

  for (let xStep = -20; xStep <= 20; xStep += 1) {
    for (let yStep = -20; yStep <= 20; yStep += 1) {
      points.push(`${xStep / 10} ${yStep / 10} 0`);
      groundPoints += 1;
    }
  }
  for (let yStep = -20; yStep <= 20; yStep += 1) {
    for (let zStep = 1; zStep <= 20; zStep += 1) {
      points.push(`0 ${yStep / 10} ${zStep / 10}`);
      wallPoints += 1;
    }
  }

  const header = [
    '# synthetic ground and vertical wall',
    'VERSION 0.7',
    'FIELDS x y z',
    'SIZE 4 4 4',
    'TYPE F F F',
    'COUNT 1 1 1',
    `WIDTH ${points.length}`,
    'HEIGHT 1',
    'VIEWPOINT 0 0 0 1 0 0 0',
    `POINTS ${points.length}`,
    'DATA ascii',
  ];
  return { text: `${[...header, ...points].join('\n')}\n`, groundPoints, wallPoints };
}

try {
  const inputPath = path.join(temporaryDirectory, 'ground-and-wall.pcd');
  const outputPath = path.join(temporaryDirectory, 'filtered.pcd');
  const fixture = buildSyntheticCloud();
  await writeFile(inputPath, fixture.text);

  const { stdout } = await execFileAsync(executable, [inputPath, outputPath, '0.25', '20']);
  const statistics = JSON.parse(stdout.trim());
  if (statistics.removedPoints < fixture.wallPoints * 0.6) {
    throw new Error(`Too few wall points removed: ${JSON.stringify(statistics)}`);
  }
  if (statistics.outputPoints < fixture.groundPoints * 0.7) {
    throw new Error(`Too many ground points removed: ${JSON.stringify(statistics)}`);
  }

  console.log(JSON.stringify({
    ok: true,
    groundPoints: fixture.groundPoints,
    wallPoints: fixture.wallPoints,
    ...statistics,
  }, null, 2));
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
