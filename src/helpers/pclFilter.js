export async function filterVerticalWalls(file, options = {}) {
  const radius = Number(options.radius) || 0.3;
  const angle = Number(options.angle) || 20;
  const extension = file.name.toLowerCase().endsWith('.ply') ? '.ply' : '.pcd';
  const query = new URLSearchParams({
    radius: String(radius),
    angle: String(angle),
  });
  const response = await fetch(`/api/pcl/filter-vertical-walls?${query}`, {
    method: 'POST',
    headers: { 'X-Point-Cloud-Extension': extension },
    body: file,
  });

  if (!response.ok) {
    let errorMessage = `PCL filtering failed (${response.status}).`;
    try {
      const body = await response.json();
      if (body.error) errorMessage = body.error;
    } catch {
      // Keep the HTTP status message when the response is not JSON.
    }
    throw new Error(errorMessage);
  }

  let statistics = null;
  try {
    statistics = JSON.parse(response.headers.get('X-PCL-Filter-Stats') || 'null');
  } catch {
    // The filtered cloud remains usable if optional statistics are unavailable.
  }
  const blob = await response.blob();
  const baseName = file.name.replace(/\.[^.]+$/, '') || 'point_cloud';

  return {
    file: new File([blob], `${baseName}_no_walls.pcd`, { type: 'application/octet-stream' }),
    statistics,
  };
}
