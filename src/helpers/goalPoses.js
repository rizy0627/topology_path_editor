function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeOrientation(orientation = {}) {
  const x = finiteNumber(orientation.x) ?? 0;
  const y = finiteNumber(orientation.y) ?? 0;
  const z = finiteNumber(orientation.z) ?? 0;
  const w = finiteNumber(orientation.w) ?? 1;
  const length = Math.hypot(x, y, z, w);

  if (length < Number.EPSILON) return { x: 0, y: 0, z: 0, w: 1 };
  return {
    x: x / length,
    y: y / length,
    z: z / length,
    w: w / length,
  };
}

export function normalizeGoalPoses(raw) {
  if (!raw || (typeof raw !== 'object' && !Array.isArray(raw))) {
    throw new Error('Goal poses JSON must be an object or array.');
  }

  const entries = Array.isArray(raw)
    ? raw.map((pose, index) => [pose?.id ?? index, pose])
    : Object.entries(raw);

  const poses = entries.flatMap(([id, pose]) => {
    const position = pose?.position ?? pose?.pose?.position;
    const x = finiteNumber(position?.x);
    const y = finiteNumber(position?.y);
    const z = finiteNumber(position?.z);
    if (x === null || y === null || z === null) return [];

    return [{
      id: String(id),
      frameId: String(pose?.frame_id ?? pose?.header?.frame_id ?? 'map'),
      position: { x, y, z },
      orientation: normalizeOrientation(pose?.orientation ?? pose?.pose?.orientation),
    }];
  });

  if (!poses.length) {
    throw new Error('No valid goal poses found. Each pose needs numeric position.x, y, and z.');
  }

  return poses;
}

export async function loadGoalPosesJson(file) {
  let raw;
  try {
    raw = JSON.parse(await file.text());
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('Goal poses file is not valid JSON.');
    throw error;
  }

  return {
    name: file.name,
    poses: normalizeGoalPoses(raw),
  };
}
