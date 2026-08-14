import { execFile } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

function sendJson(response, statusCode, value) {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(value));
}

function getNumericParameter(url, name, fallback, minimum, maximum) {
  const raw = url.searchParams.get(name);
  const value = raw === null ? fallback : Number(raw);
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

async function findExecutable(projectRoot) {
  const candidates = [
    process.env.PCL_WALL_FILTER_BIN,
    path.join(projectRoot, 'native', 'build', 'pcl_vertical_wall_filter'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next configured location.
    }
  }
  return null;
}

export function createPclFilterMiddleware(projectRoot) {
  return async function pclFilterMiddleware(request, response, next) {
    const url = new URL(request.url || '/', 'http://localhost');
    if (url.pathname === '/api/pcl/status' && request.method === 'GET') {
      const executable = await findExecutable(projectRoot);
      sendJson(response, 200, {
        available: Boolean(executable),
        message: executable ? 'PCL wall filter is ready.' : 'Run npm run build:pcl first.',
      });
      return;
    }

    if (url.pathname !== '/api/pcl/filter-vertical-walls') {
      next();
      return;
    }
    if (request.method !== 'POST') {
      sendJson(response, 405, { error: 'Method not allowed.' });
      return;
    }

    const contentLength = Number(request.headers['content-length'] || 0);
    if (contentLength > MAX_UPLOAD_BYTES) {
      sendJson(response, 413, { error: 'Point-cloud file exceeds the 2 GiB upload limit.' });
      return;
    }

    let temporaryDirectory;
    try {
      const executable = await findExecutable(projectRoot);
      if (!executable) {
        sendJson(response, 503, { error: 'PCL filter is not built. Run npm run build:pcl first.' });
        return;
      }

      const radius = getNumericParameter(url, 'radius', 0.3, 0.01, 10);
      const angle = getNumericParameter(url, 'angle', 20, 0.1, 89);
      const requestedExtension = String(request.headers['x-point-cloud-extension'] || '.pcd').toLowerCase();
      const extension = requestedExtension === '.ply' ? '.ply' : '.pcd';
      temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'topology-pcl-filter-'));
      const inputPath = path.join(temporaryDirectory, `input${extension}`);
      const outputPath = path.join(temporaryDirectory, 'filtered.pcd');

      await pipeline(request, createWriteStream(inputPath));
      const { stdout } = await execFileAsync(
        executable,
        [inputPath, outputPath, String(radius), String(angle)],
        { maxBuffer: 1024 * 1024 },
      );
      const statistics = JSON.parse(stdout.trim());
      const outputStat = await stat(outputPath);

      response.statusCode = 200;
      response.setHeader('Content-Type', 'application/octet-stream');
      response.setHeader('Content-Length', outputStat.size);
      response.setHeader('X-PCL-Filter-Stats', JSON.stringify(statistics));
      await pipeline(createReadStream(outputPath), response);
    } catch (error) {
      if (!response.headersSent) {
        sendJson(response, 500, { error: error.stderr?.trim() || error.message || 'PCL filtering failed.' });
      } else {
        response.destroy(error);
      }
    } finally {
      if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
    }
  };
}

